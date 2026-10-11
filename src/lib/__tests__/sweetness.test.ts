import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { completeSale, voidSale } from "@/lib/sales";
import { aggregateTheoreticalConsumption, recipeLineApplies, setProductRecipe } from "@/lib/recipes";
import { computeRecipeCostCents, referenceSweetness } from "@/lib/costing";
import { getFoodCostSummary } from "@/lib/reports";
import { createFixture, cleanupFixture } from "./testFixture";

describe("sweetness-dependent recipe lines (pure)", () => {
  const lines = [
    { ingredientId: "cup", quantity: new Decimal(1) },
    { ingredientId: "fructose", quantity: new Decimal(30), sweetnessPercent: 100 },
    { ingredientId: "fructose", quantity: new Decimal(15), sweetnessPercent: 50 },
  ];

  it("applies always-on lines plus only the picked level's lines", () => {
    expect(recipeLineApplies({ sweetnessPercent: null }, 50)).toBe(true);
    expect(recipeLineApplies({ sweetnessPercent: 50 }, 50)).toBe(true);
    expect(recipeLineApplies({ sweetnessPercent: 50 }, 100)).toBe(false);
    expect(recipeLineApplies({ sweetnessPercent: 50 }, null)).toBe(false);

    const at50 = aggregateTheoreticalConsumption([{ recipeLines: lines, quantitySold: 2, sweetnessPercent: 50 }]);
    expect(at50.get("cup")!.toString()).toBe("2");
    expect(at50.get("fructose")!.toString()).toBe("30"); // 15 x 2
  });

  it("prices at the level sold, and estimates at 100% (or the highest level present)", () => {
    const costs = new Map([["cup", 500], ["fructose", 10]]);
    expect(computeRecipeCostCents(lines, costs, 50)).toBe(500 + 150);
    expect(computeRecipeCostCents(lines, costs, 100)).toBe(500 + 300);
    expect(computeRecipeCostCents(lines, costs, null)).toBe(500); // no level, only always-on lines
    expect(referenceSweetness(lines)).toBe(100);
    expect(referenceSweetness([{ sweetnessPercent: 50 }, { sweetnessPercent: 75 }])).toBe(75);
    expect(referenceSweetness([{ sweetnessPercent: null }])).toBeNull();
  });
});

describe("sweetness-dependent recipe lines (sale, void, food cost)", () => {
  const orgIds: string[] = [];
  afterEach(async () => {
    for (const id of orgIds.splice(0)) await cleanupFixture(id);
  });

  async function setup() {
    const fx = await createFixture();
    orgIds.push(fx.org.id);
    const fructose = await prisma.ingredient.create({
      data: { organizationId: fx.org.id, name: "Fructose", unit: "ml", costCentsPerUnit: 10 },
    });
    await prisma.recipeLine.createMany({
      data: [
        { productId: fx.product.id, ingredientId: fructose.id, quantity: 15, sweetnessPercent: 50 },
        { productId: fx.product.id, ingredientId: fructose.id, quantity: 30, sweetnessPercent: 100 },
      ],
    });
    const group = await prisma.modifierGroup.create({
      data: {
        organizationId: fx.org.id,
        name: "Sweetness Level",
        selectionType: "SINGLE",
        required: true,
        modifiers: {
          create: [
            { name: "50%", sweetnessPercent: 50 },
            { name: "100%", sweetnessPercent: 100 },
          ],
        },
      },
      include: { modifiers: true },
    });
    await prisma.productModifierGroup.create({ data: { productId: fx.product.id, modifierGroupId: group.id } });
    await prisma.stockItem.createMany({
      data: [
        { branchId: fx.branchA.id, ingredientId: fx.ingredient.id, quantity: new Decimal(20) },
        { branchId: fx.branchA.id, ingredientId: fructose.id, quantity: new Decimal(1000) },
      ],
    });
    const level = (name: string) => group.modifiers.find((m) => m.name === name)!.id;
    const sell = (sweetness: string, quantity: number) =>
      completeSale({
        branchId: fx.branchA.id,
        cashierId: fx.cashier.id,
        organizationId: fx.org.id,
        paymentMethod: "CASH",
        lines: [{ productId: fx.product.id, quantity, modifiers: [{ modifierId: level(sweetness), quantity: 1 }] }],
      });
    const qty = async (ingredientId: string) =>
      new Decimal(
        (
          await prisma.stockItem.findUniqueOrThrow({
            where: { branchId_ingredientId: { branchId: fx.branchA.id, ingredientId } },
          })
        ).quantity,
      ).toString();
    return { fx, fructose, sell, qty };
  }

  it("deducts the fructose for the level picked, snapshots it, and a void restores exactly that", async () => {
    const { fx, fructose, sell, qty } = await setup();

    const saleA = await sell("50%", 1);
    expect(await qty(fructose.id)).toBe("985"); // 15
    expect(await qty(fx.ingredient.id)).toBe("18"); // always-on recipe line still applies

    await sell("100%", 2);
    expect(await qty(fructose.id)).toBe("925"); // 30 x 2
    expect(await qty(fx.ingredient.id)).toBe("14");

    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: saleA.id } });
    expect(line.sweetnessPercent).toBe(50);

    await voidSale({ saleId: saleA.id, organizationId: fx.org.id, userId: fx.cashier.id });
    expect(await qty(fructose.id)).toBe("940"); // only sale A's 15 came back
    expect(await qty(fx.ingredient.id)).toBe("16");
  });

  it("food cost uses the sweetness actually sold, not every level added together", async () => {
    const { fx, sell } = await setup();
    await sell("50%", 1);
    const now = new Date();
    const range = { since: new Date(now.getTime() - 3_600_000), until: new Date(now.getTime() + 3_600_000) };
    const summary = await getFoodCostSummary(fx.org.id, [fx.branchA.id], range);
    // recipe: 2 units of the fixture ingredient (50c each) + 15 ml fructose (10c each)
    expect(summary.cogsCents).toBe(2 * 50 + 15 * 10);
  });

  it("setProductRecipe stores the level so the next version keeps it", async () => {
    const { fx, fructose } = await setup();
    await prisma.$transaction((tx) =>
      setProductRecipe(tx, fx.product.id, [
        { ingredientId: fx.ingredient.id, quantity: 2 },
        { ingredientId: fructose.id, quantity: 20, sweetnessPercent: 75 },
      ]),
    );
    const active = await prisma.recipeLine.findMany({ where: { productId: fx.product.id, isActive: true } });
    expect(active.map((l) => [l.ingredientId === fructose.id, l.sweetnessPercent])).toEqual(
      expect.arrayContaining([[true, 75], [false, null]]),
    );
    expect(active).toHaveLength(2);
    expect(active.every((l) => l.version === 2)).toBe(true);
  });
});
