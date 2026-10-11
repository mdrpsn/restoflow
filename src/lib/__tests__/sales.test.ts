import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { completeSale, voidSale } from "@/lib/sales";
import { StockError } from "@/lib/stock";
import { createFixture, cleanupFixture } from "./testFixture";

describe("completeSale / voidSale", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("deducts recipe ingredients and totals the sale in cents", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 3 }],
    });

    // product priceCents=500, recipe uses 2 units of ingredient per product
    expect(sale.totalCents).toBe(1500);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("14"); // 20 - 3*2
  });

  it("rejects a sale when stock is insufficient and override is off", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(1) },
    });

    await expect(
      completeSale({
        branchId: branchA.id,
        cashierId: cashier.id,
        organizationId: org.id,
        paymentMethod: "CASH",
        lines: [{ productId: product.id, quantity: 1 }], // needs 2 units
      }),
    ).rejects.toThrow(StockError);

    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("1"); // unchanged
  });

  it("allows negative stock when override is set, and voiding restores it", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(1) },
    });

    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CARD",
      lines: [{ productId: product.id, quantity: 1 }],
      allowNegativeStock: true,
    });

    let item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("-1"); // 1 - 2

    const voided = await voidSale({ saleId: sale.id, organizationId: org.id, userId: cashier.id });
    expect(voided.status).toBe("VOIDED");

    item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("1"); // restored

    await expect(
      voidSale({ saleId: sale.id, organizationId: org.id, userId: cashier.id }),
    ).rejects.toThrow(StockError);
  });

  it("prices modifier selections, deducts linked ingredient stock, and restores it on void", async () => {
    const { org, branchA, cashier, product, ingredient: sinkerIngredient } = await createFixture();
    orgId = org.id;

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: sinkerIngredient.id, quantity: new Decimal(50) },
    });
    // Reuse the fixture's ingredient (already wired into the product's recipe at qty 2)
    // as the modifier's linked ingredient too, purely to exercise the consumption math —
    // not meant to imply a real product would reuse the same ingredient both ways.
    const group = await prisma.modifierGroup.create({
      data: {
        organizationId: org.id,
        name: "Sinkers",
        selectionType: "MULTI",
        modifiers: {
          create: [{ name: "Black Pearl", priceCents: 2000, ingredientId: sinkerIngredient.id, ingredientQty: new Decimal(3) }],
        },
      },
      include: { modifiers: true },
    });
    await prisma.productModifierGroup.create({
      data: { productId: product.id, modifierGroupId: group.id },
    });
    const pearl = group.modifiers[0];

    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "CASH",
      lines: [{ productId: product.id, quantity: 2, modifiers: [{ modifierId: pearl.id, quantity: 1 }] }],
    });

    // (500 base + 2000 modifier) * 2 quantity
    expect(sale.totalCents).toBe(5000);

    let item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: sinkerIngredient.id } },
    });
    // 50 - (recipe: 2*2) - (modifier: 3*1*2) = 50 - 4 - 6
    expect(new Decimal(item.quantity).toString()).toBe("40");

    await voidSale({ saleId: sale.id, organizationId: org.id, userId: cashier.id });
    item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: sinkerIngredient.id } },
    });
    expect(new Decimal(item.quantity).toString()).toBe("50"); // fully restored
  });

  it("rejects a sale that skips a required modifier group", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;

    const group = await prisma.modifierGroup.create({
      data: {
        organizationId: org.id,
        name: "Sweetness Level",
        selectionType: "SINGLE",
        required: true,
        modifiers: { create: [{ name: "50%" }, { name: "100%" }] },
      },
    });
    await prisma.productModifierGroup.create({
      data: { productId: product.id, modifierGroupId: group.id },
    });

    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    await expect(
      completeSale({
        branchId: branchA.id,
        cashierId: cashier.id,
        organizationId: org.id,
        paymentMethod: "CASH",
        lines: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(StockError);
  });

  it("rejects a sale recorded at a warehouse branch", async () => {
    const { org, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    const warehouse = await prisma.branch.create({
      data: { organizationId: org.id, name: "Central Warehouse", code: "WH", type: "WAREHOUSE" },
    });
    await prisma.stockItem.create({
      data: { branchId: warehouse.id, ingredientId: ingredient.id, quantity: new Decimal(100) },
    });

    await expect(
      completeSale({
        branchId: warehouse.id,
        cashierId: cashier.id,
        organizationId: org.id,
        paymentMethod: "CASH",
        lines: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(StockError);

    const sales = await prisma.sale.findMany({ where: { branchId: warehouse.id } });
    expect(sales).toHaveLength(0);
  });

  it("rejects a platform-channel sale paid with cash", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    await expect(
      completeSale({
        branchId: branchA.id,
        cashierId: cashier.id,
        organizationId: org.id,
        paymentMethod: "CASH",
        channel: "FOODPANDA",
        lines: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(StockError);
  });

  it("rejects a walk-in sale paid with PLATFORM", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    await expect(
      completeSale({
        branchId: branchA.id,
        cashierId: cashier.id,
        organizationId: org.id,
        paymentMethod: "PLATFORM",
        lines: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(StockError);
  });

  it("charges the platform price and records the channel + order ref", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });
    await prisma.productChannelPrice.create({
      data: { productId: product.id, channel: "FOODPANDA", priceCents: 600 },
    });

    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "PLATFORM",
      channel: "FOODPANDA",
      externalRef: "FP-999",
      lines: [{ productId: product.id, quantity: 2 }],
    });

    expect(sale.totalCents).toBe(1200); // 600 (platform price) x 2, not the base 500
    expect(sale.channel).toBe("FOODPANDA");
    expect(sale.externalRef).toBe("FP-999");
  });

  it("falls back to the walk-in price on a platform sale with no override set", async () => {
    const { org, branchA, cashier, ingredient, product } = await createFixture();
    orgId = org.id;
    await prisma.stockItem.create({
      data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: new Decimal(20) },
    });

    const sale = await completeSale({
      branchId: branchA.id,
      cashierId: cashier.id,
      organizationId: org.id,
      paymentMethod: "PLATFORM",
      channel: "GRABFOOD",
      lines: [{ productId: product.id, quantity: 1 }],
    });

    expect(sale.totalCents).toBe(500); // base priceCents, no ProductChannelPrice row
    expect(sale.channel).toBe("GRABFOOD");
  });
});
