import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { createTransfer, shipTransfer, receiveTransfer, cancelTransfer } from "@/lib/transfers";
import { createFixture, cleanupFixture } from "./testFixture";

async function stockOf(branchId: string, ingredientId: string) {
  const item = await prisma.stockItem.findUnique({
    where: { branchId_ingredientId: { branchId, ingredientId } },
  });
  return item ? new Decimal(item.quantity).toString() : "0";
}

describe("transfer concurrency safety", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("two concurrent shipTransfer calls on the same DRAFT transfer must not both deduct stock", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 4 }],
    });

    const attempt = () =>
      shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one caller may succeed; the other must be rejected, not silently
    // apply a second deduction.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Stock must be deducted exactly once (10 - 4 = 6), never twice (10 - 8 = 2).
    expect(await stockOf(branchA.id, ingredient.id)).toBe("6");

    const movements = await prisma.stockMovement.findMany({
      where: { refType: "transfer", refId: transfer.id },
    });
    expect(movements).toHaveLength(1);
  });

  it("two concurrent receiveTransfer calls on the same IN_TRANSIT transfer must not both add stock", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 4 }],
    });
    await shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });

    const attempt = () =>
      receiveTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });
    const results = await Promise.allSettled([attempt(), attempt()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await stockOf(branchB.id, ingredient.id)).toBe("4"); // not 8
  });

  it("a concurrent ship and cancel on the same DRAFT transfer cannot both succeed", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });
    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 4 }],
    });

    const results = await Promise.allSettled([
      shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
      cancelTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1); // one of the two must win, never both

    const final = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    // Whatever the outcome, stock must be internally consistent with the final status.
    if (final.status === "IN_TRANSIT") {
      expect(await stockOf(branchA.id, ingredient.id)).toBe("6");
    } else if (final.status === "CANCELLED") {
      expect(await stockOf(branchA.id, ingredient.id)).toBe("10");
    }
  });
});
