import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { MovementType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyMovement, StockError } from "@/lib/stock";
import { applyWarehouseImport, previewWarehouseImport } from "@/lib/warehouseImport";
import { todayInBusinessTz } from "@/lib/warehouseImportCore";
import { createFixture, cleanupFixture } from "./testFixture";
import { buildSheet, row } from "./warehouseSheetFixture";

async function setup() {
  const fx = await createFixture();
  const warehouse = await prisma.branch.create({
    data: { organizationId: fx.org.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" },
  });
  const cheese = await prisma.ingredient.create({
    data: { organizationId: fx.org.id, name: "Cream Cheese (Kg)", unit: "kg" },
  });
  const straw = await prisma.ingredient.create({
    data: { organizationId: fx.org.id, name: "Hard Straw", unit: "pcs" },
  });
  const params = (buffer: Buffer, extra: Record<string, unknown> = {}) => ({
    organizationId: fx.org.id,
    branch: { id: warehouse.id, name: warehouse.name },
    userId: fx.cashier.id,
    fileName: "count.xlsx",
    buffer,
    mappings: {} as Record<string, string>,
    confirmSameDate: false,
    ...extra,
  });
  const qty = async (ingredientId: string) => {
    const item = await prisma.stockItem.findUnique({
      where: { branchId_ingredientId: { branchId: warehouse.id, ingredientId } },
    });
    return item ? new Decimal(item.quantity).toString() : null;
  };
  return { fx, warehouse, cheese, straw, params, qty };
}

describe("warehouse count import", () => {
  const orgIds: string[] = [];
  afterEach(async () => {
    for (const id of orgIds.splice(0)) await cleanupFixture(id);
  });

  const today = () => todayInBusinessTz();

  it("loads an opening balance for a never-tracked item, posts receipts/waste, and sets thresholds", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    const buf = await buildSheet({
      date: today(),
      branch: "Warehouse",
      countedBy: "Ana",
      rows: [row("Cream Cheese (Kg)", "kg", 10, 5, 0, 1, 14, 20, 5, "one tub cracked")],
    });

    const summary = await applyWarehouseImport(s.params(buf));
    expect(summary).toMatchObject({ rowsApplied: 1, rowsSkipped: 0, policiesSet: 1 });
    expect(summary.movements).toMatchObject({ OPENING: 1, RECEIVE: 1, WASTE: 1, RECONCILE: 0 });

    expect(await s.qty(s.cheese.id)).toBe("14");
    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { branchId_ingredientId: { branchId: s.warehouse.id, ingredientId: s.cheese.id } },
    });
    expect(new Decimal(item.lowStockAt).toString()).toBe("5");
    expect(new Decimal(item.parLevel ?? 0).toString()).toBe("20");

    const moves = await prisma.stockMovement.findMany({
      where: { branchId: s.warehouse.id, refType: "warehouse_import" },
      orderBy: { createdAt: "asc" },
    });
    expect(moves.map((m) => [m.type, new Decimal(m.quantity).toString()])).toEqual([
      [MovementType.ADJUSTMENT, "10"],
      [MovementType.RECEIVE, "5"],
      [MovementType.WASTE, "-1"],
    ]);
    expect(moves[2].note).toContain("one tub cracked");
    expect(new Set(moves.map((m) => m.refId)).size).toBe(1);

    const record = await prisma.inventoryImport.findFirstOrThrow({ where: { branchId: s.warehouse.id } });
    expect(record).toMatchObject({ countedBy: "Ana", rowsApplied: 1, importedById: s.fx.cashier.id });
  });

  it("refuses the exact same file twice, so stock can't be posted twice", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    const buf = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [row("Hard Straw", "pk", 0, 50, 0, 0, 50)],
    });
    await applyWarehouseImport(s.params(buf));

    const preview = await previewWarehouseImport(s.params(buf));
    expect(preview.plan.blockers.join(" ")).toMatch(/already imported/);
    await expect(applyWarehouseImport(s.params(buf))).rejects.toThrow(StockError);
    expect(await s.qty(s.straw.id)).toBe("50");
  });

  it("doesn't double-post receipts or waste the system already logged today", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    // System already knows: 30 on hand, then a 60 receipt and 2 waste logged today.
    await prisma.$transaction(async (tx) => {
      await applyMovement({ branchId: s.warehouse.id, ingredientId: s.cheese.id, delta: 30, type: MovementType.ADJUSTMENT, allowNegative: true }, tx);
      await applyMovement({ branchId: s.warehouse.id, ingredientId: s.cheese.id, delta: 60, type: MovementType.RECEIVE, allowNegative: true }, tx);
      await applyMovement({ branchId: s.warehouse.id, ingredientId: s.cheese.id, delta: -2, type: MovementType.WASTE, allowNegative: true }, tx);
    });
    const buf = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [row("Cream Cheese (Kg)", "kg", 30, 60, 0, 2, 88)],
    });

    const preview = await previewWarehouseImport(s.params(buf));
    expect(preview.plan.rows[0].steps).toEqual([]); // 88 already, nothing to add
    expect(preview.plan.unchangedRows).toBe(1);
    await expect(applyWarehouseImport(s.params(buf))).rejects.toThrow(/Nothing to apply/);
  });

  it("books shipped-but-unlogged transfers as a count adjustment, and says so", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    await prisma.$transaction((tx) =>
      applyMovement({ branchId: s.warehouse.id, ingredientId: s.cheese.id, delta: 120, type: MovementType.ADJUSTMENT, allowNegative: true }, tx),
    );
    const buf = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [row("Cream Cheese (Kg)", "kg", 120, 0, 90, 0, 30)],
    });

    const preview = await previewWarehouseImport(s.params(buf));
    expect(preview.plan.rows[0].warnings.join(" ")).toMatch(/Sheet says 90 transferred out, the system logged 0/);
    await applyWarehouseImport(s.params(buf));
    expect(await s.qty(s.cheese.id)).toBe("30");
    const adj = await prisma.stockMovement.findFirstOrThrow({
      where: { branchId: s.warehouse.id, refType: "warehouse_import", type: MovementType.ADJUSTMENT },
    });
    expect(new Decimal(adj.quantity).toString()).toBe("-90");
  });

  it("blocks a sheet made for a different branch", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    const buf = await buildSheet({
      date: today(),
      branch: "Main",
      rows: [row("Hard Straw", "pk", 0, 5, 0, 0, 5)],
    });
    await expect(applyWarehouseImport(s.params(buf))).rejects.toThrow(/for "Main" but the active branch is "Warehouse"/);
    expect(await s.qty(s.straw.id)).toBeNull();
  });

  it("applies the good rows and skips (never half-applies) rows with errors", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    const buf = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [
        row("Hard Straw", "pk", 0, 20, 0, 0, 20),
        row("Mystery Item", "pk", 0, 9, 0, 0, 9),
      ],
    });
    const summary = await applyWarehouseImport(s.params(buf));
    expect(summary).toMatchObject({ rowsApplied: 1, rowsSkipped: 1 });
    expect(await s.qty(s.straw.id)).toBe("20");
    const record = await prisma.inventoryImport.findFirstOrThrow({ where: { branchId: s.warehouse.id } });
    expect(JSON.stringify(record.summary)).toContain("Mystery Item");
  });

  it("makes you confirm before importing a second file for a date that was already counted", async () => {
    const s = await setup();
    orgIds.push(s.fx.org.id);
    const first = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [row("Hard Straw", "pk", 0, 20, 0, 0, 20)],
    });
    await applyWarehouseImport(s.params(first));

    // A corrected re-count of the same day.
    const second = await buildSheet({
      date: today(),
      branch: "Warehouse",
      rows: [row("Hard Straw", "pk", 0, 20, 0, 0, 18)],
    });
    await expect(applyWarehouseImport(s.params(second))).rejects.toThrow(/already imported\. Confirm/);
    const summary = await applyWarehouseImport(s.params(second, { confirmSameDate: true }));
    expect(summary.movements).toMatchObject({ RECEIVE: 0, RECONCILE: 1 }); // receipt not re-posted
    expect(await s.qty(s.straw.id)).toBe("18");
  });
});
