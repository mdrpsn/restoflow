import { MovementType, SaleStatus, StockRequestStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import {
  getFoodCostSummary,
  getIngredientConsumption,
  getVarianceReport,
} from "@/lib/reports";
import { getStockAlertSummary } from "@/lib/stock";

function manilaDateRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const since = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(since.getTime())) throw new Error("Invalid date");
  const until = new Date(since.getTime() + 24 * 60 * 60_000 - 1);
  return { since, until };
}

export async function getDailyOperationsSummary(params: {
  organizationId: string;
  branchCode: string;
  date: string;
}) {
  const branch = await prisma.branch.findFirst({
    where: { organizationId: params.organizationId, code: params.branchCode },
  });
  if (!branch) throw new Error("Branch not found");
  const range = manilaDateRange(params.date);

  const [
    sales,
    consumption,
    foodCost,
    variance,
    stockAlerts,
    wasteMovements,
    openRequests,
    inTransitCount,
  ] = await Promise.all([
    prisma.sale.findMany({
      where: { branchId: branch.id, status: SaleStatus.COMPLETED, createdAt: { gte: range.since, lte: range.until } },
      include: { lines: { include: { product: { select: { id: true, name: true } } } } },
    }),
    getIngredientConsumption([branch.id], range),
    getFoodCostSummary(params.organizationId, [branch.id], range),
    getVarianceReport([branch.id], range),
    getStockAlertSummary([branch.id]),
    prisma.stockMovement.findMany({
      where: {
        branchId: branch.id,
        type: MovementType.WASTE,
        createdAt: { gte: range.since, lte: range.until },
      },
      include: { ingredient: true },
    }),
    prisma.stockRequest.count({
      where: {
        branchId: branch.id,
        status: { in: [StockRequestStatus.DRAFT, StockRequestStatus.PENDING] },
      },
    }),
    prisma.stockTransfer.count({ where: { toBranchId: branch.id, status: "IN_TRANSIT" } }),
  ]);

  const revenueCents = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
  const allLines = sales.flatMap((sale) => sale.lines);
  const mappedLines = allLines.filter((line) => line.recipeVersion !== null);
  const mappedRevenueCents = mappedLines.reduce((sum, line) => sum + line.totalCents, 0);
  const mappedQuantity = mappedLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalQuantity = allLines.reduce((sum, line) => sum + line.quantity, 0);
  const unmapped = new Map<string, { productId: string; name: string; quantity: number; revenueCents: number }>();
  for (const line of allLines.filter((item) => item.recipeVersion === null)) {
    const current = unmapped.get(line.productId) ?? {
      productId: line.productId,
      name: line.product.name,
      quantity: 0,
      revenueCents: 0,
    };
    current.quantity += line.quantity;
    current.revenueCents += line.totalCents;
    unmapped.set(line.productId, current);
  }

  const paymentMethods = new Map<string, { count: number; revenueCents: number }>();
  const channels = new Map<string, { count: number; revenueCents: number }>();
  for (const sale of sales) {
    const current = paymentMethods.get(sale.paymentMethod) ?? { count: 0, revenueCents: 0 };
    current.count += 1;
    current.revenueCents += sale.totalCents;
    paymentMethods.set(sale.paymentMethod, current);

    const chan = channels.get(sale.channel) ?? { count: 0, revenueCents: 0 };
    chan.count += 1;
    chan.revenueCents += sale.totalCents;
    channels.set(sale.channel, chan);
  }

  const waste = wasteMovements.map((movement) => ({
    ingredientId: movement.ingredientId,
    ingredientName: movement.ingredient.name,
    unit: movement.ingredient.unit,
    quantity: new Decimal(movement.quantity).neg().toString(),
    valueCents: new Decimal(movement.quantity)
      .neg()
      .mul(movement.ingredient.costCentsPerUnit)
      .round()
      .toNumber(),
    reason: movement.note,
  }));

  return {
    date: params.date,
    timezone: "Asia/Manila",
    branch: { id: branch.id, code: branch.code, name: branch.name },
    sales: {
      revenueCents,
      transactions: sales.length,
      averageTicketCents: sales.length ? Math.round(revenueCents / sales.length) : 0,
      paymentMethods: [...paymentMethods.entries()].map(([method, totals]) => ({ method, ...totals })),
      channels: [...channels.entries()].map(([channel, totals]) => ({ channel, ...totals })),
    },
    recipeCoverage: {
      mappedRevenueCents,
      revenuePercent: revenueCents ? (mappedRevenueCents / revenueCents) * 100 : 100,
      mappedQuantity,
      totalQuantity,
      quantityPercent: totalQuantity ? (mappedQuantity / totalQuantity) * 100 : 100,
      unmappedProducts: [...unmapped.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    },
    foodCost,
    consumption: consumption.slice(0, 20),
    waste: {
      totalValueCents: waste.reduce((sum, item) => sum + item.valueCents, 0),
      entries: waste,
    },
    variance: variance.filter((item) => item.adjustmentNet !== "0" || item.wasteQty !== "0"),
    inventory: {
      trackedCount: stockAlerts.trackedCount,
      critical: stockAlerts.critical.map((item) => ({
        ingredientName: item.ingredient.name,
        unit: item.ingredient.unit,
        quantity: item.quantity.toString(),
        lowStockAt: item.lowStockAt.toString(),
        parLevel: item.parLevel?.toString() ?? null,
      })),
      low: stockAlerts.low.map((item) => ({
        ingredientName: item.ingredient.name,
        unit: item.ingredient.unit,
        quantity: item.quantity.toString(),
        lowStockAt: item.lowStockAt.toString(),
        parLevel: item.parLevel?.toString() ?? null,
      })),
    },
    replenishment: { openRequests, inTransitTransfers: inTransitCount },
    generatedAt: new Date().toISOString(),
  };
}
