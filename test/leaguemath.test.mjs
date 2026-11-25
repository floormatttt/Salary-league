// Smoke tests for lib/LeagueMath.js on a tiny hand-built league.
// Full fixtures built from the workbook export come later (fixtures/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const LM = createRequire(import.meta.url)("../lib/LeagueMath.js");

const yrs = ["2026-27", "2027-28", "2028-29", "2029-30", "2030-31", "2031-32", "2032-33"];
const sal = (...v) => yrs.map((_, i) => (i < v.length ? v[i] : null));
const st = (s0) => yrs.map((_, i) => (i === 0 ? s0 || "" : ""));

function league() {
  return {
    season: "2026-27", seasons: yrs,
    teams: [
      { rid: "1", code: "AAA", name: "Alpha" },
      { rid: "2", code: "BBB", name: "Beta" },
    ],
    contracts: [
      { r: 2, n: "Big Star", hold: false, sal: sal(40, 40), st: st("MAX") },
      { r: 3, n: "Role Guy", hold: false, sal: sal(10, 10), st: st() },
      { r: 4, n: "Filler", hold: false, sal: sal(100), st: st() },
      { r: 5, n: "Old Guy (cap hold)", hold: true, sal: sal(5), st: st("HOLD") },
    ],
    rosters: {
      1: { starters: [{ pid: "a", name: "Big Star" }, { pid: "f", name: "Filler" }], bench: [], ir: [], taxi: [] },
      2: { starters: [{ pid: "b", name: "Role Guy" }], bench: [], ir: [], taxi: [] },
    },
    holds: [{ code: "AAA", name: "Old Guy (cap hold)" }],
    cash: [{ season: "2026-27", code: "AAA", amt: 2 }],
    limits: { hardCap: 300, cash: 10, maxes: 2, supermaxes: 1, activeRoster: 15 },
  };
}

test("tiers use the Rules tab boundaries", () => {
  assert.equal(LM.tierOf(150).key, "cap");
  assert.equal(LM.tierOf(150.1).key, "first");
  assert.equal(LM.tierOf(250.1).key, "tax");
  assert.equal(LM.tierOf(300.1).key, "over");
});

test("payroll = roster + holds + current-season cash", () => {
  const b = LM.teamBook(league(), "AAA");
  assert.equal(b.payroll[0], 40 + 100 + 5 + 2);
  assert.equal(b.payroll[1], 40);
  assert.equal(b.maxes, 1);
});

test("under-cap teams have no matching limit", () => {
  const L = league();
  // Alpha is at 147 and Beta at 10, so both are under the cap
  const ok = LM.evaluateTrade(L, { teams: ["AAA", "BBB"], moves: [
    { type: "player", name: "Big Star", from: "AAA", to: "BBB" },
  ] });
  assert.equal(ok.legal, true, ok.problems.join("; "));
});

test("cash balance must stay within ±$10M", () => {
  const r = LM.evaluateTrade(league(), { teams: ["AAA", "BBB"], moves: [
    { type: "cash", amt: 9, from: "AAA", to: "BBB" }, // AAA goes 2 -> 11
  ] });
  assert.equal(r.legal, false);
  assert.match(r.problems.join(" "), /cash balance/);
});

test("can't trade a player you don't have", () => {
  const r = LM.evaluateTrade(league(), { teams: ["AAA", "BBB"], moves: [
    { type: "player", name: "Role Guy", from: "AAA", to: "BBB" },
  ] });
  assert.equal(r.legal, false);
});
