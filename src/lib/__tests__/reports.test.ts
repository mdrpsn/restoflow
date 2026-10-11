import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { completeSale, voidSale } from "@/lib/sales";
import { adjustStock, logWaste } from "@/lib/transfers";
import { createTransfer, shipTransfer, receiveTransfer } from "@/lib/transfers";
import {
  getSalesByDay,
  getSalesByBranch,
  getTopProducts,
  getIngredientConsumption,
  getVarianceReport,
  getFoodCostSummary,
  getTransferActivity,
  getStockMovementLedger,
  getRecipeHealth,
} from "@/lib/reports";
import { createFixture, cleanupFixture } from "./testFixture";

const yesterday = () => new Date(Date.now() - 24 * 3600 * 1000);

describe("reports", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("getSalesByDay / getSalesByBranch / getTopProducts reconcile with actual sales", async () => {
    const { org, branchA, branchB, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });
    await prisma.stockItem.create({
      data: { branchId: branchB.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    const s1 = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 2 }],
    });
    const s2 = await completeSale({
      branchId: branchB.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CARD",
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const range = { since: yesterday() };
    const [byDay, byBranch, topProducts] = await Promise.all([
      getSalesByDay([branchA.id, branchB.id], range),
      getSalesByBranch([branchA.id, branchB.id], range),
      getTopProducts([branchA.id, branchB.id], range),
    ]);

    const totalFromByDay = byDay.reduce((s, d) => s + d.cents, 0);
    expect(totalFromByDay).toBe(s1.totalCents + s2.totalCents);

    const branchATotal = byBranch.find((b) => b.branchId === branchA.id);
    expect(branchATotal?.cents).toBe(s1.totalCents);
    expect(branchATotal?.count).toBe(1);

    const product1 = topProducts.find((p) => p.name === "Test Product");
    expect(product1?.qty).toBe(3); // 2 + 1
    expect(product1?.cents).toBe(s1.totalCents + s2.totalCents);
  });

  it("getIngredientConsumption matches the actual SALE-driven stock deduction", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });
    await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 5 }], // recipe qty 2 => 10 consumed
    });

    const consumption = await getIngredientConsumption([branchA.id], { since: yesterday() });
    const row = consumption.find((c) => c.ingredientId === ingredient.id);
    expect(row?.consumedQty).toBe("10");
  });

  it("getIngredientConsumption and getVarianceReport net out a voided sale instead of counting it forever", async () => {
    // Regression test: a sale that's rung up and immediately voided never
    // actually consumed any ingredients — the food was never made. Both
    // reports must reflect that, not just the raw SALE movement.
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    const voidedSale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 5 }], // recipe qty 2 => 10, then voided
    });
    await voidSale({ saleId: voidedSale.id, organizationId: org.id, userId: cashier.id });

    // A second, real (never-voided) sale for 1 unit => 2 consumed.
    await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const consumption = await getIngredientConsumption([branchA.id], { since: yesterday() });
    const consumptionRow = consumption.find((c) => c.ingredientId === ingredient.id);
    expect(consumptionRow?.consumedQty).toBe("2"); // not 12

    const variance = await getVarianceReport([branchA.id], { since: yesterday() });
    const varianceRow = variance.find((v) => v.ingredientId === ingredient.id);
    expect(varianceRow?.theoreticalConsumption).toBe("2"); // not 12
  });

  it("getVarianceReport separates theoretical use, waste, and net adjustments correctly", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 3 }], // theoretical: 6
    });
    await logWaste({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      quantity: 2,
      reason: "spoiled",
      createdById: cashier.id,
    });
    // physical count found less than expected -> negative adjustment
    await adjustStock({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      newQuantity: 88, // was 100 - 6 (sale) - 2 (waste) = 92; count says 88 => -4 adjustment
      createdById: cashier.id,
    });

    const variance = await getVarianceReport([branchA.id], { since: yesterday() });
    const row = variance.find((v) => v.ingredientId === ingredient.id)!;
    expect(row.theoreticalConsumption).toBe("6");
    expect(row.wasteQty).toBe("2");
    expect(row.adjustmentNet).toBe("-4");
  });

  it("getFoodCostSummary computes COGS from the recipe version each sale actually used", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    // fixture recipe: 2 units of ingredient (costCentsPerUnit=50) per product, priceCents=500
    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 4 }],
    });

    const summary = await getFoodCostSummary(org.id, [branchA.id], { since: yesterday() });
    expect(summary.revenueCents).toBe(sale.totalCents);
    // cost = 4 units sold * 2 ingredient qty * 50 cents = 400
    expect(summary.cogsCents).toBe(400);
    expect(summary.foodCostPercent).toBeCloseTo((400 / sale.totalCents) * 100, 5);
  });

  it("getTransferActivity reports status counts and open in-transit aging", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(50) },
    });

    const t1 = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 5 }],
    });
    await shipTransfer({ transferId: t1.id, organizationId: org.id, userId: cashier.id });
    await receiveTransfer({ transferId: t1.id, organizationId: org.id, userId: cashier.id });

    const t2 = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 3 }],
    });
    await shipTransfer({ transferId: t2.id, organizationId: org.id, userId: cashier.id });

    const activity = await getTransferActivity(org.id, { since: yesterday() });
    expect(activity.total).toBe(2);
    expect(activity.byStatus.find((s) => s.status === "RECEIVED")?.count).toBe(1);
    expect(activity.byStatus.find((s) => s.status === "IN_TRANSIT")?.count).toBe(1);
    expect(activity.openInTransit).toHaveLength(1);
    expect(activity.openInTransit[0].id).toBe(t2.id);
    expect(activity.avgShipToReceiveHours).not.toBeNull();
  });

  it("getStockMovementLedger filters by ingredient and type", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    await logWaste({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      quantity: 1,
      reason: "test",
      createdById: cashier.id,
    });

    const ledger = await getStockMovementLedger({
      branchIds: [branchA.id],
      ingredientId: ingredient.id,
      type: "WASTE",
      range: { since: yesterday() },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("WASTE");
  });

  it("getRecipeHealth flags missing recipes, zero-cost ingredients, and food-cost outliers", async () => {
    const { org, ingredient } = await createFixture();
    orgId = org.id;
    // fixture product: priceCents=500, recipe = 2 x ingredient(costCentsPerUnit=50) => 100
    // cents cost => 20% food cost, not an outlier.

    const noRecipeProduct = await prisma.product.create({
      data: { organizationId: org.id, name: "No Recipe Product", priceCents: 300 },
    });

    const freeIngredient = await prisma.ingredient.create({
      data: { organizationId: org.id, name: "Free Ingredient", unit: "pcs", costCentsPerUnit: 0 },
    });
    const zeroCostProduct = await prisma.product.create({
      data: {
        organizationId: org.id,
        name: "Zero Cost Recipe Product",
        priceCents: 400,
        recipeLines: { create: [{ ingredientId: freeIngredient.id, quantity: new Decimal(1) }] },
      },
    });

    // High outlier: cost (2 x 50 = 100) way more than 45% of a tiny price.
    const highOutlier = await prisma.product.create({
      data: {
        organizationId: org.id,
        name: "High Cost Product",
        priceCents: 100,
        recipeLines: { create: [{ ingredientId: ingredient.id, quantity: new Decimal(2) }] },
      },
    });

    // Low outlier: cost (1 x 50 = 50) way less than 5% of a huge price.
    const lowOutlier = await prisma.product.create({
      data: {
        organizationId: org.id,
        name: "Low Cost Product",
        priceCents: 5000,
        recipeLines: { create: [{ ingredientId: ingredient.id, quantity: new Decimal(1) }] },
      },
    });

    const health = await getRecipeHealth(org.id);

    expect(health.missingRecipes.some((p) => p.id === noRecipeProduct.id)).toBe(true);
    expect(health.missingRecipes.some((p) => p.id === zeroCostProduct.id)).toBe(false);

    const zeroCostRow = health.zeroCostIngredients.find((z) => z.ingredientId === freeIngredient.id);
    expect(zeroCostRow?.productNames).toContain("Zero Cost Recipe Product");

    const high = health.outliers.find((o) => o.id === highOutlier.id);
    expect(high?.direction).toBe("high");
    const low = health.outliers.find((o) => o.id === lowOutlier.id);
    expect(low?.direction).toBe("low");
    expect(health.outliers.some((o) => o.name === "Test Product")).toBe(false); // 20% isn't an outlier
  });
});
