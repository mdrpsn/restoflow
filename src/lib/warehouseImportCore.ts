import ExcelJS from "exceljs";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Pure logic for the warehouse daily-count import: reading the .xlsx template,
 * matching sheet item names to catalog ingredients, and planning which stock
 * movements a row implies. No database access here, so it's cheap to test;
 * lib/warehouseImport.ts feeds it real data and applies the result.
 */

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 2000;
const MAX_SCAN_ROWS = 5000;
const SHEET_NAME = "Warehouse Count";
const TOLERANCE = new Decimal("0.0001");

// The business runs in the Philippines (UTC+8, no DST). Sheet dates are calendar days,
// so "what did the system log that day" uses PHT day boundaries.
const BUSINESS_TZ_OFFSET = "+08:00";

export function todayInBusinessTz(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function dayRangeUtc(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00${BUSINESS_TZ_OFFSET}`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

// ---------------------------------------------------------------- parsing

export type SheetMeta = { date: string | null; branchName: string | null; countedBy: string | null };

export type ParsedRow = {
  rowNumber: number;
  itemName: string;
  unit: string | null;
  opening: number | null;
  received: number | null;
  transferredOut: number | null;
  wastage: number | null;
  actual: number | null;
  par: number | null;
  low: number | null;
  notes: string | null;
  problems: string[];
};

export type ParsedSheet = {
  meta: SheetMeta;
  rows: ParsedRow[];
  fileErrors: string[];
  ignoredExampleRows: number;
  ignoredEmptyRows: number;
};

type ColumnKey =
  | "item"
  | "unit"
  | "opening"
  | "received"
  | "transferredOut"
  | "wastage"
  | "actual"
  | "par"
  | "low"
  | "notes";

const HEADERS: { key: ColumnKey; test: RegExp; required: boolean; label: string }[] = [
  { key: "item", test: /^item$/, required: true, label: "Item" },
  { key: "unit", test: /^unit/, required: false, label: "Unit" },
  { key: "opening", test: /^opening/, required: true, label: "Opening Count" },
  { key: "received", test: /^received/, required: true, label: "Received (from supplier)" },
  { key: "transferredOut", test: /^transferred/, required: true, label: "Transferred Out (to branches)" },
  { key: "wastage", test: /^wastage/, required: true, label: "Wastage / Adjustment" },
  { key: "actual", test: /^actual/, required: true, label: "Actual Closing Count" },
  { key: "par", test: /^par level/, required: false, label: "Par Level" },
  { key: "low", test: /^low stock/, required: false, label: "Low Stock At" },
  { key: "notes", test: /^notes?$/, required: false, label: "Notes" },
];

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v instanceof Date) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) return obj.result ?? null;
    if (Array.isArray(obj.richText)) return (obj.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in obj) return obj.text ?? null;
    if ("error" in obj) return String(obj.error);
    return null;
  }
  return v ?? null;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cellValue(cell);
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function toNumber(raw: unknown): { value: number | null; bad: boolean } {
  if (raw === null || raw === undefined) return { value: null, bad: false };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: round4(raw), bad: false } : { value: null, bad: true };
  }
  if (typeof raw === "string") {
    const t = raw.trim().replace(/,/g, "");
    if (t === "") return { value: null, bad: false };
    const n = Number(t);
    return Number.isFinite(n) ? { value: round4(n), bad: false } : { value: null, bad: true };
  }
  return { value: null, bad: true };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function toIsoDate(raw: unknown): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    // exceljs returns date cells as UTC midnight of the calendar day.
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (us) return validDate(Number(us[3]), Number(us[1]), Number(us[2]));
  }
  return null;
}

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const META_LABELS: { key: keyof SheetMeta; test: RegExp }[] = [
  { key: "date", test: /^date:?$/ },
  { key: "branchName", test: /^branch:?$/ },
  { key: "countedBy", test: /^counted by:?$/ },
];

export async function parseWarehouseSheet(input: Buffer | Uint8Array): Promise<ParsedSheet> {
  const meta: SheetMeta = { date: null, branchName: null, countedBy: null };
  const fail = (msg: string): ParsedSheet => ({
    meta,
    rows: [],
    fileErrors: [msg],
    ignoredExampleRows: 0,
    ignoredEmptyRows: 0,
  });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(input) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    return fail("That file isn't a readable .xlsx workbook. Use the warehouse count template.");
  }

  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0];
  if (!ws) return fail("The workbook has no sheets.");

  // Locate the header row by its "Item" cell, then map every other column by
  // header text, so inserting or reordering columns doesn't silently misread data.
  let headerRow = 0;
  const scanLimit = Math.min(ws.rowCount, 30);
  for (let r = 1; r <= scanLimit && !headerRow; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      if (!headerRow && cellText(cell).toLowerCase() === "item") headerRow = r;
    });
  }
  if (!headerRow) return fail('Couldn\'t find the header row (a cell reading "Item"). Was the template edited?');

  const columns = new Map<ColumnKey, number>();
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const text = cellText(cell).toLowerCase();
    for (const h of HEADERS) {
      if (!columns.has(h.key) && h.test.test(text)) columns.set(h.key, col);
    }
  });
  const missing = HEADERS.filter((h) => h.required && !columns.has(h.key)).map((h) => h.label);
  if (missing.length) return fail(`Template columns are missing or renamed: ${missing.join(", ")}.`);

  // Meta block above the header: a label cell ("Date:") with its value in the
  // next non-empty cell to the right.
  for (let r = 1; r < headerRow; r++) {
    const cells: { text: string; raw: unknown }[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      cells.push({ text: cellText(cell), raw: cellValue(cell) });
    });
    cells.forEach((cell, i) => {
      const label = META_LABELS.find((l) => l.test.test(cell.text.toLowerCase()));
      if (!label) return;
      const value = cells.slice(i + 1).find((c) => c.text !== "" && !META_LABELS.some((l) => l.test.test(c.text.toLowerCase())));
      if (!value) return;
      if (label.key === "date") meta.date = toIsoDate(value.raw);
      else meta[label.key] = value.text;
    });
  }

  const rows: ParsedRow[] = [];
  let ignoredExampleRows = 0;
  let ignoredEmptyRows = 0;
  const lastRow = Math.min(ws.rowCount, headerRow + MAX_SCAN_ROWS);
  const at = (row: ExcelJS.Row, key: ColumnKey) => {
    const col = columns.get(key);
    return col ? row.getCell(col) : null;
  };

  for (let r = headerRow + 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const raw = (key: ColumnKey) => {
      const c = at(row, key);
      return c ? cellValue(c) : null;
    };
    const text = (key: ColumnKey) => {
      const c = at(row, key);
      return c ? cellText(c) : "";
    };

    const itemName = text("item");
    const notes = text("notes");
    // The template's column guide sits below the data rows, under a "Legend" heading.
    if (itemName.toLowerCase() === "legend") break;

    const numericKeys: ColumnKey[] = ["opening", "received", "transferredOut", "wastage", "actual", "par", "low"];
    const anyNumeric = numericKeys.some((k) => text(k) !== "");
    if (!itemName && !anyNumeric && !text("unit") && !notes) continue;

    if (/^e\.g\./i.test(notes) || /replace with a real item/i.test(notes)) {
      ignoredExampleRows++;
      continue;
    }

    // Nothing here can produce a stock change, so it isn't a data row.
    if (!anyNumeric) {
      if (itemName) ignoredEmptyRows++;
      continue;
    }

    const problems: string[] = [];
    if (!itemName) problems.push("Item name is missing");

    const num = (key: ColumnKey, label: string) => {
      const { value, bad } = toNumber(raw(key));
      if (bad) problems.push(`${label} isn't a number ("${text(key)}")`);
      else if (value !== null && Math.abs(value) > 1_000_000_000) problems.push(`${label} is unrealistically large`);
      return value;
    };

    rows.push({
      rowNumber: r,
      itemName,
      unit: text("unit") || null,
      opening: num("opening", "Opening Count"),
      received: num("received", "Received"),
      transferredOut: num("transferredOut", "Transferred Out"),
      wastage: num("wastage", "Wastage / Adjustment"),
      actual: num("actual", "Actual Closing Count"),
      par: num("par", "Par Level"),
      low: num("low", "Low Stock At"),
      notes: notes || null,
      problems,
    });

    if (rows.length > MAX_IMPORT_ROWS) {
      return fail(`Too many rows (limit ${MAX_IMPORT_ROWS}). Split the count into smaller files.`);
    }
  }

  return { meta, rows, fileErrors: [], ignoredExampleRows, ignoredEmptyRows };
}

// --------------------------------------------------------------- matching

export type IngredientRef = {
  id: string;
  name: string;
  unit: string;
  defaultLowStockAt: string | null;
  /** Packs the ingredient is bought in. A sheet Unit equal to a pack name means the row's numbers are pack counts. */
  packs?: { name: string; size: number }[];
};

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

type IndexedIngredient = { ref: IngredientRef; norm: string; tokens: Set<string> };

function indexIngredients(ingredients: IngredientRef[]): IndexedIngredient[] {
  return ingredients.map((ref) => {
    const norm = normalizeName(ref.name);
    return { ref, norm, tokens: new Set(norm.split(" ").filter(Boolean)) };
  });
}

function suggest(name: string, index: IndexedIngredient[], limit = 5): IngredientRef[] {
  const q = normalizeName(name);
  if (!q) return [];
  const qTokens = new Set(q.split(" "));
  const scored: { ref: IngredientRef; score: number }[] = [];
  for (const item of index) {
    let shared = 0;
    for (const t of qTokens) if (item.tokens.has(t)) shared++;
    if (shared === 0) continue;
    const union = qTokens.size + item.tokens.size - shared;
    let score = shared / union;
    if (item.norm.includes(q) || q.includes(item.norm)) score += 0.25;
    if (score >= 0.34) scored.push({ ref: item.ref, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.ref);
}

type UnitClass = "count" | "kg" | "g" | "l" | "ml" | "unknown";

function unitClass(unit: string | null | undefined): UnitClass {
  const u = (unit ?? "").trim().toLowerCase().replace(/\./g, "");
  if (!u) return "unknown";
  if (["kg", "kilo", "kilos", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["g", "gram", "grams", "gm"].includes(u)) return "g";
  if (["l", "lt", "liter", "liters", "litre", "litres"].includes(u)) return "l";
  if (["ml", "cc", "milliliter", "milliliters"].includes(u)) return "ml";
  return "count"; // pc, pcs, pk, pack, box, bottle, tub, can, sachet, ...
}

// ---------------------------------------------------------------- planning

export type StockSnapshot = { quantity: string; lowStockAt: string; parLevel: string | null };
export type SystemDay = { received: string; wasted: string; transferredOut: string };

export type StepKind = "OPENING" | "RECEIVE" | "SURPLUS" | "WASTE" | "RECONCILE";
export type PlanStep = { kind: StepKind; delta: string };

/**
 * What one sheet row implies, given the balance the system holds right now
 * and what the system itself already logged that day. Movements the system
 * already recorded (a PO receipt, a waste entry) are subtracted from what the
 * sheet reports, so importing never double-posts them; the final RECONCILE
 * step then sets the balance to the physically counted amount.
 *
 * "Transferred out" is deliberately never posted: transfers have their own
 * ship/receive workflow. If staff shipped stock without logging it, the gap
 * lands in the RECONCILE adjustment, which is the honest place for it.
 */
export function computeRowSteps(input: {
  hasStockItem: boolean;
  currentQuantity: Decimal;
  opening: Decimal;
  sheetReceived: Decimal;
  sheetWastage: Decimal;
  actual: Decimal | null;
  logged: { received: Decimal; wasted: Decimal };
}): { steps: { kind: StepKind; delta: Decimal }[]; resultingQuantity: Decimal; warnings: string[] } {
  const steps: { kind: StepKind; delta: Decimal }[] = [];
  const warnings: string[] = [];
  let cur = input.currentQuantity;

  if (!input.hasStockItem && input.opening.gt(0)) {
    steps.push({ kind: "OPENING", delta: input.opening });
    cur = cur.plus(input.opening);
  }

  const receive = input.sheetReceived.minus(input.logged.received);
  if (receive.gt(0)) {
    steps.push({ kind: "RECEIVE", delta: receive });
    cur = cur.plus(receive);
  } else if (receive.lt(0)) {
    warnings.push(
      `System already logged ${input.logged.received.toString()} received today, more than the sheet's ${input.sheetReceived.toString()}`,
    );
  }

  if (input.sheetWastage.lt(0)) {
    const up = input.sheetWastage.neg();
    steps.push({ kind: "SURPLUS", delta: up });
    cur = cur.plus(up);
  } else if (input.sheetWastage.gt(0)) {
    const waste = input.sheetWastage.minus(input.logged.wasted);
    if (waste.gt(0)) {
      const applied = Decimal.min(waste, cur);
      if (applied.gt(0)) {
        steps.push({ kind: "WASTE", delta: applied.neg() });
        cur = cur.minus(applied);
      }
      if (applied.lt(waste)) {
        warnings.push(
          `Wastage of ${waste.toString()} is more than the system holds; recorded ${applied.toString()}, the rest is absorbed by the count adjustment`,
        );
      }
    } else if (waste.lt(0)) {
      warnings.push(
        `System already logged ${input.logged.wasted.toString()} wasted today, more than the sheet's ${input.sheetWastage.toString()}`,
      );
    }
  }

  if (input.actual) {
    const delta = input.actual.minus(cur);
    if (!delta.isZero()) steps.push({ kind: "RECONCILE", delta });
    cur = input.actual;
  } else {
    warnings.push("No actual closing count, so stock won't be reconciled (only received/wastage are applied)");
  }

  return { steps, resultingQuantity: cur, warnings };
}

export type PlanRow = {
  rowNumber: number;
  itemName: string;
  unit: string | null;
  opening: number | null;
  received: number | null;
  transferredOut: number | null;
  wastage: number | null;
  actual: number | null;
  par: number | null;
  low: number | null;
  notes: string | null;
  match: { id: string; name: string; unit: string } | null;
  matchedBy: "exact" | "manual" | null;
  suggestions: { id: string; name: string; unit: string }[];
  needsMatch: boolean;
  systemQuantity: string | null;
  systemDay: SystemDay | null;
  steps: PlanStep[];
  resultingQuantity: string | null;
  policy: { lowStockAt: string; parLevel: string | null } | null;
  errors: string[];
  warnings: string[];
};

export type Plan = {
  meta: SheetMeta;
  rows: PlanRow[];
  blockers: string[];
  warnings: string[];
  readyRows: number;
  needsMatchRows: number;
  errorRows: number;
  unchangedRows: number;
};

const ZERO_DAY: SystemDay = { received: "0", wasted: "0", transferredOut: "0" };

const dec = (n: number | null | undefined) => new Decimal(n ?? 0);

export function buildPlan(input: {
  parsed: ParsedSheet;
  activeBranchName: string;
  ingredients: IngredientRef[];
  stock: Map<string, StockSnapshot>;
  systemDay: Map<string, SystemDay>;
  mappings: Record<string, string>;
  today: string;
}): Plan {
  const { parsed, ingredients } = input;
  const blockers: string[] = [...parsed.fileErrors];
  const warnings: string[] = [];

  const { date, branchName } = parsed.meta;
  if (!parsed.fileErrors.length) {
    if (!date) blockers.push("The Date at the top of the sheet is empty or isn't a valid date.");
    else if (date > input.today) blockers.push(`The sheet date ${date} is in the future.`);
    else {
      const ageDays = Math.round((Date.parse(input.today) - Date.parse(date)) / 86_400_000);
      if (ageDays > 7) warnings.push(`This count is dated ${date}, ${ageDays} days ago. Double-check it's the right file.`);
    }
    if (!branchName) blockers.push("The Branch at the top of the sheet is empty.");
    else if (normalizeName(branchName) !== normalizeName(input.activeBranchName)) {
      blockers.push(
        `This sheet is for "${branchName}" but the active branch is "${input.activeBranchName}". Switch branch at the top of the page, or fix the sheet.`,
      );
    }
    if (!parsed.rows.length) blockers.push("No item rows found. Fill in the yellow cells (the example row is ignored).");
    if (parsed.ignoredExampleRows > 0) warnings.push("The example row was ignored.");
    if (parsed.ignoredEmptyRows > 0) {
      warnings.push(
        `${parsed.ignoredEmptyRows} row(s) had an item name but no numbers, so they were skipped. Fill in a count if they should be included.`,
      );
    }
  }

  const index = indexIngredients(ingredients);
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const exact = new Map<string, IndexedIngredient[]>();
  for (const item of index) {
    const list = exact.get(item.norm) ?? [];
    list.push(item);
    exact.set(item.norm, list);
  }

  const rows: PlanRow[] = parsed.rows.map((row) => {
    const errors = [...row.problems];
    const rowWarnings: string[] = [];

    let ref: IngredientRef | null = null;
    let matchedBy: PlanRow["matchedBy"] = null;
    const mapped = input.mappings[String(row.rowNumber)];
    if (mapped) {
      ref = byId.get(mapped) ?? null;
      matchedBy = ref ? "manual" : null;
      if (!ref) errors.push("The item you picked no longer exists");
    } else if (row.itemName) {
      const hits = exact.get(normalizeName(row.itemName)) ?? [];
      if (hits.length === 1) {
        ref = hits[0].ref;
        matchedBy = "exact";
      }
    }

    const suggestions = !ref && row.itemName ? suggest(row.itemName, index) : [];
    const needsMatch = !ref && !mapped && row.problems.every((p) => p !== "Item name is missing");
    if (needsMatch) errors.push("Not matched to a catalog item, pick the right one");

    const nonNegative: [number | null, string][] = [
      [row.opening, "Opening Count"],
      [row.received, "Received"],
      [row.transferredOut, "Transferred Out"],
      [row.actual, "Actual Closing Count"],
      [row.par, "Par Level"],
      [row.low, "Low Stock At"],
    ];
    for (const [value, label] of nonNegative) {
      if (value !== null && value < 0) errors.push(`${label} can't be negative`);
    }
    if (row.wastage !== null && row.wastage < 0) {
      rowWarnings.push("Negative wastage is treated as a surplus correction (adds stock)");
    }

    // Numbers on a sheet row whose Unit names one of the ingredient's packs ("bar 430g") are pack
    // counts; stock is only held in the base unit, so they are converted here, once.
    const pack =
      ref && row.unit
        ? ref.packs?.find((p) => normalizeName(p.name) === normalizeName(row.unit!)) ?? null
        : null;
    const conv = (n: number | null) => (n === null || !pack ? n : Math.round(n * pack.size * 1000) / 1000);
    if (pack) {
      rowWarnings.push(`Counts are in "${pack.name}" (1 = ${pack.size} ${ref!.unit}); converted to ${ref!.unit}`);
    }

    if (ref && row.unit && !pack) {
      const a = unitClass(row.unit);
      const b = unitClass(ref.unit);
      if (a !== "unknown" && b !== "unknown" && a !== b) {
        rowWarnings.push(`Sheet unit "${row.unit}" doesn't match the system unit "${ref.unit}". Check the count is in the system's unit`);
      }
    }

    return {
      rowNumber: row.rowNumber,
      itemName: row.itemName,
      unit: row.unit,
      opening: conv(row.opening),
      received: conv(row.received),
      transferredOut: conv(row.transferredOut),
      wastage: conv(row.wastage),
      actual: conv(row.actual),
      par: conv(row.par),
      low: conv(row.low),
      notes: row.notes,
      match: ref ? { id: ref.id, name: ref.name, unit: ref.unit } : null,
      matchedBy,
      suggestions: suggestions.map((s) => ({ id: s.id, name: s.name, unit: s.unit })),
      needsMatch,
      systemQuantity: null,
      systemDay: null,
      steps: [],
      resultingQuantity: null,
      policy: null,
      errors,
      warnings: rowWarnings,
    };
  });

  // The same catalog item on two rows would post its movements twice.
  const rowsByIngredient = new Map<string, PlanRow[]>();
  for (const r of rows) {
    if (!r.match) continue;
    const list = rowsByIngredient.get(r.match.id) ?? [];
    list.push(r);
    rowsByIngredient.set(r.match.id, list);
  }
  for (const list of rowsByIngredient.values()) {
    if (list.length < 2) continue;
    const numbers = list.map((r) => r.rowNumber).join(", ");
    for (const r of list) r.errors.push(`Same item appears on rows ${numbers}. Combine them into one row`);
  }

  for (const r of rows) {
    if (r.errors.length || !r.match) continue;
    const stock = input.stock.get(r.match.id);
    const day = input.systemDay.get(r.match.id) ?? ZERO_DAY;
    r.systemQuantity = stock ? stock.quantity : null;
    r.systemDay = day;

    const { steps, resultingQuantity, warnings: stepWarnings } = computeRowSteps({
      hasStockItem: !!stock,
      currentQuantity: new Decimal(stock?.quantity ?? 0),
      opening: dec(r.opening),
      sheetReceived: dec(r.received),
      sheetWastage: dec(r.wastage),
      actual: r.actual === null ? null : dec(r.actual),
      logged: { received: new Decimal(day.received), wasted: new Decimal(day.wasted) },
    });
    r.steps = steps.map((s) => ({ kind: s.kind, delta: s.delta.toString() }));
    r.resultingQuantity = resultingQuantity.toString();
    r.warnings.push(...stepWarnings);

    // Does the system's view of the day agree with the sheet's?
    if (stock && r.opening !== null) {
      const expectedBefore = dec(r.opening)
        .plus(day.received)
        .minus(day.transferredOut)
        .minus(day.wasted);
      if (expectedBefore.minus(stock.quantity).abs().gt(TOLERANCE)) {
        r.warnings.push(
          `System holds ${stock.quantity}, but the sheet's opening ${r.opening} adjusted for what the system logged today would be ${expectedBefore.toString()}`,
        );
      }
    }
    if (r.transferredOut !== null && dec(r.transferredOut).minus(day.transferredOut).abs().gt(TOLERANCE)) {
      r.warnings.push(
        `Sheet says ${r.transferredOut} transferred out, the system logged ${day.transferredOut}. Any unlogged transfer shows up as a count adjustment`,
      );
    }

    if (r.low !== null || r.par !== null) {
      const existingLow = stock ? stock.lowStockAt : (ingredientDefaultLow(byId.get(r.match.id)) ?? "0");
      const low = r.low !== null ? new Decimal(r.low) : new Decimal(existingLow);
      const par = r.par !== null ? new Decimal(r.par) : stock?.parLevel != null ? new Decimal(stock.parLevel) : null;
      if (par && par.lt(low)) {
        r.warnings.push("Par level is below Low Stock At, so thresholds were not changed");
      } else {
        const changed =
          !stock || !new Decimal(stock.lowStockAt).eq(low) || (par ? stock.parLevel === null || !new Decimal(stock.parLevel).eq(par) : stock.parLevel !== null);
        if (changed) r.policy = { lowStockAt: low.toString(), parLevel: par ? par.toString() : null };
      }
    }
  }

  const isUnchanged = (r: PlanRow) => !r.errors.length && r.match !== null && r.steps.length === 0 && r.policy === null;
  return {
    meta: parsed.meta,
    rows,
    blockers,
    warnings,
    readyRows: rows.filter((r) => !r.errors.length && r.match && (r.steps.length > 0 || r.policy)).length,
    needsMatchRows: rows.filter((r) => r.needsMatch).length,
    errorRows: rows.filter((r) => r.errors.length && !r.needsMatch).length,
    unchangedRows: rows.filter(isUnchanged).length,
  };
}

function ingredientDefaultLow(ref: IngredientRef | undefined): string | null {
  return ref?.defaultLowStockAt ?? null;
}
