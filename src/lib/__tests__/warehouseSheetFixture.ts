import ExcelJS from "exceljs";

/** Builds an in-memory .xlsx that mirrors the real "Warehouse Count" template layout. */

export const HEADERS = [
  "Item",
  "Unit (pc/pk/kg)",
  "Opening Count",
  "Received (from supplier)",
  "Transferred Out (to branches)",
  "Wastage / Adjustment",
  "Expected Closing",
  "Actual Closing Count",
  "Variance",
  "Par Level",
  "Low Stock At",
  "Reorder?",
  "Notes",
];

export type Cell = string | number | null | Date | { formula: string; result: number };

export async function buildSheet(opts: {
  date?: string | Date | null;
  branch?: string | null;
  countedBy?: string;
  rows: Cell[][];
  headers?: string[];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Warehouse Count");
  ws.addRow(["We Got Cha! - Warehouse Daily Inventory Count"]);
  ws.addRow(["Fill in the yellow cells only."]);
  ws.addRow(["Date:", opts.date ?? null, null, "Branch:", opts.branch ?? null, null, "Counted By:", opts.countedBy ?? null]);
  ws.addRow(opts.headers ?? HEADERS);
  for (const r of opts.rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** One data row in template column order; the formula columns are filled in like Excel would. */
export function row(
  item: string | null,
  unit: string | null,
  opening: number | string | null,
  received: number | string | null,
  transferredOut: number | string | null,
  wastage: number | string | null,
  actual: number | string | null,
  par: number | null = null,
  low: number | null = null,
  notes: string | null = null,
): Cell[] {
  return [
    item,
    unit,
    opening,
    received,
    transferredOut,
    wastage,
    { formula: "C5+D5-E5-F5", result: 0 },
    actual,
    { formula: "H5-G5", result: 0 },
    par,
    low,
    "OK",
    notes,
  ];
}
