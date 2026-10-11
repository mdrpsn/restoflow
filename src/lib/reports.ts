import { MovementType, SaleStatus, SalesChannel } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { computeRecipeCostCents, computeFoodCostPercent, referenceSweetness } from "@/lib/costing";

export type DateRange = { since: Date; until?: Date };

function inRange(range: DateRange) {
  return { gte: range.since, ...(range.until ? { lte: range.until } : {}) };
}

export async function getSalesByDay(branchIds: string[], range: DateRange) {
  const sales = await prisma.sale.findMany({
    where: {
      branchId: { in: branchIds },
      status: SaleStatus.COMPLETED,
      createdAt: inRange(range),
    },
    select: { createdAt: true, totalCents: true },
    orderBy: { createdAt: "asc" },
  });

  const byDay = new Map<string, { cents: number; count: number }>();
  for (const s of sales) {
    const key = s.createdAt.toISOString().slice(0, 10);
    const prev = byDay.get(key) || { cents: 0, count: 0 };
    prev.cents += s.totalCents;
    prev.count += 1;
    byDay.set(key, prev);
  }
  return [...byDay.entries()].map(([day, v]) => ({ day, ...v }));
}

export async function getSalesByBranch(branchIds: string[], range: DateRange) {
  const sales = await prisma.sale.findMany({
    where: {
      branchId: { in: branchIds },
      status: SaleStatus.COMPLETED,
      createdAt: inRange(range),
    },
    include: { branch: true },
  });

  const byBranch = new Map<
    string,
    { branchId: string; branchName: string; branchCode: string; cents: number; count: number }
  >();
  for (const s of sales) {
    const prev = byBranch.get(s.branchId) || {
      branchId: s.branchId,
      branchName: s.branch.name,
      branchCode: s.branch.code,
      cents: 0,
      count: 0,
    };
    prev.cents += s.totalCents;
    prev.count += 1;
    byBranch.set(s.branchId, prev);
  }
  return [...byBranch.values()]
    .map((b) => ({ ...b, avgTicketCents: b.count ? Math.round(b.cents / b.count) : 0 }))
    .sort((a, b) => b.cents - a.cents);
}

export async function getTopProducts(branchIds: string[], range: DateRange, limit = 10) {
  const lines = await prisma.saleLine.findMany({
    where: {
      sale: { branchId: { in: branchIds }, status: SaleStatus.COMPLETED, createdAt: inRange(range) },
    },
    include: { product: true },
  });

  const totals = new Map<string, { name: string; qty: number; cents: number }>();
  for (const line of lines) {
    const prev = totals.get(line.productId) || { name: line.product.name, qty: 0, cents: 0 };
    prev.qty += line.quantity;
    prev.cents += line.totalCents;
    totals.set(line.productId, prev);
  }
  return [...totals.values()].sort((a, b) => b.cents - a.cents).slice(0, limit);
}

export async function getSalesByCategory(branchIds: string[], range: DateRange) {
  const lines = await prisma.saleLine.findMany({
    where: {
      sale: { branchId: { in: branchIds }, status: SaleStatus.COMPLETED, createdAt: inRange(range) },
    },
    include: { product: true },
  });

  const totals = new Map<string, { category: string; qty: number; cents: number }>();
  for (const line of lines) {
    const category = line.product.category || "Uncategorized";
    const prev = totals.get(category) || { category, qty: 0, cents: 0 };
    prev.qty += line.quantity;
    prev.cents += line.totalCents;
    totals.set(category, prev);
  }
  return [...totals.values()].sort((a, b) => b.cents - a.cents);
}

export async function getStockMovementLedger(params: {
  branchIds: string[];
  ingredientId?: string;
  type?: MovementType;
  range: DateRange;
  limit?: number;
}) {
  return prisma.stockMovement.findMany({
    where: {
      branchId: { in: params.branchIds },
      ingredientId: params.ingredientId || undefined,
      type: params.type || undefined,
      createdAt: inRange(params.range),
    },
    include: { ingredient: true, branch: true, createdBy: true },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 100,
  });
}

/** Theoretical ingredient consumption = what the recipes say sales should have used. */
export async function getIngredientConsumption(branchIds: string[], range: DateRange) {
  const movements = await prisma.stockMovement.findMany({
    where: {
      branchId: { in: branchIds },
      type: { in: [MovementType.SALE, MovementType.SALE_VOID] },
      createdAt: inRange(range),
    },
    include: { ingredient: true },
  });

  // SALE_VOID movements exactly reverse their corresponding SALE (same
  // recipe-version-aware math — see voidSale in sales.ts), so netting them
  // together here cancels a voided sale's consumption back to zero instead
  // of leaving it permanently counted as "theoretical use" for a sale that
  // was voided before the food was ever actually made.
  const byIngredient = new Map<string, { ingredientId: string; name: string; unit: string; consumedQty: Decimal }>();
  for (const m of movements) {
    const prev = byIngredient.get(m.ingredientId) ?? {
      ingredientId: m.ingredientId,
      name: m.ingredient.name,
      unit: m.ingredient.unit,
      consumedQty: new Decimal(0),
    };
    // SALE deltas are negative (consumption), SALE_VOID deltas are positive
    // (restoration) — negating both and summing nets a void back to zero.
    prev.consumedQty = prev.consumedQty.plus(new Decimal(m.quantity).neg());
    byIngredient.set(m.ingredientId, prev);
  }
  return [...byIngredient.values()]
    .map((r) => ({ ...r, consumedQty: r.consumedQty.toString() }))
    .sort((a, b) => Number(b.consumedQty) - Number(a.consumedQty));
}

/**
 * Actual vs. theoretical usage. Theoretical consumption comes from SALE
 * movements net of SALE_VOID (recipe-driven, with voided sales correctly
 * cancelled out rather than left permanently counted). Variance is what
 * ADJUSTMENT (physical-count corrections) and WASTE movements show happened
 * beyond that — built entirely from ledger data that already exists, not a
 * separate estimate.
 */
export async function getVarianceReport(branchIds: string[], range: DateRange) {
  const movements = await prisma.stockMovement.findMany({
    where: {
      branchId: { in: branchIds },
      type: { in: [MovementType.SALE, MovementType.SALE_VOID, MovementType.ADJUSTMENT, MovementType.WASTE] },
      createdAt: inRange(range),
    },
    include: { ingredient: true },
  });

  const byIngredient = new Map<
    string,
    {
      ingredientId: string;
      name: string;
      unit: string;
      theoreticalConsumption: Decimal;
      wasteQty: Decimal;
      adjustmentNet: Decimal;
    }
  >();
  for (const m of movements) {
    const prev = byIngredient.get(m.ingredientId) ?? {
      ingredientId: m.ingredientId,
      name: m.ingredient.name,
      unit: m.ingredient.unit,
      theoreticalConsumption: new Decimal(0),
      wasteQty: new Decimal(0),
      adjustmentNet: new Decimal(0),
    };
    const qty = new Decimal(m.quantity);
    if (m.type === MovementType.SALE || m.type === MovementType.SALE_VOID) {
      prev.theoreticalConsumption = prev.theoreticalConsumption.plus(qty.neg());
    }
    if (m.type === MovementType.WASTE) prev.wasteQty = prev.wasteQty.plus(qty.neg());
    if (m.type === MovementType.ADJUSTMENT) prev.adjustmentNet = prev.adjustmentNet.plus(qty);
    byIngredient.set(m.ingredientId, prev);
  }

  return [...byIngredient.values()].map((r) => ({
    ingredientId: r.ingredientId,
    name: r.name,
    unit: r.unit,
    theoreticalConsumption: r.theoreticalConsumption.toString(),
    wasteQty: r.wasteQty.toString(),
    adjustmentNet: r.adjustmentNet.toString(),
  }));
}

/** Food cost % = theoretical cost of ingredients sold, over revenue, for the period. */
export async function getFoodCostSummary(
  organizationId: string,
  branchIds: string[],
  range: DateRange,
) {
  const [sales, saleLines, ingredients] = await Promise.all([
    prisma.sale.findMany({
      where: { branchId: { in: branchIds }, status: SaleStatus.COMPLETED, createdAt: inRange(range) },
      select: { totalCents: true },
    }),
    prisma.saleLine.findMany({
      where: {
        sale: { branchId: { in: branchIds }, status: SaleStatus.COMPLETED, createdAt: inRange(range) },
      },
      select: { productId: true, quantity: true, recipeVersion: true, sweetnessPercent: true },
    }),
    prisma.ingredient.findMany({ where: { organizationId }, select: { id: true, costCentsPerUnit: true } }),
  ]);

  const revenueCents = sales.reduce((s, x) => s + x.totalCents, 0);
  const ingredientCostMap = new Map(ingredients.map((i) => [i.id, i.costCentsPerUnit]));

  const productIds = [...new Set(saleLines.map((l) => l.productId))];
  const recipeLines = await prisma.recipeLine.findMany({
    where: { productId: { in: productIds } },
  });
  const recipesByVersion = new Map<string, typeof recipeLines>();
  for (const rl of recipeLines) {
    const key = `${rl.productId}:${rl.version}`;
    const arr = recipesByVersion.get(key) ?? [];
    arr.push(rl);
    recipesByVersion.set(key, arr);
  }

  let cogsCents = 0;
  for (const line of saleLines) {
    const version = line.recipeVersion ?? 1;
    const lines = recipesByVersion.get(`${line.productId}:${version}`) ?? [];
    cogsCents += computeRecipeCostCents(lines, ingredientCostMap, line.sweetnessPercent) * line.quantity;
  }

  return {
    revenueCents,
    cogsCents,
    foodCostPercent: computeFoodCostPercent(cogsCents, revenueCents),
  };
}

/** Walk-in/takeout vs. FoodPanda vs. GrabFood, for the "which channel actually sells" question. */
export async function getSalesByChannel(branchIds: string[], range: DateRange) {
  const sales = await prisma.sale.findMany({
    where: {
      branchId: { in: branchIds },
      status: SaleStatus.COMPLETED,
      createdAt: inRange(range),
    },
    select: { channel: true, totalCents: true },
  });

  const byChannel = new Map<string, { channel: string; cents: number; count: number }>();
  for (const s of sales) {
    const prev = byChannel.get(s.channel) || { channel: s.channel, cents: 0, count: 0 };
    prev.cents += s.totalCents;
    prev.count += 1;
    byChannel.set(s.channel, prev);
  }
  return [...byChannel.values()]
    .map((c) => ({ ...c, avgTicketCents: c.count ? Math.round(c.cents / c.count) : 0 }))
    .sort((a, b) => b.cents - a.cents);
}

/** Per-cashier breakdown, split by channel, for the cashier's shift/end-of-day report. */
export async function getSalesByCashier(branchIds: string[], range: DateRange) {
  const sales = await prisma.sale.findMany({
    where: {
      branchId: { in: branchIds },
      status: SaleStatus.COMPLETED,
      createdAt: inRange(range),
    },
    include: { cashier: true },
  });

  const byCashier = new Map<
    string,
    {
      cashierId: string;
      cashierName: string;
      cents: number;
      count: number;
      channels: Map<string, { cents: number; count: number }>;
    }
  >();
  for (const s of sales) {
    const prev = byCashier.get(s.cashierId) || {
      cashierId: s.cashierId,
      cashierName: s.cashier.name,
      cents: 0,
      count: 0,
      channels: new Map<string, { cents: number; count: number }>(),
    };
    prev.cents += s.totalCents;
    prev.count += 1;
    const chan = prev.channels.get(s.channel) || { cents: 0, count: 0 };
    chan.cents += s.totalCents;
    chan.count += 1;
    prev.channels.set(s.channel, chan);
    byCashier.set(s.cashierId, prev);
  }

  return [...byCashier.values()]
    .map((c) => ({
      cashierId: c.cashierId,
      cashierName: c.cashierName,
      cents: c.cents,
      count: c.count,
      channels: [...c.channels.entries()].map(([channel, v]) => ({ channel, ...v })),
    }))
    .sort((a, b) => b.cents - a.cents);
}

const OUTLIER_HIGH_PERCENT = 45;
const OUTLIER_LOW_PERCENT = 5;

/**
 * Catalog-wide recipe/cost audit, independent of any date range or branch: is every active
 * product sellable at the right cost right now. Surfaces the three ways this silently goes
 * wrong — a product with no recipe at all (blocked from sale for non-managers, see
 * completeSale), a recipe that leans on an ingredient with no cost entered (quietly costs
 * ₱0 in every food-cost report), and a recipe whose food-cost % is implausible (usually a
 * wrong quantity or unit, like the Oreo-Cookies-priced-per-box case).
 */
export async function getRecipeHealth(organizationId: string) {
  const [products, ingredients] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId, active: true },
      include: { recipeLines: { where: { isActive: true }, include: { ingredient: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.ingredient.findMany({ where: { organizationId } }),
  ]);
  const ingredientCostMap = new Map(ingredients.map((i) => [i.id, i.costCentsPerUnit]));

  const missingRecipes = products
    .filter((p) => p.recipeLines.length === 0)
    .map((p) => ({ id: p.id, name: p.name, category: p.category, sku: p.sku }));

  const zeroCostUsage = new Map<string, { ingredientId: string; name: string; unit: string; productNames: Set<string> }>();
  const outliers: { id: string; name: string; sku: string | null; priceCents: number; costCents: number; foodCostPercent: number; direction: "high" | "low" }[] = [];

  for (const product of products) {
    if (product.recipeLines.length === 0) continue;
    for (const line of product.recipeLines) {
      if (line.ingredient.costCentsPerUnit !== 0) continue;
      const prev = zeroCostUsage.get(line.ingredientId) ?? {
        ingredientId: line.ingredientId,
        name: line.ingredient.name,
        unit: line.ingredient.unit,
        productNames: new Set<string>(),
      };
      prev.productNames.add(product.name);
      zeroCostUsage.set(line.ingredientId, prev);
    }

    const costCents = computeRecipeCostCents(product.recipeLines, ingredientCostMap, referenceSweetness(product.recipeLines));
    const foodCostPercent = computeFoodCostPercent(costCents, product.priceCents);
    if (foodCostPercent === null) continue;
    if (foodCostPercent > OUTLIER_HIGH_PERCENT) {
      outliers.push({ id: product.id, name: product.name, sku: product.sku, priceCents: product.priceCents, costCents, foodCostPercent, direction: "high" });
    } else if (foodCostPercent < OUTLIER_LOW_PERCENT) {
      outliers.push({ id: product.id, name: product.name, sku: product.sku, priceCents: product.priceCents, costCents, foodCostPercent, direction: "low" });
    }
  }

  const mappedCount = products.length - missingRecipes.length;
  return {
    totalActiveProducts: products.length,
    mappedCount,
    coveragePercent: products.length ? (mappedCount / products.length) * 100 : 100,
    missingRecipes,
    zeroCostIngredients: [...zeroCostUsage.values()]
      .map((z) => ({ ingredientId: z.ingredientId, name: z.name, unit: z.unit, productNames: [...z.productNames].sort() }))
      .sort((a, b) => b.productNames.length - a.productNames.length),
    outliers: outliers.sort((a, b) => b.foodCostPercent - a.foodCostPercent),
  };
}

/**
 * First POS login per staff member per day, from the LoginEvent audit table (see
 * lib/auth.ts — the only place a login is ever recorded). "First" is what actually
 * matters for a check-in-time policy: a cashier re-logging in later that day isn't a
 * second check-in, it's the same shift. Later same-day logins are counted, not dropped.
 */
export async function getLoginActivity(userIds: string[], range: DateRange) {
  const events = await prisma.loginEvent.findMany({
    where: { userId: { in: userIds }, createdAt: inRange(range) },
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "asc" },
  });

  const byUserDay = new Map<
    string,
    { userId: string; userName: string; role: string; day: string; firstLoginAt: Date; loginCount: number }
  >();
  for (const e of events) {
    // PHT day boundary (UTC+8), matching the rest of the reporting.
    const day = new Date(e.createdAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const key = `${e.userId}:${day}`;
    const prev = byUserDay.get(key);
    if (!prev) {
      byUserDay.set(key, {
        userId: e.userId,
        userName: e.user.name,
        role: e.user.role,
        day,
        firstLoginAt: e.createdAt,
        loginCount: 1,
      });
    } else {
      prev.loginCount++;
    }
  }

  return [...byUserDay.values()].sort((a, b) => b.firstLoginAt.getTime() - a.firstLoginAt.getTime());
}

export async function getTransferActivity(organizationId: string, range: DateRange) {
  const transfers = await prisma.stockTransfer.findMany({
    where: {
      fromBranch: { organizationId },
      createdAt: inRange(range),
    },
    include: { fromBranch: true, toBranch: true },
    orderBy: { createdAt: "desc" },
  });

  const byStatus = new Map<string, number>();
  const shipToReceiveMs: number[] = [];
  const openInTransit: typeof transfers = [];
  for (const t of transfers) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    if (t.status === "RECEIVED" && t.shippedAt && t.receivedAt) {
      shipToReceiveMs.push(t.receivedAt.getTime() - t.shippedAt.getTime());
    }
    if (t.status === "IN_TRANSIT") openInTransit.push(t);
  }
  const avgShipToReceiveHours = shipToReceiveMs.length
    ? shipToReceiveMs.reduce((a, b) => a + b, 0) / shipToReceiveMs.length / 3_600_000
    : null;

  return {
    total: transfers.length,
    byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    avgShipToReceiveHours,
    openInTransit: openInTransit.map((t) => ({
      id: t.id,
      fromBranchName: t.fromBranch.name,
      toBranchName: t.toBranch.name,
      shippedAt: t.shippedAt!.toISOString(),
      ageHours: (Date.now() - t.shippedAt!.getTime()) / 3_600_000,
    })),
  };
}

export const MENU_COST_WATCH_PERCENT = 35;
export const MENU_COST_HIGH_PERCENT = OUTLIER_HIGH_PERCENT;

/** Share of gross sales each delivery platform keeps (owner, 2026-09-30). Walk-in pays none. */
export const PLATFORM_FEE_PERCENT: Record<SalesChannel, number> = {
  [SalesChannel.WALK_IN]: 0,
  [SalesChannel.FOODPANDA]: 22,
  [SalesChannel.GRABFOOD]: 25,
};

/**
 * One row per active product with a recipe: price on the chosen channel (walk-in falls back
 * to Product.priceCents; platforms fall back to walk-in), theoretical cost at the reference
 * sweetness level, and margin. `incomplete` means at least one recipe line uses an ingredient
 * with no cost entered, so the cost (and margin) is optimistic.
 */
export async function getMenuCosting(organizationId: string, channel: SalesChannel = SalesChannel.WALK_IN) {
  const [products, ingredients] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId, active: true },
      include: {
        recipeLines: { where: { isActive: true } },
        channelPrices: true,
        modifierGroups: { include: { modifierGroup: { include: { modifiers: true } } } },
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    prisma.ingredient.findMany({ where: { organizationId } }),
  ]);
  const costMap = new Map(ingredients.map((i) => [i.id, i.costCentsPerUnit]));

  const rows = products
    .filter((p) => p.recipeLines.length > 0)
    .map((p) => {
      const sweetness = referenceSweetness(p.recipeLines);
      // A required, free, pick-one group (e.g. Corned Beef Regular/Spicy) is always consumed, so
      // its ingredient is part of the item's real cost even though it isn't a recipe line.
      // Priciest option is used so the cost is never understated.
      let flavorCostCents = 0;
      let flavorIncomplete = false;
      for (const { modifierGroup: g } of p.modifierGroups) {
        if (!g.required || g.selectionType !== "SINGLE") continue;
        const options = g.modifiers.filter((m) => m.priceCents === 0 && m.ingredientId && m.ingredientQty);
        if (options.length === 0) continue;
        const costs = options.map((m) => (costMap.get(m.ingredientId!) ?? 0) * Number(m.ingredientQty));
        flavorCostCents += Math.max(...costs);
        if (options.some((m) => (costMap.get(m.ingredientId!) ?? 0) === 0)) flavorIncomplete = true;
      }
      const costCents = computeRecipeCostCents(p.recipeLines, costMap, sweetness) + flavorCostCents;
      const priceCents = channel === SalesChannel.WALK_IN ? p.priceCents : (p.channelPrices.find((c) => c.channel === channel)?.priceCents ?? p.priceCents);
      const incomplete =
        flavorIncomplete ||
        p.recipeLines.some(
          (l) => (l.sweetnessPercent == null || l.sweetnessPercent === sweetness) && (costMap.get(l.ingredientId) ?? 0) === 0,
        );
      const feeCents = Math.round((priceCents * PLATFORM_FEE_PERCENT[channel]) / 100);
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category ?? "Uncategorized",
        priceCents,
        feeCents,
        costCents,
        marginCents: priceCents - feeCents - costCents,
        foodCostPercent: computeFoodCostPercent(costCents, priceCents),
        incomplete,
      };
    });

  return { rows, withoutRecipe: products.length - rows.length };
}
