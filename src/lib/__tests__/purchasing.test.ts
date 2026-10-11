import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { cancelPurchaseOrder, receivePurchaseOrder } from "@/lib/purchasing";
import { StockError } from "@/lib/stock";
import { createFixture, cleanupFixture } from "./testFixture";

describe("receivePurchaseOrder", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("moves ORDERED -> PARTIAL -> RECEIVED as lines are received, posting stock each time", async () => {
    const { org, branchA, cashier, ingredient, supplier } = await createFixture();
    orgId = org.id;

    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        branchId: branchA.id,
        supplierId: supplier.id,
        status: "ORDERED",
        orderedAt: new Date(),
        lines: {
          create: [{ ingredientId: ingredient.id, quantityOrdered: new Decimal(10), unitCostCents: 50 }],
        },
      },
      include: { lines: true },
    });
    const lineId = po.lines[0].id;

    const afterPartial = await receivePurchaseOrder({
      purchaseOrderId: po.id,
      organizationId: org.id,
      userId: cashier.id,
      receipts: [{ lineId, quantity: 4 }],
    });
    expect(afterPartial.status).toBe("PARTIAL");

    let item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("4");

    const afterFull = await receivePurchaseOrder({
      purchaseOrderId: po.id,
      organizationId: org.id,
      userId: cashier.id,
      receipts: [{ lineId, quantity: 6 }],
    });
    expect(afterFull.status).toBe("RECEIVED");
    expect(afterFull.receivedAt).not.toBeNull();

    item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("10");
  });

  it("rejects receiving more than the remaining quantity on a line", async () => {
    const { org, branchA, cashier, ingredient, supplier } = await createFixture();
    orgId = org.id;

    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        branchId: branchA.id,
        supplierId: supplier.id,
        status: "ORDERED",
        orderedAt: new Date(),
        lines: {
          create: [{ ingredientId: ingredient.id, quantityOrdered: new Decimal(5), unitCostCents: 50 }],
        },
      },
      include: { lines: true },
    });
    const lineId = po.lines[0].id;

    await expect(
      receivePurchaseOrder({
        purchaseOrderId: po.id,
        organizationId: org.id,
        userId: cashier.id,
        receipts: [{ lineId, quantity: 6 }],
      }),
    ).rejects.toThrow(StockError);
  });

  it("cancels a partially received PO without touching already-received stock, and blocks further receiving", async () => {
    const { org, branchA, cashier, ingredient, supplier } = await createFixture();
    orgId = org.id;

    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        branchId: branchA.id,
        supplierId: supplier.id,
        status: "ORDERED",
        orderedAt: new Date(),
        lines: {
          create: [{ ingredientId: ingredient.id, quantityOrdered: new Decimal(10), unitCostCents: 50 }],
        },
      },
      include: { lines: true },
    });
    const lineId = po.lines[0].id;

    await receivePurchaseOrder({
      purchaseOrderId: po.id,
      organizationId: org.id,
      userId: cashier.id,
      receipts: [{ lineId, quantity: 4 }],
    });

    const cancelled = await cancelPurchaseOrder({
      purchaseOrderId: po.id,
      organizationId: org.id,
      userId: cashier.id,
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledById).toBe(cashier.id);
    expect(cancelled.cancelledAt).not.toBeNull();

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("4"); // already-received stock untouched

    await expect(
      receivePurchaseOrder({
        purchaseOrderId: po.id,
        organizationId: org.id,
        userId: cashier.id,
        receipts: [{ lineId, quantity: 1 }],
      }),
    ).rejects.toThrow(StockError);

    await expect(
      cancelPurchaseOrder({ purchaseOrderId: po.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError); // already cancelled
  });
});
