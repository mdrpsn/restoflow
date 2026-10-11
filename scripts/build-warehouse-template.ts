/**
 * Builds the downloadable warehouse count template (public/templates/warehouse-daily-count.xlsx).
 * Run with: npx tsx scripts/build-warehouse-template.ts
 */
import ExcelJS from "exceljs";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

const HEADERS = [
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

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Warehouse Count");
  ws.addRow(["Warehouse Daily Inventory Count"]);
  ws.addRow(["Fill in the yellow cells only."]);
  ws.addRow(["Date:", null, null, "Branch:", "Warehouse", null, "Counted By:", null]);
  const headerRow = ws.addRow(HEADERS);
  headerRow.font = { bold: true };

  // Example row. The importer ignores any row whose note starts with "e.g." or says "replace with a real item".
  ws.addRow([
    "Cup 16oz", "pc", 200, null, 125, null,
    { formula: "C5+D5-E5-F5", result: 75 },
    null,
    { formula: 'IF(H5="","",H5-G5)', result: "" },
    null, null, null,
    "e.g. only - replace with a real item",
  ]);

  ws.addRow([]);
  ws.addRow(["Legend"]);
  ws.addRow(["Opening Count: what was on the shelf at the start of the day."]);
  ws.addRow(["Actual Closing Count: what you physically counted at the end of the day."]);
  ws.columns.forEach((c) => (c.width = 20));

  const out = join(process.cwd(), "public/templates/warehouse-daily-count.xlsx");
  mkdirSync(dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  console.log("Wrote", out);
}

main();
