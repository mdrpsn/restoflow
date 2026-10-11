import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, MovementType } from "@/lib/stock";
import {
  approveStockRequest,
  reconcileAutomatedStockRequest,
  submitAutomatedStockRequestDraft,
} from "@/lib/stockRequests";
import { completeSale } from "@/lib/sales";
import { getDailyOperationsSummary } from "@/lib/dailySummary";
import { cleanupFixture, createFixture } from "./testFixture";

describe("inventory automation pilot", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("emits one event per stock-state transition", async () => {
    const { org, branchA, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: {
        branchId: branchA.id,
        ingredientId: ingredient.id,
        quantity: new Decimal(10),
        lowStockAt: new Decimal(5),
        parLevel: new Decimal(15),
      },
    });

    const move = (delta: number, type: MovementType) => prisma.$transaction((tx) =>
      applyMovement({
        branchId: branchA.id,
        ingredientId: ingredient.id,
        delta,
        type,
        allowNegative: true,
      }, tx),
    );
    await move(-6, MovementType.SALE); // NORMAL -> LOW
    await move(-1, MovementType.SALE); // still LOW
    await move(-3, MovementType.SALE); // LOW -> CRITICAL
    await move(10, MovementType.RECEIVE); // CRITICAL -> NORMAL

    const events = await prisma.integrationEvent.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "INVENTORY_LOW",
      "INVENTORY_CRITICAL",
      "INVENTORY_RECOVERED",
    ]);
  });

  it("defaults a new stock row from the ingredient threshold", async () => {
    const { org, branchA, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.ingredient.update({
      where: { id: ingredient.id },
      data: { defaultLowStockAt: new Decimal(7) },
    });
    const result = await prisma.$transaction((tx) => applyMovement({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      delta: 3,
      type: MovementType.RECEIVE,
      allowNegative: true,
    }, tx));
    expect(result.stockItem.lowStockAt.toString()).toBe("7");
    expect(await prisma.integrationEvent.count({
      where: { organizationId: org.id, type: "INVENTORY_LOW" },
    })).toBe(1);
  });

  it("reconciles one idempotent draft to par and preserves human approval", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.branch.create({
      data: { organizationId: org.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" },
    });
    await prisma.stockItem.create({
      data: {
        branchId: branchA.id,
        ingredientId: ingredient.id,
        quantity: new Decimal(2),
        lowStockAt: new Decimal(5),
        parLevel: new Decimal(10),
      },
    });

    const first = await reconcileAutomatedStockRequest({ organizationId: org.id, branchCode: "A" });
    const second = await reconcileAutomatedStockRequest({ organizationId: org.id, branchCode: "A" });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.draft?.id).toBe(first.draft?.id);
    expect(second.draft?.lines[0].quantity.toString()).toBe("8");

    const submitted = await submitAutomatedStockRequestDraft({
      requestId: first.draft!.id,
      organizationId: org.id,
      requestedById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 7 }],
    });
    expect(submitted.status).toBe("PENDING");
    expect(submitted.requestedById).toBe(cashier.id);
    expect(submitted.automationKey).toBeNull();

    const approved = await approveStockRequest({
      requestId: submitted.id,
      organizationId: org.id,
      reviewerId: cashier.id,
      approvedQuantities: { [ingredient.id]: 6 },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.transferId).not.toBeNull();
  });

  it("allows unmapped sales but reports their recipe coverage", async () => {
    const { org, branchA, cashier } = await createFixture();
    orgId = org.id;
    const unmapped = await prisma.product.create({
      data: { organizationId: org.id, name: "Unmapped Pilot Product", priceCents: 800 },
    });
    await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: unmapped.id, quantity: 2 }],
    });

    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const summary = await getDailyOperationsSummary({
      organizationId: org.id,
      branchCode: branchA.code,
      date,
    });
    expect(summary.recipeCoverage.revenuePercent).toBe(0);
    expect(summary.recipeCoverage.unmappedProducts).toEqual([
      expect.objectContaining({ name: "Unmapped Pilot Product", quantity: 2 }),
    ]);
    expect(await prisma.integrationEvent.count({
      where: { organizationId: org.id, type: "MISSING_RECIPE" },
    })).toBe(1);
  });
});
