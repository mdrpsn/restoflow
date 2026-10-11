import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { cancelTransfer, createTransfer, receiveTransfer, shipTransfer } from "@/lib/transfers";
import { StockError } from "@/lib/stock";
import { createFixture, cleanupFixture } from "./testFixture";

async function stockOf(branchId: string, ingredientId: string) {
  const item = await prisma.stockItem.findUnique({
    where: { branchId_ingredientId: { branchId, ingredientId } },
  });
  return item ? new Decimal(item.quantity).toString() : "0";
}

describe("stock transfers", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("creates a DRAFT transfer with no stock impact", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 5 }],
    });

    expect(transfer.status).toBe("DRAFT");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("20"); // unchanged
    expect(await stockOf(branchB.id, ingredient.id)).toBe("0");
  });

  it("full lifecycle: ship deducts from source, receive adds to destination, at the right steps", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 5 }],
    });

    // Still DRAFT: no movement yet, even though the transfer exists
    expect(await stockOf(branchA.id, ingredient.id)).toBe("20");

    const shipped = await shipTransfer({
      transferId: transfer.id,
      organizationId: org.id,
      userId: cashier.id,
    });
    expect(shipped.status).toBe("IN_TRANSIT");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("15"); // left the source
    expect(await stockOf(branchB.id, ingredient.id)).toBe("0"); // not arrived yet

    const received = await receiveTransfer({
      transferId: transfer.id,
      organizationId: org.id,
      userId: cashier.id,
    });
    expect(received.status).toBe("RECEIVED");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("15");
    expect(await stockOf(branchB.id, ingredient.id)).toBe("5"); // arrived

    const movements = await prisma.stockMovement.findMany({
      where: { refType: "transfer", refId: transfer.id },
      orderBy: { createdAt: "asc" },
    });
    expect(movements.map((m) => m.type)).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
  });

  it("cannot ship a transfer that isn't DRAFT, and cannot receive one that isn't IN_TRANSIT", async () => {
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
      lines: [{ ingredientId: ingredient.id, quantity: 1 }],
    });

    await expect(
      receiveTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError);

    await shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });

    await expect(
      shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError);
  });

  it("ship still enforces the negative-stock guard", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(2) },
    });
    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 10 }],
    });

    await expect(
      shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError);
    expect(await stockOf(branchA.id, ingredient.id)).toBe("2"); // untouched
  });

  it("cancelling a DRAFT transfer has no stock impact", async () => {
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
      lines: [{ ingredientId: ingredient.id, quantity: 3 }],
    });

    const cancelled = await cancelTransfer({
      transferId: transfer.id,
      organizationId: org.id,
      userId: cashier.id,
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("10");
  });

  it("cancelling an IN_TRANSIT transfer reverses the shipment back to the source", async () => {
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
    expect(await stockOf(branchA.id, ingredient.id)).toBe("6");

    const cancelled = await cancelTransfer({
      transferId: transfer.id,
      organizationId: org.id,
      userId: cashier.id,
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("10"); // reversed
    expect(await stockOf(branchB.id, ingredient.id)).toBe("0"); // never arrived

    const movements = await prisma.stockMovement.findMany({
      where: { refType: "transfer", refId: transfer.id },
      orderBy: { createdAt: "asc" },
    });
    expect(movements.map((m) => m.type)).toEqual(["TRANSFER_OUT", "TRANSFER_CANCEL"]);

    // Cannot cancel again once already CANCELLED
    await expect(
      cancelTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError);
  });

  it("rejects a transfer line with zero or negative quantity", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });

    await expect(
      createTransfer({
        organizationId: org.id,
        fromBranchId: branchA.id,
        toBranchId: branchB.id,
        createdById: cashier.id,
        lines: [{ ingredientId: ingredient.id, quantity: 0 }],
      }),
    ).rejects.toThrow(StockError);

    await expect(
      createTransfer({
        organizationId: org.id,
        fromBranchId: branchA.id,
        toBranchId: branchB.id,
        createdById: cashier.id,
        lines: [{ ingredientId: ingredient.id, quantity: -5 }],
      }),
    ).rejects.toThrow(StockError);

    // Confirm nothing was persisted and stock is untouched either way.
    const transfers = await prisma.stockTransfer.findMany({
      where: { fromBranchId: branchA.id },
    });
    expect(transfers).toHaveLength(0);
    expect(await stockOf(branchA.id, ingredient.id)).toBe("10");
  });

  it("rejects a transfer with the same ingredient on two lines", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });

    await expect(
      createTransfer({
        organizationId: org.id,
        fromBranchId: branchA.id,
        toBranchId: branchB.id,
        createdById: cashier.id,
        lines: [
          { ingredientId: ingredient.id, quantity: 2 },
          { ingredientId: ingredient.id, quantity: 3 },
        ],
      }),
    ).rejects.toThrow(StockError);

    const transfers = await prisma.stockTransfer.findMany({ where: { fromBranchId: branchA.id } });
    expect(transfers).toHaveLength(0);
  });

  it("supports a warehouse as either endpoint", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    const warehouse = await prisma.branch.create({
      data: { organizationId: org.id, name: "Central Warehouse", code: "WH", type: "WAREHOUSE" },
    });
    await prisma.stockItem.create({
      data: { branchId: warehouse.id, ingredientId: ingredient.id, quantity: new Decimal(50) },
    });

    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: warehouse.id,
      toBranchId: branchA.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 20 }],
    });
    await shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });
    await receiveTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });

    expect(await stockOf(warehouse.id, ingredient.id)).toBe("30");
    expect(await stockOf(branchA.id, ingredient.id)).toBe("20");
  });
});
