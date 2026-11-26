// Test fixtures: the workbook snapshot imported fresh (so tests don't depend on
// whatever the live sync has committed to data/), plus Sleeper data rebuilt
// from the snapshot's Rosters tab so it lines up with the old team tabs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importWorkbook } from "../tools/import-workbook.mjs";
const require = createRequire(import.meta.url);
export const LM = require("../lib/LeagueMath.js");
export const MU = require("../lib/Mutations.js");
export const League = require("../lib/League.js");
export const CardData = require("../lib/Card.js");

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKBOOK = JSON.parse(readFileSync(path.join(ROOT, "fixtures/workbook.json"), "utf8"));
const sl = f => JSON.parse(readFileSync(path.join(ROOT, "fixtures/sleeper", f), "utf8"));

export const clone = o => JSON.parse(JSON.stringify(o));
export function freshData() { return importWorkbook(WORKBOOK, "2026-11-25T23:00:00.000Z"); }

// Rosters tab: col i = roster_id i+1; rows 2-8 starters, 10-17 bench, 19-20 IR, 22-26 taxi
export function rostersFromSheet() {
  const R = WORKBOOK.Rosters.rows, P = WORKBOOK._Players.rows;
  const pidOf = {};
  P.forEach(r => { if (r[2] && !(r[1] in pidOf)) pidOf[r[1]] = r[0]; });
  P.forEach(r => { if (!(r[1] in pidOf)) pidOf[r[1]] = r[0]; });
  const map = Object.fromEntries(WORKBOOK["Team Map"].rows.slice(1).map(r => [r[0], r[2]]));
  const pr = {}; WORKBOOK["Team Power Rankings"].rows.slice(1).forEach(r => { pr[String(r[1]).trim().toLowerCase()] = r; });
  const out = [];
  for (let c = 0; c < R[0].length; c++) {
    const get = (a, b) => { const o = []; for (let r = a; r <= b; r++) o.push(String((R[r - 1] || [])[c] || "")); return o; };
    const pid = n => (n ? pidOf[n] || "x_" + n : "0");
    const starters = get(2, 8).map(pid), bench = get(10, 17).filter(Boolean).map(pid);
    const reserve = get(19, 20).filter(Boolean).map(pid), taxi = get(22, 26).filter(Boolean).map(pid);
    const rk = pr[String(map[String(c + 1)] || "").toLowerCase()] || [];
    const pf = Number(rk[2]) || 0;
    out.push({ roster_id: c + 1, owner_id: "u" + (c + 1), starters, reserve, taxi,
      players: starters.filter(p => p !== "0").concat(bench, reserve, taxi),
      settings: { wins: Number(rk[3]) || 0, losses: Number(rk[4]) || 0, ties: Number(rk[5]) || 0, fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100) } });
  }
  return out;
}

export function sleeperLive() {
  return {
    league: sl("league.json"),
    rosters: rostersFromSheet(),
    users: WORKBOOK["Team Map"].rows.slice(1).map(r => ({ user_id: "u" + r[0], display_name: r[1] })),
    traded: sl("league_traded_picks.json"),
  };
}

export function league(D) { return clone(League.build(D || freshData(), sleeperLive())); }

export function tabTotals(code) {
  const row = WORKBOOK[code].rows.find(r => /total payroll/i.test(r[2] || ""));
  return row.slice(3, 10).map(v => Number(String(v).replace(/[$,]/g, "")) || 0);
}
