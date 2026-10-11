import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { completeSale, voidSale } from "@/lib/sales";
import { setProductRecipe, aggregateTheoreticalConsumption } from "@/lib/recipes";
import { createFixture, cleanupFixture } from "./testFixture";

describe("recipe versioning", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("setProductRecipe creates a new version without deleting the old one", async () => {
    const { org, ingredient, product } = await createFixture();
    orgId = org.id;

    // fixture already creates version 1 (quantity 2) via createFixture's recipeLines.create
    const v1Before = await prisma.recipeLine.findMany({ where: { productId: product.id } });
    expect(v1Before).toHaveLength(1);
    expect(v1Before[0].version).toBe(1);
    expect(v1Before[0].isActive).toBe(true);

    const nextVersion = await prisma.$transaction((tx) =>
      setProductRecipe(tx, product.id, [{ ingredientId: ingredient.id, quantity: 5 }]),
    );
    expect(nextVersion).toBe(2);

    const allLines = await prisma.recipeLine.findMany({
      where: { productId: product.id },
      orderBy: { version: "asc" },
    });
    expect(allLines).toHaveLength(2);
    expect(allLines[0]).toMatchObject({ version: 1, isActive: false });
    expect(allLines[1]).toMatchObject({ version: 2, isActive: true });
    expect(new Decimal(allLines[1].quantity).toString()).toBe("5");
  });

  it("a sale snapshots the active recipe version, and voiding it restores stock using that snapshot, not the current recipe", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    // Sell 1 unit under recipe v1 (quantity 2 per fixture)
    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const saleLine = await prisma.saleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    expect(saleLine.recipeVersion).toBe(1);

    let item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("98"); // 100 - 1*2

    // Now change the recipe to use 10 units per product (v2)
    await prisma.$transaction((tx) =>
      setProductRecipe(tx, product.id, [{ ingredientId: ingredient.id, quantity: 10 }]),
    );

    // Void the original (v1) sale — must restore 2 (v1 qty), not 10 (v2 qty)
    await voidSale({ saleId: sale.id, organizationId: org.id, userId: cashier.id });

    item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("100"); // fully restored using v1 math
  });

  it("aggregateTheoreticalConsumption matches completeSale's own deduction", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(50) },
    });

    await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 3 }],
    });

    const activeLines = await prisma.recipeLine.findMany({
      where: { productId: product.id, isActive: true },
    });
    const needs = aggregateTheoreticalConsumption([
      { recipeLines: activeLines, quantitySold: 3 },
    ]);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    const consumed = new Decimal(50).minus(new Decimal(item.quantity));
    expect(consumed.toString()).toBe(needs.get(ingredient.id)!.toString());
  });
});
