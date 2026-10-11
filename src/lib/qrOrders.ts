import { QrOrderStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { StockError } from "@/lib/stock";
import {
  validateModifierSelections,
  type ModifierSelectionInput,
  type ModifierSelectionLine,
} from "@/lib/modifiers";
import type { CartLine } from "@/lib/sales";
import { validateCartLines, validateTotalCents } from "@/lib/cartValidation";
import { lockQrOrder } from "@/lib/qrOrderLock";

/**
 * The QR self-order flow. A QrOrder is just a shareable, priced cart — no payment or
 * stock deduction happens here. A cashier claims it into the POS and finishes checkout
 * through the normal completeSale() path, which is where stock actually moves. See
 * schema.prisma's QrOrderStatus doc comment for why this is a separate model from Sale.
 */

export async function branchForOrderCode(code: string) {
  return prisma.branch.findFirst({ where: { code, type: "STORE" } });
}

export async function activeMenuForBranch(branchId: string) {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
  const [products, unavailable] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: branch.organizationId, active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        modifierGroups: {
          where: { modifierGroup: { active: true } },
          orderBy: { modifierGroup: { sortOrder: "asc" } },
          include: {
            modifierGroup: {
              include: { modifiers: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
            },
          },
        },
      },
    }),
    prisma.productAvailability.findMany({ where: { branchId, available: false }, select: { productId: true } }),
  ]);
  const unavailableIds = new Set(unavailable.map((u) => u.productId));
  return products.filter((p) => !unavailableIds.has(p.id));
}

async function uniquePickupCode(tx: Prisma.TransactionClient, branchId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(100 + Math.random() * 900)); // 3 digits, easy to call out
    const clash = await tx.qrOrder.findFirst({
      where: { branchId, code, OR: [{ status: QrOrderStatus.PENDING }, { status: QrOrderStatus.CLAIMED, checkoutTracked: true }] },
      select: { id: true },
    });
    if (!clash) return code;
  }
  throw new StockError("Couldn't generate a pickup code, try again");
}

export async function submitQrOrder(params: {
  branchId: string;
  customerName: string;
  note?: string;
  lines: CartLine[];
}) {
  const name = params.customerName.trim().slice(0, 80);
  if (!name) throw new StockError("Enter your name so staff can call your order");
  if (params.lines.length === 0) throw new StockError("Your cart is empty");
  validateCartLines(params.lines);

  const branch = await prisma.branch.findUnique({ where: { id: params.branchId } });
  if (!branch || branch.type !== "STORE") throw new StockError("Branch not found");

  return prisma.$transaction(async (tx) => {
    const productIds = params.lines.map((l) => l.productId);
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, organizationId: branch.organizationId, active: true },
      include: {
        modifierGroups: { include: { modifierGroup: { include: { modifiers: true } } } },
      },
    });
    if (products.length !== new Set(productIds).size) {
      throw new StockError("One or more items are no longer available");
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const unavailable = await tx.productAvailability.findMany({
      where: { branchId: params.branchId, productId: { in: productIds }, available: false },
      select: { productId: true },
    });
    if (unavailable.length) {
      const names = unavailable.map((u) => productMap.get(u.productId)!.name);
      throw new StockError(`Sold out right now: ${names.join(", ")}`);
    }

    let totalCents = 0;
    const lineData: {
      productId: string;
      quantity: number;
      unitCents: number;
      totalCents: number;
      modifiers: ModifierSelectionLine[];
    }[] = [];

    for (const line of params.lines) {
      if (line.quantity <= 0) throw new StockError("Invalid item quantity");
      const product = productMap.get(line.productId)!;
      const { priceCents: modifierUnitCents, lines: modifierLines } = validateModifierSelections(
        product.modifierGroups.map((link) => link.modifierGroup),
        line.modifiers ?? [],
        product.name,
      );
      const unitCents = product.priceCents + modifierUnitCents;
      const lineTotal = unitCents * line.quantity;
      totalCents += lineTotal;
      lineData.push({ productId: product.id, quantity: line.quantity, unitCents, totalCents: lineTotal, modifiers: modifierLines });
    }

    validateTotalCents(totalCents);
    // Serialize code allocation within a branch, including orders being checked out.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`qr-code:${params.branchId}`}))`;
    const code = await uniquePickupCode(tx, params.branchId);

    const order = await tx.qrOrder.create({
      data: {
        branchId: params.branchId,
        code,
        customerName: name,
        totalCents,
        note: params.note?.trim().slice(0, 300) || null,
        lines: {
          create: lineData.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitCents: l.unitCents,
            totalCents: l.totalCents,
            modifiers: l.modifiers.length
              ? (l.modifiers.map((m) => ({ modifierId: m.modifierId, quantity: m.quantity })) as Prisma.InputJsonValue)
              : undefined,
          })),
        },
      },
    });

    return { id: order.id, code: order.code, totalCents: order.totalCents };
  });
}

export async function listPendingQrOrders(branchId: string) {
  const orders = await prisma.qrOrder.findMany({
    where: { branchId, OR: [{ status: QrOrderStatus.PENDING }, { status: QrOrderStatus.CLAIMED, checkoutTracked: true }] },
    orderBy: { createdAt: "asc" },
    include: { claimedBy: { select: { name: true } }, lines: { include: { product: { select: { name: true } } } } },
  });
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    claimedById: o.claimedById,
    claimedByName: o.claimedBy?.name ?? null,
    code: o.code,
    customerName: o.customerName,
    totalCents: o.totalCents,
    note: o.note,
    createdAt: o.createdAt.toISOString(),
    lines: o.lines.map((l) => ({
      productId: l.productId,
      productName: l.product.name,
      quantity: l.quantity,
      unitCents: l.unitCents,
      modifiers: (l.modifiers as ModifierSelectionInput[] | null) ?? [],
    })),
  }));
}

/** Marks the order CLAIMED and hands back cart-shaped lines for the POS to load. Throws if
 * it's already been claimed or cancelled (e.g. two cashiers tapping it at once), or if it
 * belongs to a different branch — checked inside the same transaction as the update, so a
 * rejected claim never leaves the order stuck CLAIMED. */
export async function claimQrOrder(qrOrderId: string, userId: string, expectedBranchId: string) {
  return prisma.$transaction(async (tx) => {
    await lockQrOrder(tx, qrOrderId);
    const order = await tx.qrOrder.findUnique({ where: { id: qrOrderId }, include: { lines: true } });
    if (!order) throw new StockError("Order not found");
    if (order.branchId !== expectedBranchId) throw new StockError("That order belongs to a different branch");
    const resuming = order.status === QrOrderStatus.CLAIMED && order.checkoutTracked && order.claimedById === userId;
    if (order.status !== QrOrderStatus.PENDING && !resuming) throw new StockError("This order was already claimed, completed or cancelled");

    const products = await tx.product.findMany({
      where: { id: { in: order.lines.map(line => line.productId) }, active: true },
      include: { modifierGroups: { include: { modifierGroup: { include: { modifiers: true } } } } },
    });
    for (const line of order.lines) {
      const product = products.find(item => item.id === line.productId);
      if (!product) throw new StockError("An item is no longer on the menu. Cancel this order and ask the customer to reorder.");
      validateModifierSelections(product.modifierGroups.map(link => link.modifierGroup), (line.modifiers as ModifierSelectionInput[] | null) ?? [], product.name);
    }

    await tx.qrOrder.update({
      where: { id: qrOrderId },
      data: { status: QrOrderStatus.CLAIMED, claimedAt: order.claimedAt ?? new Date(), claimedById: userId, checkoutTracked: true },
    });

    const cartLines: CartLine[] = order.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      modifiers: (l.modifiers as ModifierSelectionInput[] | null) ?? undefined,
    }));
    return { id: order.id, note: order.note, branchId: order.branchId, customerName: order.customerName, code: order.code, cartLines };
  });
}

export async function cancelQrOrder(qrOrderId: string, expectedBranchId: string) {
  return prisma.$transaction(async tx => {
    await lockQrOrder(tx, qrOrderId);
    const order = await tx.qrOrder.findUnique({ where: { id: qrOrderId } });
    if (!order) throw new StockError("Order not found");
    if (order.branchId !== expectedBranchId) throw new StockError("That order belongs to a different branch");
    if (order.status !== QrOrderStatus.PENDING) throw new StockError("This order was already claimed, completed or cancelled");
    await tx.qrOrder.update({ where: { id: qrOrderId }, data: { status: QrOrderStatus.CANCELLED, cancelledAt: new Date() } });
  });
}

export async function releaseQrOrder(qrOrderId: string, userId: string, expectedBranchId: string, canManage = false) {
  return prisma.$transaction(async tx => {
    await lockQrOrder(tx, qrOrderId);
    const order = await tx.qrOrder.findUnique({ where: { id: qrOrderId } });
    if (!order || order.branchId !== expectedBranchId) throw new StockError("Order not found at this branch");
    if (order.status !== QrOrderStatus.CLAIMED || !order.checkoutTracked) throw new StockError("This order is no longer in checkout");
    if (order.claimedById !== userId && !canManage) throw new StockError("Only the cashier handling this order or a manager can return it to the queue");
    await tx.qrOrder.update({ where: { id: qrOrderId }, data: { status: QrOrderStatus.PENDING, claimedAt: null, claimedById: null } });
  });
}
