import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Decimal } from "@prisma/client/runtime/library";
import { HEADERS, buildSheet, row, type Cell } from "./warehouseSheetFixture";
import {
  buildPlan,
  computeRowSteps,
  parseWarehouseSheet,
  type IngredientRef,
  type ParsedSheet,
} from "@/lib/warehouseImportCore";

const ING = (id: string, name: string, unit = "pcs", low: string | null = null): IngredientRef => ({
  id,
  name,
  unit,
  defaultLowStockAt: low,
});

const INGREDIENTS = [ING("i1", "Cream Cheese (Kg)", "kg"), ING("i2", "Cream Cheese Bar"), ING("i3", "Wintermelon 22oz"), ING("i4", "Hard Straw")];

function plan(parsed: ParsedSheet, over: Partial<Parameters<typeof buildPlan>[0]> = {}) {
  return buildPlan({
    parsed,
    activeBranchName: "Warehouse",
    ingredients: INGREDIENTS,
    stock: new Map(),
    systemDay: new Map(),
    mappings: {},
    today: "2026-09-26",
    ...over,
  });
}

describe("parseWarehouseSheet", () => {
  it("reads meta and rows, ignores the example row and blank rows, and never trusts formula columns", async () => {
    const buf = await buildSheet({
      date: "2026-09-25",
      branch: "Warehouse",
      countedBy: "Ana",
      rows: [
        row("Cream Cheese (tub)", "pk", 120, 60, 90, 2, 88, 40, 20, "e.g. only - replace with a real item"),
        row("Cream Cheese (Kg)", "kg", 10, 5, 3, 1, 11, 8, 4, "counted twice"),
        [null, null, null, null, null, null, null, null, null, null, null, null, null],
        row("Hard Straw", "pk", 0, 10, 0, 0, 10),
        row("Sago Straw", "pk", null, null, null, null, null),
        ["Legend"],
        ["Unit", "Must be pc (piece), pk (pack), or kg (kilogram)"],
      ],
    });
    const parsed = await parseWarehouseSheet(buf);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.meta).toEqual({ date: "2026-09-25", branchName: "Warehouse", countedBy: "Ana" });
    expect(parsed.ignoredExampleRows).toBe(1);
    expect(parsed.ignoredEmptyRows).toBe(1); // "Sago Straw": named, but no numbers
    expect(parsed.rows.map((r) => r.itemName)).toEqual(["Cream Cheese (Kg)", "Hard Straw"]);
    expect(parsed.rows[0]).toMatchObject({
      unit: "kg",
      opening: 10,
      received: 5,
      transferredOut: 3,
      wastage: 1,
      actual: 11,
      par: 8,
      low: 4,
      notes: "counted twice",
      problems: [],
    });
  });

  it("accepts a real date cell and numeric text like '1,200'", async () => {
    const buf = await buildSheet({
      date: new Date(Date.UTC(2026, 8, 25)),
      branch: "Warehouse",
      rows: [row("Hard Straw", "pk", "1,200", 0, 0, 0, "1200")],
    });
    const parsed = await parseWarehouseSheet(buf);
    expect(parsed.meta.date).toBe("2026-09-25");
    expect(parsed.rows[0]).toMatchObject({ opening: 1200, actual: 1200, problems: [] });
  });

  it("flags non-numeric input on the row instead of guessing", async () => {
    const buf = await buildSheet({
      date: "2026-09-25",
      branch: "Warehouse",
      rows: [row("Hard Straw", "pk", "lots", 0, 0, 0, 5)],
    });
    const parsed = await parseWarehouseSheet(buf);
    expect(parsed.rows[0].problems[0]).toMatch(/Opening Count isn't a number/);
  });

  it("rejects an edited template and non-xlsx files with a clear message", async () => {
    const renamed = await buildSheet({
      date: "2026-09-25",
      branch: "Warehouse",
      rows: [],
      headers: HEADERS.map((h) => (h.startsWith("Actual") ? "Counted" : h)),
    });
    expect((await parseWarehouseSheet(renamed)).fileErrors[0]).toMatch(/Actual Closing Count/);
    expect((await parseWarehouseSheet(Buffer.from("not a spreadsheet"))).fileErrors[0]).toMatch(/isn't a readable \.xlsx/);
  });

  const templatePath = join(process.cwd(), "public/templates/warehouse-daily-count.xlsx");
  it.skipIf(!existsSync(templatePath))("parses the warehouse template as shipped (only the example row)", async () => {
    const parsed = await parseWarehouseSheet(readFileSync(templatePath));
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.meta.branchName).toBe("Warehouse");
    expect(parsed.rows).toEqual([]);
    expect(parsed.ignoredExampleRows).toBe(1);
  });
});

describe("computeRowSteps", () => {
  const base = {
    hasStockItem: true,
    currentQuantity: new Decimal(30),
    opening: new Decimal(120),
    sheetReceived: new Decimal(60),
    sheetWastage: new Decimal(2),
    actual: new Decimal(88),
    logged: { received: new Decimal(0), wasted: new Decimal(0) },
  };

  it("posts receipts and waste, then reconciles to the physical count", () => {
    const { steps, resultingQuantity } = computeRowSteps(base);
    // 30 + 60 - 2 = 88 = actual, so no reconcile step is needed
    expect(steps.map((s) => [s.kind, s.delta.toString()])).toEqual([
      ["RECEIVE", "60"],
      ["WASTE", "-2"],
    ]);
    expect(resultingQuantity.toString()).toBe("88");
  });

  it("does not double-post what the system already logged that day", () => {
    const { steps } = computeRowSteps({
      ...base,
      currentQuantity: new Decimal(88),
      logged: { received: new Decimal(60), wasted: new Decimal(2) },
    });
    expect(steps).toEqual([]);
  });

  it("absorbs unlogged transfers into the reconcile adjustment", () => {
    // Nothing logged in-system, so the 90 shipped out is still in the balance.
    const { steps } = computeRowSteps({ ...base, currentQuantity: new Decimal(120) });
    expect(steps.map((s) => [s.kind, s.delta.toString()])).toEqual([
      ["RECEIVE", "60"],
      ["WASTE", "-2"],
      ["RECONCILE", "-90"],
    ]);
  });

  it("loads an opening balance only when the system never tracked the item", () => {
    const first = computeRowSteps({ ...base, hasStockItem: false, currentQuantity: new Decimal(0), sheetReceived: new Decimal(0), sheetWastage: new Decimal(0), actual: new Decimal(120) });
    expect(first.steps.map((s) => [s.kind, s.delta.toString()])).toEqual([["OPENING", "120"]]);
    const tracked = computeRowSteps({ ...base, hasStockItem: true, currentQuantity: new Decimal(0), sheetReceived: new Decimal(0), sheetWastage: new Decimal(0), actual: new Decimal(0) });
    expect(tracked.steps).toEqual([]);
  });

  it("caps waste at what the system holds and says so", () => {
    const { steps, warnings } = computeRowSteps({
      ...base,
      currentQuantity: new Decimal(1),
      sheetReceived: new Decimal(0),
      sheetWastage: new Decimal(5),
      actual: new Decimal(0),
    });
    expect(steps.map((s) => [s.kind, s.delta.toString()])).toEqual([["WASTE", "-1"]]);
    expect(warnings[0]).toMatch(/more than the system holds/);
  });

  it("without an actual count, applies only receipts and warns", () => {
    const { steps, warnings } = computeRowSteps({ ...base, actual: null });
    expect(steps.map((s) => s.kind)).toEqual(["RECEIVE", "WASTE"]);
    expect(warnings.some((w) => /No actual closing count/.test(w))).toBe(true);
  });
});

describe("buildPlan", () => {
  const parsedOf = async (rows: Cell[][], over: { date?: string | null; branch?: string | null } = {}) =>
    parseWarehouseSheet(
      await buildSheet({ date: over.date === undefined ? "2026-09-25" : over.date, branch: over.branch === undefined ? "Warehouse" : over.branch, rows }),
    );

  it("matches names ignoring case/punctuation, and suggests close ones instead of guessing", async () => {
    const parsed = await parsedOf([
      row("cream cheese (kg)", "kg", 0, 5, 0, 0, 5),
      row("Cream Cheese (tub)", "pk", 0, 1, 0, 0, 1),
    ]);
    const p = plan(parsed);
    expect(p.rows[0]).toMatchObject({ matchedBy: "exact", match: { id: "i1" } });
    expect(p.rows[1].match).toBeNull();
    expect(p.rows[1].needsMatch).toBe(true);
    expect(p.rows[1].suggestions.map((s) => s.id)).toEqual(expect.arrayContaining(["i1", "i2"]));
    expect(p.needsMatchRows).toBe(1);
  });

  it("uses a manual mapping for an unmatched row", async () => {
    const parsed = await parsedOf([row("Cream Cheese (tub)", "pk", 0, 1, 0, 0, 1)]);
    const rowNumber = parsed.rows[0].rowNumber;
    const p = plan(parsed, { mappings: { [String(rowNumber)]: "i2" } });
    expect(p.rows[0]).toMatchObject({ matchedBy: "manual", match: { id: "i2" }, needsMatch: false });
    expect(p.rows[0].errors).toEqual([]);
    expect(p.rows[0].steps.length).toBeGreaterThan(0);
  });

  it("blocks a sheet for the wrong branch, a future date, and a missing date", async () => {
    const wrongBranch = plan(await parsedOf([row("Hard Straw", "pk", 0, 1, 0, 0, 1)], { branch: "Main" }));
    expect(wrongBranch.blockers.join(" ")).toMatch(/for "Main" but the active branch is "Warehouse"/);
    const future = plan(await parsedOf([row("Hard Straw", "pk", 0, 1, 0, 0, 1)], { date: "2026-12-01" }));
    expect(future.blockers.join(" ")).toMatch(/in the future/);
    const noDate = plan(await parsedOf([row("Hard Straw", "pk", 0, 1, 0, 0, 1)], { date: null }));
    expect(noDate.blockers.join(" ")).toMatch(/Date at the top/);
  });

  it("errors on duplicate items and negatives, and warns on unit mismatch", async () => {
    const parsed = await parsedOf([
      row("Hard Straw", "pk", 0, 5, 0, 0, 5),
      row("hard straw", "pk", 0, 1, 0, 0, 1),
      row("Cream Cheese (Kg)", "pc", -1, 0, 0, 0, 5),
      row("Wintermelon 22oz", "kg", 0, 1, 0, 0, 1),
    ]);
    const p = plan(parsed);
    expect(p.rows[0].errors[0]).toMatch(/Same item appears on rows/);
    expect(p.rows[1].errors[0]).toMatch(/Same item appears on rows/);
    expect(p.rows[2].errors.join(" ")).toMatch(/Opening Count can't be negative/);
    expect(p.rows[3].warnings.join(" ")).toMatch(/doesn't match the system unit/);
    expect(p.errorRows).toBe(3);
  });

  it("flags transfers the system never logged, and sets thresholds only when they change", async () => {
    const parsed = await parsedOf([row("Hard Straw", "pk", 100, 0, 20, 0, 80, 200, 50)]);
    const stock = new Map([["i4", { quantity: "100", lowStockAt: "50", parLevel: "200" }]]);
    const p = plan(parsed, { stock });
    expect(p.rows[0].warnings.join(" ")).toMatch(/Sheet says 20 transferred out, the system logged 0/);
    expect(p.rows[0].steps.map((s) => [s.kind, s.delta])).toEqual([["RECONCILE", "-20"]]);
    expect(p.rows[0].policy).toBeNull(); // 50/200 already matches

    const changed = plan(await parsedOf([row("Hard Straw", "pk", 100, 0, 20, 0, 80, 300, 60)]), { stock });
    expect(changed.rows[0].policy).toEqual({ lowStockAt: "60", parLevel: "300" });
  });

  it("rejects par below low-stock without touching thresholds", async () => {
    const p = plan(await parsedOf([row("Hard Straw", "pk", 0, 0, 0, 0, 5, 10, 20)]));
    expect(p.rows[0].policy).toBeNull();
    expect(p.rows[0].warnings.join(" ")).toMatch(/Par level is below Low Stock At/);
  });
});
