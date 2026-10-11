import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { completeSale } from "@/lib/sales";
import { StockError } from "@/lib/stock";
import { listUnavailableProductIds, setProductAvailability } from "@/lib/productAvailability";
import { createFixture, cleanupFixture } from "./testFixture";

describe("product availability", () => {
  const orgIds: string[] = [];

  afterEach(async () => {
    for (const id of orgIds.splice(0)) await cleanupFixture(id);
  });

  it("marks a product unavailable at one branch only, and re-enabling clears it", async () => {
    const { org, branchA, branchB, cashier, product } = await createFixture();
    orgIds.push(org.id);

    await setProductAvailability({
      organizationId: org.id,
      branchId: branchA.id,
      productId: product.id,
      available: false,
      userId: cashier.id,
    });

    expect((await listUnavailableProductIds(branchA.id)).has(product.id)).toBe(true);
    expect((await listUnavailableProductIds(branchB.id)).has(product.id)).toBe(false);

    await setProductAvailability({
      organizationId: org.id,
      branchId: branchA.id,
      productId: product.id,
      available: true,
      userId: cashier.id,
    });
    expect((await listUnavailableProductIds(branchA.id)).has(product.id)).toBe(false);

    const row = await prisma.productAvailability.findUniqueOrThrow({
      where: { branchId_productId: { branchId: branchA.id, productId: product.id } },
    });
    expect(row.updatedById).toBe(cashier.id);
  });

  it("refuses a warehouse branch and another organization's product", async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    orgIds.push(mine.org.id, theirs.org.id);

    const warehouse = await prisma.branch.create({
      data: { organizationId: mine.org.id, name: "WH", code: "WH", type: "WAREHOUSE" },
    });

    await expect(
      setProductAvailability({
        organizationId: mine.org.id,
        branchId: warehouse.id,
        productId: mine.product.id,
        available: false,
        userId: mine.cashier.id,
      }),
    ).rejects.toThrow(StockError);

    await expect(
      setProductAvailability({
        organizationId: mine.org.id,
        branchId: mine.branchA.id,
        productId: theirs.product.id,
        available: false,
        userId: mine.cashier.id,
      }),
    ).rejects.toThrow("Product not found");
  });

  it("completeSale rejects an unavailable product without touching stock, and sells again once re-enabled", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgIds.push(org.id);
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    await setProductAvailability({
      organizationId: org.id,
      branchId: branchA.id,
      productId: product.id,
      available: false,
      userId: cashier.id,
    });

    const sale = {
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH" as const,
      lines: [{ productId: product.id, quantity: 1 }],
    };

    await expect(completeSale(sale)).rejects.toThrow(/Unavailable at this branch: Test Product/);
    const untouched = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(untouched.quantity).toString()).toBe("20");

    await setProductAvailability({
      organizationId: org.id,
      branchId: branchA.id,
      productId: product.id,
      available: true,
      userId: cashier.id,
    });
    await expect(completeSale(sale)).resolves.toMatchObject({ totalCents: 500 });
  });
});
