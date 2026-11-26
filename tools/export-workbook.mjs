// Turns fixtures/workbook.xlsx (Drive export of the league workbook) into
// fixtures/workbook.json: { tabName: { hidden, rows: [[displayText...]] } }
// Display text is what the sheet shows ("$32.0", "UFA"), via each cell's number format.
// Run: node tools/export-workbook.mjs [in.xlsx] [out.json]   (defaults: fixtures/workbook.xlsx -> fixtures/workbook.json)
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const XLSX = createRequire(import.meta.url)("xlsx");

const [IN = "fixtures/workbook.xlsx", OUTFILE = "fixtures/workbook.json"] = process.argv.slice(2);
const wb = XLSX.readFile(IN, { cellNF: true, cellText: true, cellDates: false });
const out = {};
wb.SheetNames.forEach((name, i) => {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true });
  // trim trailing empty cells and rows
  const trimmed = rows.map(r => { let n = r.length; while (n && r[n - 1] === "") n--; return r.slice(0, n).map(String); });
  let n = trimmed.length; while (n && !trimmed[n - 1].length) n--;
  const hidden = !!(wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[i] && wb.Workbook.Sheets[i].Hidden);
  out[name] = { hidden, rows: trimmed.slice(0, n) };
});
writeFileSync(OUTFILE, JSON.stringify(out));
for (const [k, v] of Object.entries(out)) console.log(`${v.hidden ? "(hidden) " : ""}${k}: ${v.rows.length} rows x ${Math.max(0, ...v.rows.map(r => r.length))} cols`);
