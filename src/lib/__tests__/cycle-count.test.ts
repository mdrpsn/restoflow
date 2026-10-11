import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { runCycleCount } from "@/lib/transfers";
import { StockError, MovementType } from "@/lib/stock";
import { createFixture, cleanupFixture } from "./testFixture";

async function stockOf(branchId: string, ingredientId: string) {
  const item = await prisma.stockItem.findUnique({
    where: { branchId_ingredientId: { branchId, ingredientId } },
  });
  return item ? new Decimal(item.quantity).toString() : "0";
}

describe("runCycleCount", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("applies a batch of counts, skips unchanged lines, and tags every movement with one shared refId", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;

    const cheese = await prisma.ingredient.create({
      data: { organizationId: org.id, name: "Cheese", unit: "pcs", costCentsPerUnit: 10 },
    });
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: cheese.id, quantity: new Decimal(5) },
    });

    const result = await runCycleCount({
      branchId: branchA.id,
      createdById: cashier.id,
      counts: [
        { ingredientId: ingredient.id, countedQuantity: 8 }, // changed: 10 -> 8
        { ingredientId: cheese.id, countedQuantity: 5 }, // unchanged
      ],
    });

    expect(result.lines).toHaveLength(2);
    const changedLine = result.lines.find((l) => l.ingredientId === ingredient.id)!;
    expect(changedLine.previousQuantity).toBe("10");
    expect(changedLine.countedQuantity).toBe("8");
    expect(changedLine.delta).toBe("-2");

    expect(await stockOf(branchA.id, ingredient.id)).toBe("8");
    expect(await stockOf(branchA.id, cheese.id)).toBe("5"); // untouched

    // Exactly one movement was created (for the changed line), tagged with the batch id.
    const movements = await prisma.stockMovement.findMany({
      where: { refType: "cycle_count", refId: result.batchId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe(MovementType.ADJUSTMENT);
    expect(movements[0].ingredientId).toBe(ingredient.id);
    expect(movements[0].quantity.toString()).toBe("-2");
  });

  it("is all-or-nothing: a bad line rolls back the whole batch", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    const cheese = await prisma.ingredient.create({
      data: { organizationId: org.id, name: "Cheese", unit: "pcs", costCentsPerUnit: 10 },
    });
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: cheese.id, quantity: new Decimal(5) },
    });

    await expect(
      runCycleCount({
        branchId: branchA.id,
        createdById: cashier.id,
        counts: [
          { ingredientId: ingredient.id, countedQuantity: 8 }, // would succeed alone
          { ingredientId: cheese.id, countedQuantity: -1 }, // invalid: negative
        ],
      }),
    ).rejects.toThrow(StockError);

    // The first (valid) line must NOT have been committed either.
    expect(await stockOf(branchA.id, ingredient.id)).toBe("10");
    expect(await stockOf(branchA.id, cheese.id)).toBe("5");

    const movements = await prisma.stockMovement.findMany({
      where: { refType: "cycle_count", branchId: branchA.id },
    });
    expect(movements).toHaveLength(0);
  });

  it("rejects an empty count submission", async () => {
    const { org, branchA, cashier } = await createFixture();
    orgId = org.id;
    await expect(
      runCycleCount({ branchId: branchA.id, createdById: cashier.id, counts: [] }),
    ).rejects.toThrow(StockError);
  });
});
