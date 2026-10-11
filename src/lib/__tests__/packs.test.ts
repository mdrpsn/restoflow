import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { createTransfer, receiveStock, receiveTransfer, shipTransfer } from "@/lib/transfers";
import { StockError } from "@/lib/stock";
import { buildPlan, type IngredientRef } from "@/lib/warehouseImportCore";
import { formatStock, packBreakdown, packToBase } from "@/lib/packs";
import { createFixture, cleanupFixture } from "./testFixture";

const CHEDDAR_PACKS = [
  { name: "430g bar", size: 430 },
  { name: "900g bar", size: 900 },
];

describe("pack display", () => {
  it("splits a quantity exactly into packs", () => {
    expect(packBreakdown(1290, CHEDDAR_PACKS)).toBe("3 × 430g bar");
    expect(packBreakdown(1800, CHEDDAR_PACKS)).toBe("2 × 900g bar");
    expect(packBreakdown(1330, CHEDDAR_PACKS)).toBe("1 × 900g bar + 1 × 430g bar");
  });

  it("returns null instead of a fractional pack count when it doesn't split exactly", () => {
    expect(packBreakdown(645, CHEDDAR_PACKS)).toBeNull();
    expect(packBreakdown(0, CHEDDAR_PACKS)).toBeNull();
    expect(packBreakdown(500, [])).toBeNull();
  });

  it("branches show the plain base unit, the warehouse adds the pack hint", () => {
    expect(formatStock(1290, "g", CHEDDAR_PACKS, false)).toBe("1,290 g");
    expect(formatStock(1290, "g", CHEDDAR_PACKS, true)).toBe("1,290 g (3 × 430g bar)");
    expect(formatStock(645, "g", CHEDDAR_PACKS, true)).toBe("645 g");
  });

  it("handles fractional pack sizes", () => {
    expect(packBreakdown(2.5, [{ name: "1.25l pack", size: 1.25 }])).toBe("2 × 1.25l pack");
    expect(packToBase(3, { name: "x", size: 0.1 })).toBe(0.3);
  });
});

describe("pack-based movements", () => {
  let orgId: string | null = null;
  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  async function qty(branchId: string, ingredientId: string) {
    const s = await prisma.stockItem.findUnique({ where: { branchId_ingredientId: { branchId, ingredientId } } });
    return s ? new Decimal(s.quantity).toString() : "0";
  }

  it("a transfer entered as 3 bars moves 1,290 g at both ends and keeps the pack label", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    await prisma.ingredient.update({ where: { id: ingredient.id }, data: { unit: "g" } });
    const pack = await prisma.ingredientPack.create({
      data: { ingredientId: ingredient.id, name: "430g bar", size: 430 },
    });
    await prisma.stockItem.create({ data: { branchId: branchA.id, ingredientId: ingredient.id, quantity: 5000 } });

    const transfer = await createTransfer({
      organizationId: org.id,
      fromBranchId: branchA.id,
      toBranchId: branchB.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 3, packId: pack.id }],
    });
    expect(transfer.lines[0].quantity.toString()).toBe("1290");
    expect(transfer.lines[0].packLabel).toBe("430g bar");
    expect(transfer.lines[0].packQuantity?.toString()).toBe("3");

    await shipTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });
    expect(await qty(branchA.id, ingredient.id)).toBe("3710");
    await receiveTransfer({ transferId: transfer.id, organizationId: org.id, userId: cashier.id });
    expect(await qty(branchB.id, ingredient.id)).toBe("1290");
  });

  it("rejects a pack that belongs to a different ingredient", async () => {
    const { org, branchA, branchB, cashier, ingredient } = await createFixture();
    orgId = org.id;
    const other = await prisma.ingredient.create({
      data: { organizationId: org.id, name: "Other", unit: "g", costCentsPerUnit: 1 },
    });
    const pack = await prisma.ingredientPack.create({ data: { ingredientId: other.id, name: "1kg bag", size: 1000 } });
    await expect(
      createTransfer({
        organizationId: org.id,
        fromBranchId: branchA.id,
        toBranchId: branchB.id,
        createdById: cashier.id,
        lines: [{ ingredientId: ingredient.id, quantity: 1, packId: pack.id }],
      }),
    ).rejects.toBeInstanceOf(StockError);
  });

  it("receiving stock by pack adds base units", async () => {
    const { org, branchA, cashier, ingredient } = await createFixture();
    orgId = org.id;
    const pack = await prisma.ingredientPack.create({ data: { ingredientId: ingredient.id, name: "48pcs box", size: 48 } });
    await receiveStock({
      branchId: branchA.id,
      createdById: cashier.id,
      lines: [{ ingredientId: ingredient.id, quantity: 2, packId: pack.id }],
    });
    expect(await qty(branchA.id, ingredient.id)).toBe("96");
  });
});

describe("warehouse sheet with a pack unit", () => {
  const ING: IngredientRef = {
    id: "c1",
    name: "Cheddar Bar",
    unit: "g",
    defaultLowStockAt: null,
    packs: CHEDDAR_PACKS,
  };
  const parsedWith = (unit: string) => ({
    meta: { date: "2026-09-25", branchName: "Warehouse", countedBy: null },
    rows: [
      {
        rowNumber: 4, itemName: "Cheddar Bar", unit,
        opening: 3, received: null, transferredOut: null, wastage: null, actual: 3,
        par: null, low: null, notes: null, problems: [],
      },
    ],
    fileErrors: [],
    ignoredExampleRows: 0,
    ignoredEmptyRows: 0,
  });
  const run = (unit: string) =>
    buildPlan({
      parsed: parsedWith(unit) as never,
      activeBranchName: "Warehouse",
      ingredients: [ING],
      stock: new Map(),
      systemDay: new Map(),
      mappings: {},
      today: "2026-09-26",
    });

  it("converts counts whose Unit names a pack into grams", () => {
    const row = run("430g bar").rows[0];
    expect(row.actual).toBe(1290);
    expect(row.opening).toBe(1290);
    expect(row.warnings.join(" ")).toContain("converted to g");
  });

  it("leaves counts alone when the Unit is the base unit", () => {
    const row = run("g").rows[0];
    expect(row.actual).toBe(3);
  });
});
