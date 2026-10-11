import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, StockError, MovementType } from "@/lib/stock";
import { logWaste, adjustStock } from "@/lib/transfers";
import { createFixture, cleanupFixture } from "./testFixture";

describe("applyMovement", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("upserts stock balance and appends a ledger row", async () => {
    const { org, branchA, ingredient } = await createFixture();
    orgId = org.id;

    const { stockItem, movement } = await prisma.$transaction((tx) =>
      applyMovement(
        {
          branchId: branchA.id,
          ingredientId: ingredient.id,
          delta: 10,
          type: MovementType.RECEIVE,
          allowNegative: true,
        },
        tx,
      ),
    );

    expect(new Decimal(stockItem.quantity).toString()).toBe("10");
    expect(new Decimal(movement.balanceAfter).toString()).toBe("10");
    expect(movement.quantity.toString()).toBe("10");
  });

  it("rejects a movement that would take stock negative", async () => {
    const { org, branchA, ingredient } = await createFixture();
    orgId = org.id;

    await prisma.$transaction((tx) =>
      applyMovement(
        {
          branchId: branchA.id,
          ingredientId: ingredient.id,
          delta: 5,
          type: MovementType.RECEIVE,
          allowNegative: true,
        },
        tx,
      ),
    );

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(
          {
            branchId: branchA.id,
            ingredientId: ingredient.id,
            delta: -10,
            type: MovementType.SALE,
          },
          tx,
        ),
      ),
    ).rejects.toThrow(StockError);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("5");
  });

  it("blocks a second transaction on the same key until the first commits", async () => {
    // A plain Promise.allSettled race is not reliable here: without control
    // over scheduling, two concurrent transactions may not actually overlap
    // their read-then-write, so a flaky "fire both, check outcome" test can
    // pass by luck even with no locking at all. Instead we hold transaction 1
    // open deliberately and prove transaction 2 cannot proceed past
    // applyMovement until transaction 1 commits — a direct test of the lock
    // itself, not a timing gamble.
    const { org, branchA, ingredient } = await createFixture();
    orgId = org.id;

    const events: string[] = [];
    let releaseTx1: () => void = () => {};
    const tx1CanCommit = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    const tx1 = prisma.$transaction(async (tx) => {
      await applyMovement(
        {
          branchId: branchA.id,
          ingredientId: ingredient.id,
          delta: 10,
          type: MovementType.RECEIVE,
          allowNegative: true,
        },
        tx,
      );
      events.push("tx1-done");
      await tx1CanCommit; // hold the transaction (and its advisory lock) open
    });

    // Give tx1 time to actually acquire the lock and write before tx2 starts.
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual(["tx1-done"]);

    const tx2 = prisma.$transaction(async (tx) => {
      await applyMovement(
        {
          branchId: branchA.id,
          ingredientId: ingredient.id,
          delta: -3,
          type: MovementType.SALE,
        },
        tx,
      );
      events.push("tx2-done");
    });

    // tx2 should still be blocked on the advisory lock held by tx1.
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual(["tx1-done"]);

    releaseTx1();
    await tx1;
    await tx2;

    expect(events).toEqual(["tx1-done", "tx2-done"]);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("7");
  });
});

describe("logWaste", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("deducts stock and records a WASTE movement with the reason as its note", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });

    await logWaste({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      quantity: 3,
      reason: "Dropped tray",
      createdById: cashier.id,
    });

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("7");

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { branchId: branchA.id, ingredientId: ingredient.id, type: MovementType.WASTE },
    });
    expect(movement.quantity.toString()).toBe("-3");
    expect(movement.note).toBe("Dropped tray");
  });

  it("cannot waste more than is on hand", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(2) },
    });

    await expect(
      logWaste({
        branchId: branchA.id,
        ingredientId: ingredient.id,
        quantity: 5,
        reason: "Spoiled",
        createdById: cashier.id,
      }),
    ).rejects.toThrow(StockError);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("2");
  });
});

describe("adjustStock", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("sets stock to an arbitrary non-negative quantity, recording the signed delta", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });

    await adjustStock({
      branchId: branchA.id,
      ingredientId: ingredient.id,
      newQuantity: 3,
      createdById: cashier.id,
      note: "physical count",
    });

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("3");
  });

  it("rejects setting on-hand quantity to a negative amount", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(10) },
    });

    await expect(
      adjustStock({
        branchId: branchA.id,
        ingredientId: ingredient.id,
        newQuantity: -1,
        createdById: cashier.id,
      }),
    ).rejects.toThrow(StockError);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("10"); // untouched
  });
});
