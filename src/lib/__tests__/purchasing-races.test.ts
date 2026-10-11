import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { receivePurchaseOrder, cancelPurchaseOrder } from "@/lib/purchasing";
import { createFixture, cleanupFixture } from "./testFixture";

describe("purchase order concurrency safety", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("two concurrent receipts on the same line cannot together over-receive it", async () => {
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

    // Two concurrent attempts to receive 6 of a 10-line — only one can fit
    // (6+6=12 > 10). Without a guard, both could pass a stale "remaining"
    // check and the bookkeeping would silently under-count what was received.
    const attempt = () =>
      receivePurchaseOrder({
        purchaseOrderId: po.id,
        organizationId: org.id,
        userId: cashier.id,
        receipts: [{ lineId, quantity: 6 }],
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const line = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(new Decimal(line.quantityReceived).toString()).toBe("6"); // not 12

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("6"); // stock matches bookkeeping
  });

  it("two receipts that each individually fit but together exceed remaining: the second is rejected", async () => {
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

    const results = await Promise.allSettled([
      receivePurchaseOrder({
        purchaseOrderId: po.id,
        organizationId: org.id,
        userId: cashier.id,
        receipts: [{ lineId, quantity: 7 }],
      }),
      receivePurchaseOrder({
        purchaseOrderId: po.id,
        organizationId: org.id,
        userId: cashier.id,
        receipts: [{ lineId, quantity: 7 }],
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const line = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(new Decimal(line.quantityReceived).toString()).toBe("7");
  });

  it("concurrent cancel attempts on the same PO cannot both succeed", async () => {
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
    });

    const attempt = () =>
      cancelPurchaseOrder({ purchaseOrderId: po.id, organizationId: org.id, userId: cashier.id });
    const results = await Promise.allSettled([attempt(), attempt()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
