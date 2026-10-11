import {
  MovementType,
  PaymentMethod,
  SalesChannel,
  SaleStatus,
  IntegrationEventSeverity,
  IntegrationEventType,
  type Prisma,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, StockError } from "@/lib/stock";
import { aggregateTheoreticalConsumption, recipeLineApplies } from "@/lib/recipes";
import {
  aggregateModifierConsumption,
  selectedSweetness,
  validateModifierSelections,
  type ModifierSelectionInput,
  type ModifierSelectionLine,
} from "@/lib/modifiers";
import { queueIntegrationEvent } from "@/lib/integrationEvents";
import { lockQrOrder } from "@/lib/qrOrderLock";
import { validateCartLines, validateTotalCents } from "@/lib/cartValidation";

export type CartLine = {
  productId: string;
  quantity: number;
  modifiers?: ModifierSelectionInput[];
};

export async function completeSale(params: {
  branchId: string;
  cashierId: string;
  organizationId: string;
  paymentMethod: PaymentMethod;
  /** Defaults to WALK_IN. Platform channels must be paid with PLATFORM, walk-in with CASH/CARD. */
  channel?: SalesChannel;
  /** The platform's own order number, for matching payouts. */
  externalRef?: string;
  lines: CartLine[];
  allowNegativeStock?: boolean;
  note?: string;
  qrOrderId?: string;
}) {
  if (params.lines.length === 0) {
    throw new StockError("Cart is empty");
  }
  validateCartLines(params.lines);
  const channel = params.channel ?? SalesChannel.WALK_IN;
  const isPlatform = channel !== SalesChannel.WALK_IN;
  if (isPlatform && params.paymentMethod !== PaymentMethod.PLATFORM) {
    throw new StockError("Delivery-platform orders are paid through the platform");
  }
  if (!isPlatform && params.paymentMethod === PaymentMethod.PLATFORM) {
    throw new StockError("Walk-in orders must be paid by cash or card");
  }
  const externalRef = isPlatform ? params.externalRef?.trim().slice(0, 60) || null : null;

  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, organizationId: params.organizationId },
  });
  if (!branch) throw new StockError("Branch not found");
  if (branch.type === "WAREHOUSE") {
    throw new StockError("Cannot record a sale at a warehouse branch");
  }

  return prisma.$transaction(async (tx) => {
    let qrNote: string | null = null;
    if (params.qrOrderId) {
      await lockQrOrder(tx, params.qrOrderId);
      const order = await tx.qrOrder.findUnique({ where: { id: params.qrOrderId } });
      if (!order || order.branchId !== params.branchId || order.claimedById !== params.cashierId) {
        throw new StockError("Claim this QR order at the current branch before checkout");
      }
      if (order.status === "COMPLETED" && order.saleId) {
        // A response can be lost after commit. Retrying must not charge/deduct twice.
        return tx.sale.findUniqueOrThrow({ where: { id: order.saleId }, include: { lines: true } });
      }
      if (order.status !== "CLAIMED" || !order.checkoutTracked) throw new StockError("This QR order is no longer in checkout");
      if (channel !== SalesChannel.WALK_IN) throw new StockError("QR orders must use walk-in checkout");
      qrNote = `QR ${order.code} · ${order.customerName}${order.note ? ` — ${order.note}` : ""}`;
    }
    const productIds = params.lines.map((l) => l.productId);
    const products = await tx.product.findMany({
      where: {
        id: { in: productIds },
        organizationId: params.organizationId,
        active: true,
      },
      include: {
        recipeLines: { where: { isActive: true } },
        channelPrices: isPlatform ? { where: { channel } } : false,
        modifierGroups: {
          include: { modifierGroup: { include: { modifiers: true } } },
        },
      },
    });

    if (products.length !== new Set(productIds).size) {
      throw new StockError("One or more products are invalid or inactive");
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    const unavailable = await tx.productAvailability.findMany({
      where: { branchId: params.branchId, productId: { in: productIds }, available: false },
      select: { productId: true },
    });
    if (unavailable.length) {
      const names = unavailable.map((u) => productMap.get(u.productId)!.name);
      throw new StockError(`Unavailable at this branch: ${names.join(", ")}`);
    }

    const missingRecipeProducts = products.filter((product) => product.recipeLines.length === 0);
    let totalCents = 0;
    const saleLinesData: Prisma.SaleLineCreateManySaleInput[] = [];
    const modifierSelectionsByLine: ModifierSelectionLine[][] = [];
    const sweetnessByLine: (number | null)[] = [];

    for (const line of params.lines) {
      if (line.quantity <= 0) throw new StockError("Invalid line quantity");
      const product = productMap.get(line.productId)!;
      const { priceCents: modifierUnitCents, lines: modifierLines } = validateModifierSelections(
        product.modifierGroups.map((link) => link.modifierGroup),
        line.modifiers ?? [],
        product.name,
      );
      const basePriceCents = product.channelPrices?.[0]?.priceCents ?? product.priceCents;
      const unitCents = basePriceCents + modifierUnitCents;
      const lineTotal = unitCents * line.quantity;
      totalCents += lineTotal;
      const sweetness = selectedSweetness(modifierLines);
      modifierSelectionsByLine.push(modifierLines);
      sweetnessByLine.push(sweetness);
      saleLinesData.push({
        productId: product.id,
        quantity: line.quantity,
        unitCents,
        totalCents: lineTotal,
        recipeVersion: product.recipeLines[0]?.version ?? null,
        sweetnessPercent: sweetness,
      });
    }

    validateTotalCents(totalCents);
    const needs = aggregateTheoreticalConsumption(
      params.lines.map((line, i) => ({
        recipeLines: productMap.get(line.productId)!.recipeLines,
        quantitySold: line.quantity,
        sweetnessPercent: sweetnessByLine[i],
      })),
    );
    const modifierNeeds = aggregateModifierConsumption(
      params.lines.map((line, i) => ({
        modifiers: modifierSelectionsByLine[i],
        quantitySold: line.quantity,
      })),
    );
    for (const [ingredientId, qty] of modifierNeeds) {
      needs.set(ingredientId, (needs.get(ingredientId) ?? new Decimal(0)).plus(qty));
    }

    const sale = await tx.sale.create({
      data: {
        branchId: params.branchId,
        cashierId: params.cashierId,
        paymentMethod: params.paymentMethod,
        channel,
        externalRef,
        totalCents,
        note: qrNote ?? params.note,
        lines: {
          create: saleLinesData.map((lineData, i) => ({
            ...lineData,
            modifiers: modifierSelectionsByLine[i].length
              ? {
                  create: modifierSelectionsByLine[i].map((m) => ({
                    modifierId: m.modifierId,
                    name: m.name,
                    priceCents: m.priceCents,
                    quantity: m.quantity,
                    ingredientId: m.ingredientId,
                    ingredientQty: m.ingredientQty,
                  })),
                }
              : undefined,
          })),
        },
      },
      include: { lines: true },
    });

    const negativeStock: { ingredientId: string; quantity: string }[] = [];
    for (const [ingredientId, qty] of needs) {
      const result = await applyMovement(
        {
          branchId: params.branchId,
          ingredientId,
          delta: qty.neg(),
          type: MovementType.SALE,
          refType: "sale",
          refId: sale.id,
          createdById: params.cashierId,
          allowNegative: params.allowNegativeStock ?? false,
        },
        tx,
      );
      if (new Decimal(result.stockItem.quantity).isNegative()) {
        negativeStock.push({
          ingredientId,
          quantity: result.stockItem.quantity.toString(),
        });
      }
    }

    if (missingRecipeProducts.length) {
      await queueIntegrationEvent(tx, {
        organizationId: params.organizationId,
        branchId: params.branchId,
        type: IntegrationEventType.MISSING_RECIPE,
        severity: IntegrationEventSeverity.WARNING,
        dedupeKey: `sale:${sale.id}:missing-recipe`,
        payload: {
          saleId: sale.id,
          products: missingRecipeProducts.map((product) => ({ id: product.id, name: product.name })),
          salePath: "/pos",
        },
      });
    }

    if (params.allowNegativeStock && negativeStock.length) {
      await queueIntegrationEvent(tx, {
        organizationId: params.organizationId,
        branchId: params.branchId,
        type: IntegrationEventType.NEGATIVE_STOCK_OVERRIDE,
        severity: IntegrationEventSeverity.CRITICAL,
        dedupeKey: `sale:${sale.id}:negative-stock-override`,
        payload: {
          saleId: sale.id,
          ingredients: negativeStock,
          salePath: "/pos",
        },
      });
    }

    if (params.qrOrderId) {
      await tx.qrOrder.update({ where: { id: params.qrOrderId }, data: { status: "COMPLETED", saleId: sale.id, completedAt: new Date() } });
    }
    return sale;
  });
}

export async function voidSale(params: {
  saleId: string;
  organizationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${params.saleId} FOR UPDATE`;
    const sale = await tx.sale.findFirst({
      where: {
        id: params.saleId,
        branch: { organizationId: params.organizationId },
      },
      include: { lines: { include: { modifiers: true } } },
    });

    if (!sale) throw new StockError("Sale not found");
    if (sale.status === SaleStatus.VOIDED) throw new StockError("Sale already voided");

    // Restore stock using the exact recipe version that was in effect when each
    // line was sold (snapshotted on SaleLine.recipeVersion), not the product's
    // current recipe — the recipe may have been edited since this sale happened.
    // Pre-versioning sales have recipeVersion=null; every recipe was implicitly
    // "version 1" before this feature existed, so null falls back to 1.
    const productIds = [...new Set(sale.lines.map((l) => l.productId))];
    const recipeLines = await tx.recipeLine.findMany({
      where: { productId: { in: productIds } },
    });
    const byVersionKey = new Map<string, typeof recipeLines>();
    for (const rl of recipeLines) {
      const key = `${rl.productId}:${rl.version}`;
      const arr = byVersionKey.get(key) ?? [];
      arr.push(rl);
      byVersionKey.set(key, arr);
    }

    const restores = new Map<string, Decimal>();
    for (const line of sale.lines) {
      const version = line.recipeVersion ?? 1;
      const lines = byVersionKey.get(`${line.productId}:${version}`) ?? [];
      for (const recipe of lines) {
        if (!recipeLineApplies(recipe, line.sweetnessPercent)) continue;
        const add = new Decimal(recipe.quantity).mul(line.quantity);
        const prev = restores.get(recipe.ingredientId) ?? new Decimal(0);
        restores.set(recipe.ingredientId, prev.plus(add));
      }
      for (const modifier of line.modifiers) {
        if (!modifier.ingredientId || !modifier.ingredientQty) continue;
        const add = new Decimal(modifier.ingredientQty).mul(modifier.quantity).mul(line.quantity);
        const prev = restores.get(modifier.ingredientId) ?? new Decimal(0);
        restores.set(modifier.ingredientId, prev.plus(add));
      }
    }

    for (const [ingredientId, qty] of restores) {
      await applyMovement(
        {
          branchId: sale.branchId,
          ingredientId,
          delta: qty,
          type: MovementType.SALE_VOID,
          refType: "sale",
          refId: sale.id,
          createdById: params.userId,
          allowNegative: true,
        },
        tx,
      );
    }

    return tx.sale.update({
      where: { id: sale.id },
      data: { status: SaleStatus.VOIDED, voidedAt: new Date() },
    });
  });
}
