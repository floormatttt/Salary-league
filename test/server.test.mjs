// Server code (src/*.gs) against the workbook snapshot.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeGas, WORKBOOK } from "./harness.mjs";
const LM = createRequire(import.meta.url)("../lib/LeagueMath.js");

const clone = o => JSON.parse(JSON.stringify(o));
const league = gas => clone((gas || makeGas()).ctx.getLeague());
const tabTotals = code => {
  const row = WORKBOOK[code].rows.find(r => /total payroll/i.test(r[2] || ""));
  return row.slice(3, 10).map(v => Number(String(v).replace(/[$,]/g, "")) || 0);
};
const MEM_MISSING = ["Kalkbrenner", "Dunn", "Carter", "Bona", "Diawara", "Reed"];

describe("getLeague", () => {
  const L = league();

  test("shape", () => {
    assert.equal(L.season, "2026-27");
    assert.equal(L.seasons.length, 7);
    assert.equal(L.teams.length, 30, "32 rosters, 2 unknown");
    assert.ok(L.contracts.length > 400);
    assert.deepEqual(L.limits, { activeRoster: 15, hardCap: 300, cash: 10, maxes: 2, supermaxes: 1 });
    const c = L.contracts.find(x => x.n === "Jalen Johnson");
    assert.deepEqual(c.sal, [32, 43, 40, "UFA", null, null, null]);
    assert.equal(c.r, 2);
  });

  test("cash opening balances come from the team tabs", () => {
    const want = { ATL: -10, CHA: 2, DEN: 10, DET: 10, LAC: -10, LAL: 5, MEM: 8, MIA: 6, PHI: -4, TOR: -3, UTA: -1 };
    const got = Object.fromEntries(L.cash.map(x => [x.code, x.amt]));
    assert.deepEqual(got, want);
  });

  test("payroll matches every team tab's Total Payroll for all 7 seasons (MEM tab is missing 6 players)", () => {
    for (const t of L.teams) {
      const b = LM.teamBook(L, t.code);
      if (t.code === "MEM") {
        assert.notDeepEqual(b.payroll, tabTotals("MEM"));
        const names = b.players.map(p => p.name).join(" ");
        MEM_MISSING.forEach(n => assert.match(names, new RegExp(n)));
        continue;
      }
      assert.deepEqual(b.payroll, tabTotals(t.code), t.code);
    }
  });

  test("players without a Master list row are flagged and count $0", () => {
    assert.ok(LM.teamBook(L, "HOU").missing.includes("Thomas Bryant"));
    assert.ok(LM.teamBook(L, "GSW").missing.includes("Jabari Walker"));
  });

  test("draft picks: next 3 drafts, labelled like the log", () => {
    const all = Object.values(L.picks).flat();
    assert.ok(all.every(p => p.season >= 2027));
    assert.ok(L.picks.ATL.some(p => p.label === "2029 1st (Dallas's)"));
    // every pick of every coded team exists exactly once
    const seen = new Set(all.map(p => p.season + "|" + p.round + "|" + p.label.replace(/^\S+ \S+ /, "") + "|" + p.from));
    assert.equal(all.length, seen.size);
  });

  test("result fits CacheService (chunked) and is cached", () => {
    const gas = makeGas();
    gas.ctx.getLeague();
    assert.ok(gas.cache.get("site_league").startsWith("chunks:") || gas.cache.has("site_league"));
    const n = gas.urls.length;
    gas.ctx.getLeague();
    assert.equal(gas.urls.length, n, "second call served from cache");
  });
});

/* ------------------------------ trades ------------------------------ */

// Pushes a team into a payroll tier by adding a hold of the given size.
let ballast = 0;
function withPayroll(L, code, target) {
  const now = LM.teamBook(L, code).payroll[0];
  const name = `Ballast ${"ABCDEFGHIJKLMNOP"[ballast++]} ${code} (cap hold)`;
  L.contracts.push({ r: 9999, n: name, hold: true, sal: [LM.r1(target - now), null, null, null, null, null, null], st: ["", "", "", "", "", "", ""] });
  L.holds.push({ code, name });
  LM.resetIndex(L);
  assert.equal(LM.teamBook(L, code).payroll[0], target);
  return L;
}
const playerOn = (L, code, pred) => LM.teamBook(L, code).players.find(p => p.c && typeof p.c.sal[0] === "number" && pred(p.c.sal[0], p.c));
const swap = (a, A, b, B) => ({ teams: [A, B], moves: [
  { type: "player", name: a.name, from: A, to: B }, { type: "player", name: b.name, from: B, to: A }] });

describe("evaluateTrade", () => {
  const base = league();

  test("tiers: under cap no limit; 1st apron +15; 2nd apron +5; tax can only lose", () => {
    for (const [pay, limit] of [[140, Infinity], [180, 15], [230, 5], [270, 0]]) {
      const L = withPayroll(clone(base), "DET", pay);
      // DET takes a bigger salary from SAC (102.9, under cap) without sending much back
      const big = playerOn(L, "SAC", s => s >= 18);
      const small = playerOn(L, "DET", s => s <= 4);
      const r = LM.evaluateTrade(L, swap(small, "DET", big, "SAC"));
      const det = r.teams.find(t => t.code === "DET");
      assert.equal(det.delta, LM.r1(big.c.sal[0] - small.c.sal[0]));
      const legalForDet = det.delta <= limit;
      assert.equal(det.ok, legalForDet, `payroll ${pay}, delta ${det.delta}`);
    }
  });

  test("tier is judged on PRE-trade payroll", () => {
    const L = withPayroll(clone(base), "DET", 148); // under cap now, ends up over 150
    const big = playerOn(L, "SAC", s => s >= 18);
    const r = LM.evaluateTrade(L, { teams: ["DET", "SAC"], moves: [{ type: "player", name: big.name, from: "SAC", to: "DET" }] });
    const det = r.teams.find(t => t.code === "DET");
    assert.equal(det.tier.key, "cap");
    assert.notEqual(det.tierAfter.key, "cap");
    assert.equal(det.ok, true);
  });

  test("exactly +$15M at the 1st apron is allowed, +$15.1M is not", () => {
    for (const [add, ok] of [[15, true], [15.1, false]]) {
      const L = withPayroll(clone(base), "DET", 170);
      L.contracts.push({ r: 9998, n: "Test Guy", hold: false, sal: [add, null, null, null, null, null, null], st: ["", "", "", "", "", "", ""] });
      L.rosters[LM.teamByCode(L, "SAC").rid].bench.push({ pid: "t", name: "Test Guy" });
      LM.resetIndex(L);
      const r = LM.evaluateTrade(L, { teams: ["DET", "SAC"], moves: [{ type: "player", name: "Test Guy", from: "SAC", to: "DET" }] });
      assert.equal(r.teams.find(t => t.code === "DET").ok, ok, String(add));
    }
  });

  test("hard max: over $300M now is illegal; over in a future season is only a warning", () => {
    const L = withPayroll(clone(base), "DET", 290);
    L.contracts.push({ r: 9997, n: "Future Guy", hold: false, sal: [0, 400, null, null, null, null, null], st: ["", "", "", "", "", "", ""] });
    L.rosters[LM.teamByCode(L, "SAC").rid].bench.push({ pid: "f", name: "Future Guy" });
    LM.resetIndex(L);
    const r = LM.evaluateTrade(L, { teams: ["DET", "SAC"], moves: [{ type: "player", name: "Future Guy", from: "SAC", to: "DET" }] });
    assert.equal(r.legal, true, r.problems.join("; "));
    assert.ok(r.warnings.some(w => /2027-28/.test(w)));
    const L2 = withPayroll(clone(base), "SAC", 140); // SAC under cap, no matching limit
    const big = playerOn(base, "BOS", s => s >= 20);
    const L3 = withPayroll(L2, "SAC", 295);
    const r2 = LM.evaluateTrade(L3, { teams: ["SAC", "BOS"], moves: [{ type: "player", name: big.name, from: "BOS", to: "SAC" }] });
    assert.equal(r2.legal, false);
    assert.ok(r2.problems.some(p => /over the \$300\.0M max/.test(p)));
  });

  test("cash: balance must stay within ±$10M; cash sent adds to payroll", () => {
    const L = clone(base); // ATL already -10 (received 10), DEN +10
    const r = LM.evaluateTrade(L, { teams: ["ATL", "DET"], moves: [{ type: "cash", amt: 1, from: "DET", to: "ATL" }] });
    assert.equal(r.legal, false, "ATL can't receive more"); // DET is at +10 too
    // DEN (+10) takes 10 back from SAC: DEN to 0, SAC to +10, both in range
    const ok = LM.evaluateTrade(L, { teams: ["DEN", "SAC"], moves: [{ type: "cash", amt: 10, from: "SAC", to: "DEN" }] });
    assert.equal(ok.legal, true, ok.problems.join("; "));
    assert.equal(ok.teams.find(t => t.code === "DEN").cashAfter, 0);
    assert.equal(ok.teams.find(t => t.code === "DEN").delta, -10, "receiving cash lowers payroll");
    assert.equal(ok.teams.find(t => t.code === "SAC").delta, 10, "sending cash adds to payroll");
    // Sending cash counts toward the apron limit: ATL (2nd apron) can't send $10M
    const apron = LM.evaluateTrade(L, { teams: ["ATL", "SAC"], moves: [{ type: "cash", amt: 10, from: "ATL", to: "SAC" }] });
    assert.match(apron.problems.join(" "), /2nd apron/);
    const over = LM.evaluateTrade(L, { teams: ["SAC", "WAS"], moves: [{ type: "cash", amt: 10.5, from: "SAC", to: "WAS" }] });
    assert.equal(over.legal, false);
  });

  test("max limits: a third MAX or a second SMAX is illegal", () => {
    const L = clone(base);
    const byStatus = (code, s) => LM.teamBook(L, code).players.filter(p => p.c && p.c.st[0] === s);
    const team = L.teams.map(t => t.code).find(c => LM.teamBook(L, c).maxes === 2);
    const other = L.teams.map(t => t.code).find(c => c !== team && byStatus(c, "MAX").length);
    assert.ok(team && other, "fixture has a team with 2 maxes");
    const withPay = withPayroll(L, team, 100); // keep the cap rules out of the way
    const r = LM.evaluateTrade(withPay, { teams: [team, other], moves: [{ type: "player", name: byStatus(other, "MAX")[0].name, from: other, to: team }] });
    assert.ok(r.problems.some(p => /3 max contracts/.test(p)), r.problems.join("; "));
    const sm = L.teams.map(t => t.code).find(c => LM.teamBook(L, c).smaxes === 1);
    const sm2 = L.teams.map(t => t.code).find(c => c !== sm && byStatus(c, "SMAX").length);
    if (sm && sm2) {
      const L2 = withPayroll(clone(base), sm, 100);
      const r2 = LM.evaluateTrade(L2, { teams: [sm, sm2], moves: [{ type: "player", name: byStatus(sm2, "SMAX")[0].name, from: sm2, to: sm }] });
      assert.ok(r2.problems.some(p => /2 supermax/.test(p)));
    }
  });

  test("a player can only be traded by the team that has him", () => {
    const p = playerOn(base, "BOS", () => true);
    const r = LM.evaluateTrade(base, { teams: ["DET", "SAC"], moves: [{ type: "player", name: p.name, from: "DET", to: "SAC" }] });
    assert.equal(r.legal, false);
    assert.match(r.problems.join(" "), /isn't on Detroit's roster/);
  });

  test("3-team trade with a pick and cash shows every season for every team", () => {
    const a = playerOn(base, "DET", s => s > 0), b = playerOn(base, "SAC", s => s > 0), c = playerOn(base, "WAS", s => s > 0);
    const r = LM.evaluateTrade(base, { teams: ["DET", "SAC", "WAS"], moves: [
      { type: "player", name: a.name, from: "DET", to: "SAC" },
      { type: "player", name: b.name, from: "SAC", to: "WAS" },
      { type: "player", name: c.name, from: "WAS", to: "DET" },
      { type: "pick", label: "2027 1st (own)", from: "DET", to: "WAS" },
      { type: "cash", amt: 2, from: "SAC", to: "DET" },
    ] });
    assert.equal(r.teams.length, 3);
    r.teams.forEach(t => { assert.equal(t.pre.length, 7); assert.equal(t.post.length, 7); });
    const sum = r.teams.reduce((s, t) => s + t.delta, 0);
    assert.ok(Math.abs(sum) < 1e-9, "salary and cash are conserved");
  });

  test("active roster over the Sleeper limit is a warning, not illegal", () => {
    const L = clone(base);
    const det = LM.teamByCode(L, "DET");
    const ro = L.rosters[det.rid];
    while (ro.starters.length + ro.bench.length < 15) ro.bench.push({ pid: "z" + ro.bench.length, name: "Filler " + ro.bench.length });
    const p = playerOn(L, "SAC", s => s < 5);
    const r = LM.evaluateTrade(L, { teams: ["DET", "SAC"], moves: [{ type: "player", name: p.name, from: "SAC", to: "DET" }] });
    assert.ok(r.warnings.some(w => /16 active players/.test(w)));
  });
});

/* --------------------------- admin writes ---------------------------- */

function adminGas() {
  const gas = makeGas();
  gas.eval(`setPasscode_("letmein1")`);
  const tok = gas.ctx.adminLogin("letmein1");
  assert.equal(tok.ok, true);
  gas.token = tok.token;
  gas.ctx.setupSiteTables_(gas.ss, () => true);
  gas.writes.length = 0;
  return gas;
}
const masterWrites = gas => gas.writes.filter(w => w.sheet === "Master list");
const touchesS = w => w.c <= 19 && w.c + w.nc - 1 >= 19;

describe("admin", () => {
  test("login: wrong passcodes lock for 10 minutes after 10 tries", () => {
    const gas = makeGas();
    gas.eval(`setPasscode_("right-one")`);
    for (let i = 0; i < 9; i++) assert.equal(gas.ctx.adminLogin("nope").ok, false);
    const tenth = gas.ctx.adminLogin("nope");
    assert.match(tenth.msg, /locked for 10 minutes/);
    assert.match(gas.ctx.adminLogin("right-one").msg, /Try again in 10 min/);
    assert.ok(Number(gas.props.get("adminLockUntil")) > Date.now());
    assert.notEqual(gas.props.get("adminHash"), "right-one", "only the hash is stored");
  });

  test("writes need a valid session", () => {
    const gas = makeGas();
    assert.throws(() => gas.ctx.adminSetRanks("bogus", []), /session expired/);
  });

  test("contract edit writes A:R only, checks the row's name, logs and clears the cache", () => {
    const gas = adminGas();
    gas.ctx.getLeague();
    assert.ok(gas.cache.has("site_league"));
    assert.throws(() => gas.ctx.adminSaveContract(gas.token, { row: 3, expect: "Jalen Johnson", n: "X", sal: [] }), /changed/);
    gas.ctx.adminSaveContract(gas.token, { row: 2, expect: "Jalen Johnson", n: "Jalen Johnson", nba: "ATL",
      sal: [33, 43, 40, "UFA"], st: ["MAX"], det: "Edited" });
    const m = gas.sheet("Master list");
    assert.equal(m.cell(2, 3), 33);
    assert.equal(m.cell(2, 10), "Edited");
    assert.equal(m.cell(2, 12), "MAX");
    assert.equal(m.cell(2, 19), "1", "column S untouched");
    assert.ok(!masterWrites(gas).some(touchesS));
    assert.ok(!gas.cache.has("site_league"), "site cache cleared");
    assert.match(gas.sheet("Admin Log").cell(2, 2), /Edit contract/);
  });

  test("add contract lands at the end of its NBA team block; delete of row 2 keeps the S formula row", () => {
    const gas = adminGas();
    const m = gas.sheet("Master list");
    const lastAtl = m.cells.map((r, i) => [r[1], i + 1]).filter(x => x[0] === "ATL").pop()[1];
    const res = gas.ctx.adminSaveContract(gas.token, { n: "New Guy", nba: "ATL", sal: [5, "UFA"], st: [], det: "" });
    assert.equal(res.row, lastAtl + 1);
    assert.equal(m.cell(res.row, 1), "New Guy");
    gas.ctx.adminDeleteContract(gas.token, { row: 2, expect: "Jalen Johnson" });
    assert.equal(m.cell(2, 1), "Dyson Daniels");
    assert.ok(!gas.ops.some(o => o.sheet === "Master list" && o.op === "deleteRow" && o.r === 2));
    assert.ok(!masterWrites(gas).some(touchesS));
  });

  test("waived & re-signed follows the cap-hold-and-min-contract procedure", () => {
    const gas = adminGas();
    const m = gas.sheet("Master list");
    const need = gas.ctx.adminWaiveResign(gas.token, { name: "CJ McCollum" });
    assert.equal(need.needTeam, true, "no team tab holds him, so ask");
    const r = gas.ctx.adminWaiveResign(gas.token, { name: "CJ McCollum", code: "WAS" });
    assert.equal(m.cell(r.oldRow, 1), "CJ McCollum (cap hold)");
    assert.equal(m.cell(r.oldRow, 3), "$24.5", "salaries untouched");
    assert.deepEqual([1, 2, 3, 4].map(c => m.cell(r.newRow, c)), ["CJ McCollum", "ATL", 2, "UFA"]);
    assert.equal(m.bg.get(`${r.newRow},4`), "#4a86e8");
    assert.ok(!masterWrites(gas).some(touchesS));
    const holds = gas.sheet("Cap Holds").cells.map(x => x[0] + "|" + x[1]);
    assert.ok(holds.includes("WAS|CJ McCollum (cap hold)"));
    assert.ok(gas.sheet("WAS").cells.some(x => x[0] === "Cap Hold" && x[1] === "CJ McCollum (cap hold)"));
  });

  test("cash transfer: two ledger rows, blocked outside ±$10M unless override", () => {
    const gas = adminGas();
    assert.throws(() => gas.ctx.adminRecordCash(gas.token, { season: "2026-27", from: "SAC", to: "ATL", amt: 1 }), /ATL would be at -\$11\.0M/);
    gas.ctx.adminRecordCash(gas.token, { season: "2026-27", from: "SAC", to: "ATL", amt: 1, override: true });
    gas.ctx.adminRecordCash(gas.token, { season: "2026-27", from: "ATL", to: "WAS", amt: 4, note: "Trade" });
    const L = clone(gas.ctx.getLeague());
    assert.equal(LM.cashBalance(L, "ATL"), -7);
    assert.equal(LM.cashBalance(L, "SAC"), 1);
    assert.equal(LM.cashBalance(L, "WAS"), -4);
    const row = L.cash.find(x => x.code === "WAS");
    gas.ctx.adminDeleteCash(gas.token, { row: row.row, code: "WAS", amt: -4 });
    assert.equal(LM.cashBalance(clone(gas.ctx.getLeague()), "WAS"), 0);
  });

  test("cap holds: add and remove keep the table and team tab in step", () => {
    const gas = adminGas();
    gas.ctx.adminAddHold(gas.token, { code: "SAC", name: "Dyson Daniels" });
    const L = clone(gas.ctx.getLeague());
    const h = L.holds.find(x => x.name === "Dyson Daniels (cap hold)");
    assert.equal(h.code, "SAC");
    assert.ok(L.contracts.some(c => c.n === "Dyson Daniels (cap hold)" && c.hold));
    gas.ctx.adminRemoveHold(gas.token, { row: h.row, code: h.code, name: h.name });
    assert.ok(!clone(gas.ctx.getLeague()).holds.some(x => x.name === h.name));
    assert.ok(!gas.sheet("SAC").cells.some(x => x[1] === h.name));
  });

  test("power rankings: rank numbers only", () => {
    const gas = adminGas();
    gas.ctx.adminSetRanks(gas.token, [{ name: "Toronto", rank: 1 }, { name: "Oklahoma City", rank: 2 }]);
    const pr = gas.sheet("Team Power Rankings");
    assert.equal(pr.cells.find(r => String(r[1]).trim() === "Toronto")[0], 1);
    assert.ok(gas.writes.filter(w => w.sheet === "Team Power Rankings").every(w => w.c === 1 && w.nc === 1));
  });

  test("payroll check returns every team tab's Total Payroll row", () => {
    const gas = adminGas();
    const res = gas.ctx.adminPayrollCheck(gas.token);
    assert.deepEqual(res.totals.MEM, tabTotals("MEM"));
    assert.equal(Object.keys(res.totals).length, 30);
    assert.ok(res.names.MEM.includes("Braden Smith"));
  });

  test("the sync's drop path appends to Cap Holds and never writes column S", () => {
    const gas = adminGas();
    gas.ctx.makeCapHoldOnMaster_(gas.ss, "Dyson Daniels");
    gas.ctx.appendCapHold_(gas.ss, "ATL", "Dyson Daniels (cap hold)", "Dropped (sync)");
    assert.equal(gas.ctx.appendCapHold_(gas.ss, "ATL", "Dyson Daniels (cap hold)", "again"), false, "no duplicates");
    const res = gas.ctx.addPendingToMaster_(gas.ss, "Brand New", "GS");
    assert.equal(res.created, true);
    assert.ok(!masterWrites(gas).some(touchesS));
  });
});

/* ----------------------------- migration ----------------------------- */

describe("setupSiteTables", () => {
  test("migrates every team tab's cap holds and one opening cash row per team", () => {
    const gas = makeGas();
    const rep = gas.ctx.setupSiteTables_(gas.ss, () => true);
    const holds = gas.sheet("Cap Holds").cells.slice(1);
    const tabHolds = Object.keys(WORKBOOK).filter(k => /^[A-Z]{3}$/.test(k))
      .flatMap(k => WORKBOOK[k].rows.filter(r => r[0] === "Cap Hold" && r[1]).map(r => k + "|" + r[1]));
    assert.equal(holds.length, tabHolds.length);
    assert.deepEqual(holds.map(r => r[0] + "|" + r[1]).sort(), tabHolds.map(s => /\(cap hold\)/.test(s) ? s : s + " (cap hold)").sort());
    const cash = gas.sheet("Cash Ledger").cells.slice(1).map(r => [r[2], r[3], r[1], r[4]]);
    assert.deepEqual(cash.map(r => r[0] + ":" + r[1]).sort(),
      ["ATL:-10", "CHA:2", "DEN:10", "DET:10", "LAC:-10", "LAL:5", "MEM:8", "MIA:6", "PHI:-4", "TOR:-3", "UTA:-1"].sort());
    assert.ok(cash.every(r => r[2] === "2026-27" && r[3] === "Opening balance"));
    assert.equal(rep.length, 3);
  });

  test("payroll is unchanged after migration", () => {
    const before = league();
    const gas = makeGas();
    gas.ctx.setupSiteTables_(gas.ss, () => true);
    const after = league(gas);
    for (const t of before.teams) assert.deepEqual(LM.teamBook(after, t.code).payroll, LM.teamBook(before, t.code).payroll, t.code);
  });

  test("doesn't overwrite existing tables without confirming", () => {
    const gas = makeGas();
    gas.ctx.setupSiteTables_(gas.ss, () => true);
    gas.sheet("Cap Holds").appendRow(["ATL", "Keep Me (cap hold)", "", ""]);
    const asked = [];
    const rep = gas.ctx.setupSiteTables_(gas.ss, n => { asked.push(n); return false; });
    assert.deepEqual(asked, ["Cap Holds", "Cash Ledger"]);
    assert.ok(gas.sheet("Cap Holds").cells.some(r => r[1] === "Keep Me (cap hold)"));
    assert.match(rep[0], /kept/);
  });
});

describe("doGet", () => {
  test("serves the site with every partial inlined and ?n= passed through", () => {
    const gas = makeGas();
    const html = gas.ctx.doGet({ parameter: { n: "Jalen </script> Johnson" } }).getContent();
    assert.ok(!/<\?/.test(html), "no unevaluated scriptlets");
    assert.ok(html.includes("var LeagueMath"));
    assert.ok(html.includes("Jalen \\u003c/script> Johnson"), "player name is escaped");
  });
});
