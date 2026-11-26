// One-time import: the old Google Sheet -> data/*.json.
//   1. Download the workbook as .xlsx into fixtures/workbook.xlsx
//   2. npm run fixtures        (xlsx -> fixtures/workbook.json)
//   3. npm run import -- --force [workbook.json]
// Reads: Master list, every team tab's Cap Hold rows and Cash Considerations,
// Team Map, Team Power Rankings, League Log, Rules, _Players, _Txn Seen.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const League = require("../lib/League.js");
const MU = require("../lib/Mutations.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// "$32.0" -> 32, "UFA"/"RFA" stay, blank -> null
export function parseSal(s) {
  s = String(s == null ? "" : s).trim();
  if (!s) return null;
  if (/^(UFA|RFA)$/i.test(s)) return s.toUpperCase();
  const t = s.replace(/[$,\s]/g, "");
  const neg = /^-|^\(.*\)$/.test(t);
  const core = t.replace(/^-|^\(|\)$/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(core)) return null;
  return neg ? -Number(core) : Number(core);
}

// "11/25/2026 1:22 PM" -> ISO (read as US Pacific, where the sheet's clock was)
function parseWhen(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M))?$/i);
  if (!m) return "";
  let h = Number(m[4] || 0) % 12;
  if (/pm/i.test(m[7] || "")) h += 12;
  // Pacific Standard Time (UTC-8) in Nov-Mar; close enough for a log timestamp
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h + 8, +(m[5] || 0), +(m[6] || 0)));
  return d.toISOString();
}

export function importWorkbook(W, now = new Date().toISOString()) {
  const tabs = MU.TEAM_CODES.filter(c => W[c]);

  // Contracts: Master list A:R (header row 1). Column S (roster count) is computed live now.
  const M = W["Master list"].rows;
  const hdr = M[0];
  const yearCols = hdr.map((h, i) => (/^\d{4}-\d{2}$/.test(String(h).trim()) ? i : -1)).filter(i => i >= 0);
  const n = Math.floor(yearCols.length / 2);
  const salCols = yearCols.slice(0, n), stCols = yearCols.slice(n, 2 * n);
  const detCol = hdr.findIndex(h => /contract details/i.test(h));
  const rows = [];
  M.slice(1).forEach(r => {
    const name = String(r[0] || "").trim();
    if (!name) return;
    rows.push({
      id: rows.length + 1, n: name, nba: String(r[1] || "").trim() || "Z",
      sal: salCols.map(c => parseSal(r[c])), st: stCols.map(c => String(r[c] || "").trim().toUpperCase()),
      det: detCol >= 0 ? String(r[detCol] || "") : "",
    });
  });
  const contracts = { seasons: salCols.map(c => String(hdr[c]).trim()), rows };

  // Cap holds: every named "Cap Hold" row on the team tabs
  const holds = [];
  tabs.forEach(code => W[code].rows.forEach(r => {
    const name = String(r[1] || "").trim();
    if (String(r[0]).trim().toLowerCase() === "cap hold" && name) {
      holds.push({ id: holds.length + 1, code, name: MU.holdName(name), added: now, note: "Imported from the " + code + " tab" });
    }
  }));

  // Cash: one opening-balance row per team with a non-zero Cash Considerations value
  const cash = [];
  tabs.forEach(code => {
    const row = W[code].rows.find(r => r.some(v => /cash considerations/i.test(v)));
    if (!row) return;
    const i = row.findIndex(v => /cash considerations/i.test(v));
    const amt = parseSal(row[i + 1]);
    if (typeof amt === "number" && amt !== 0) cash.push({ id: cash.length + 1, date: now, season: contracts.seasons[0], code, amt, note: "Opening balance", ref: "" });
  });

  // Teams: Team Map (roster_id -> team, tab code) + rank from Team Power Rankings
  const PR = W["Team Power Rankings"].rows;
  const ph = PR[0].map(h => String(h).trim().toLowerCase());
  const rankOf = {};
  PR.slice(1).forEach(r => { const nm = String(r[ph.indexOf("team name")] || "").trim().toLowerCase(); const v = Number(r[ph.indexOf("ranking")]); if (nm) rankOf[nm] = r[ph.indexOf("ranking")] !== "" && isFinite(v) ? v : null; });
  const teams = W["Team Map"].rows.slice(1)
    .filter(r => String(r[3] || "").trim())
    .map(r => ({ rid: Number(r[0]), code: String(r[3]).trim(), name: String(r[2]).trim(), rank: rankOf[String(r[2]).trim().toLowerCase()] ?? null }));

  // League Log, newest first (as in the sheet)
  const log = W["League Log"].rows.slice(1)
    .filter(r => r[1] || r[3])
    .map(r => ({ ts: parseWhen(r[0]), type: String(r[1] || ""), teams: String(r[2] || ""), players: String(r[3] || ""), details: String(r[4] || ""), status: String(r[5] || "") }));

  const rules = { rows: W.Rules.rows.map(r => { const o = r.map(v => String(v).trim()); while (o.length && !o[o.length - 1]) o.pop(); return o; }) };

  const players = {};
  W._Players.rows.forEach(r => { if (r[0]) players[String(r[0])] = r[2] ? [String(r[1]), String(r[2])] : [String(r[1])]; });

  // Sleeper transactions the sheet's sync already handled
  const seen = (W["_Txn Seen"] ? W["_Txn Seen"].rows : []).map(r => String(r[0])).filter(Boolean);
  // The sheet only remembered recent transaction ids, so the sync ignores anything
  // that went through before the sheet's last sync (League Log I1): it was already handled.
  const lastSynced = parseWhen((W["League Log"].rows[0] || [])[8]) || now;
  const state = { started: true, since: lastSynced, seen, playersAt: now, espnAt: "", lastChange: now, importedAt: now };

  return { contracts, holds, cash, teams, log, adminLog: [{ ts: now, who: "import", action: "Import", details: `Imported ${rows.length} contracts, ${holds.length} cap holds, ${cash.length} cash balances, ${log.length} log entries from the Google Sheet` }],
    rules, players, espn: {}, txns: [], state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(ROOT, "data");
  if (existsSync(path.join(dir, "contracts.json")) && !process.argv.includes("--force")) {
    console.error("data/ already has league data. Re-run with --force to replace it (commissioner edits since the import would be lost).");
    process.exit(1);
  }
  const src = process.argv.slice(2).find(x => !x.startsWith("--")) || path.join(ROOT, "fixtures/workbook.json");
  const W = JSON.parse(readFileSync(src, "utf8"));
  const D = importWorkbook(W);
  mkdirSync(dir, { recursive: true });
  for (const [k, f] of Object.entries(League.FILES)) writeFileSync(path.join(dir, f), League.toJson(D[k]));
  console.log(D.adminLog[0].details);
}
