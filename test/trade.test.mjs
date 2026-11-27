// Trade machine rules (LeagueMath.evaluateTrade) on the real league.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LM, clone, league } from "./helpers.mjs";

const base = league();
const blank = () => [null, null, null, null, null, null, null];
const noSt = () => ["", "", "", "", "", "", ""];

// Pushes a team to an exact current-season payroll with a made-up cap hold.
let ballast = 0;
function withPayroll(L, code, target) {
  const now = LM.teamBook(L, code).payroll[0];
  const name = `Ballast ${"ABCDEFGHIJKLMNOP"[ballast++ % 16]}${"QRSTUVWXYZ"[Math.floor(ballast / 16) % 10]} ${code} (cap hold)`;
  const sal = blank(); sal[0] = LM.r1(target - now);
  L.contracts.push({ id: 9000 + ballast, n: name, hold: true, sal, st: noSt() });
  L.holds.push({ code, name });
  LM.resetIndex(L);
  assert.equal(LM.teamBook(L, code).payroll[0], target);
  return L;
}
function addPlayer(L, code, name, sal) {
  const s = blank(); sal.forEach((v, i) => { s[i] = v; });
  L.contracts.push({ id: 8000 + L.contracts.length, n: name, hold: false, sal: s, st: noSt() });
  L.rosters[LM.teamByCode(L, code).rid].bench.push({ pid: "t" + name, name });
  LM.resetIndex(L);
}
const playerOn = (L, code, pred) => LM.teamBook(L, code).players.find(p => p.c && typeof p.c.sal[0] === "number" && pred(p.c.sal[0], p.c));
const one = (L, name, from, to) => LM.evaluateTrade(L, { teams: [from, to], moves: [{ type: "player", name, from, to }] });

describe("evaluateTrade", () => {
  test("tiers: under cap no limit; 1st apron +15; 2nd apron +5; tax can only lose", () => {
    for (const [pay, limit] of [[140, Infinity], [180, 15], [230, 5], [270, 0]]) {
      const L = withPayroll(clone(base), "DET", pay);
      const big = playerOn(L, "SAC", s => s >= 18), small = playerOn(L, "DET", s => s <= 4);
      const r = LM.evaluateTrade(L, { teams: ["DET", "SAC"], moves: [
        { type: "player", name: small.name, from: "DET", to: "SAC" }, { type: "player", name: big.name, from: "SAC", to: "DET" }] });
      const det = r.teams.find(t => t.code === "DET");
      assert.equal(det.delta, LM.r1(big.c.sal[0] - small.c.sal[0]));
      assert.equal(det.ok, det.delta <= limit, `payroll ${pay}, delta ${det.delta}`);
    }
  });

  test("tier is judged on PRE-trade payroll", () => {
    const L = withPayroll(clone(base), "DET", 148);
    const big = playerOn(L, "SAC", s => s >= 18);
    const det = one(L, big.name, "SAC", "DET").teams.find(t => t.code === "DET");
    assert.equal(det.tier.key, "cap");
    assert.notEqual(det.tierAfter.key, "cap");
    assert.equal(det.ok, true);
  });

  test("exactly +$15M at the 1st apron is allowed, +$15.1M is not", () => {
    for (const [add, ok] of [[15, true], [15.1, false]]) {
      const L = withPayroll(clone(base), "DET", 170);
      addPlayer(L, "SAC", "Test Guy", [add]);
      assert.equal(one(L, "Test Guy", "SAC", "DET").teams.find(t => t.code === "DET").ok, ok, String(add));
    }
  });

  test("hard max: over $300M now is illegal; over in a future season is only a warning", () => {
    const L = withPayroll(clone(base), "DET", 290);
    addPlayer(L, "SAC", "Future Guy", [0, 400]);
    const r = one(L, "Future Guy", "SAC", "DET");
    assert.equal(r.legal, true, r.problems.join("; "));
    assert.ok(r.warnings.some(w => /2027-28/.test(w)));
    const L2 = withPayroll(withPayroll(clone(base), "SAC", 140), "SAC", 295);
    const big = playerOn(base, "BOS", s => s >= 20);
    const r2 = one(L2, big.name, "BOS", "SAC");
    assert.equal(r2.legal, false);
    assert.ok(r2.problems.some(p => /over the \$300\.0M max/.test(p)));
  });

  test("cash: balance stays within ±$10M; sent cash adds to payroll and counts toward the apron limit", () => {
    const L = clone(base); // ATL -10, DEN +10, DET +10
    assert.equal(LM.evaluateTrade(L, { teams: ["ATL", "DET"], moves: [{ type: "cash", amt: 1, from: "DET", to: "ATL" }] }).legal, false);
    const ok = LM.evaluateTrade(L, { teams: ["DEN", "SAC"], moves: [{ type: "cash", amt: 10, from: "SAC", to: "DEN" }] });
    assert.equal(ok.legal, true, ok.problems.join("; "));
    assert.equal(ok.teams.find(t => t.code === "DEN").cashAfter, 0);
    assert.equal(ok.teams.find(t => t.code === "DEN").delta, -10);
    assert.equal(ok.teams.find(t => t.code === "SAC").delta, 10);
    const apron = LM.evaluateTrade(L, { teams: ["ATL", "SAC"], moves: [{ type: "cash", amt: 10, from: "ATL", to: "SAC" }] });
    assert.match(apron.problems.join(" "), /2nd apron/);
    assert.equal(LM.evaluateTrade(L, { teams: ["SAC", "WAS"], moves: [{ type: "cash", amt: 10.5, from: "SAC", to: "WAS" }] }).legal, false);
  });

  test("max limits: 3 max, 2 max + 1 supermax, or 2 supermax", () => {
    const ok = (m, s) => LM.maxComboOk(m, s);
    assert.ok(ok(3, 0) && ok(2, 1) && ok(0, 2) && ok(1, 1) && ok(0, 0));
    assert.ok(!ok(4, 0) && !ok(3, 1) && !ok(1, 2) && !ok(0, 3));
    const L = clone(base);
    const by = (code, s) => LM.teamBook(L, code).players.filter(p => p.c && p.c.st[0] === s);
    const codes = L.teams.map(t => t.code);
    // a team with a supermax and at least one max can't take a second supermax
    const sm = codes.find(c => LM.teamBook(L, c).smaxes === 1 && LM.teamBook(L, c).maxes >= 1), sm2 = codes.find(c => c !== sm && by(c, "SMAX").length);
    assert.ok(sm && sm2, "fixture has a max + supermax team and another supermax team");
    const r = one(withPayroll(clone(base), sm, 100), by(sm2, "SMAX")[0].name, sm2, sm);
    assert.ok(r.problems.some(p => /2 supermax contracts \(allowed/.test(p)), r.problems.join("; "));
  });

  test("a player can only be traded by the team that has him", () => {
    const p = playerOn(base, "BOS", () => true);
    const r = one(base, p.name, "DET", "SAC");
    assert.equal(r.legal, false);
    assert.match(r.problems.join(" "), /isn't on Detroit's roster/);
  });

  test("3-team trade with a pick and cash: every season for every team, salary conserved", () => {
    const a = playerOn(base, "DET", s => s > 0), b = playerOn(base, "SAC", s => s > 0), c = playerOn(base, "WAS", s => s > 0);
    const r = LM.evaluateTrade(base, { teams: ["DET", "SAC", "WAS"], moves: [
      { type: "player", name: a.name, from: "DET", to: "SAC" }, { type: "player", name: b.name, from: "SAC", to: "WAS" },
      { type: "player", name: c.name, from: "WAS", to: "DET" }, { type: "pick", label: "2027 1st (own)", from: "DET", to: "WAS" },
      { type: "cash", amt: 2, from: "SAC", to: "DET" }] });
    assert.equal(r.teams.length, 3);
    r.teams.forEach(t => { assert.equal(t.pre.length, 7); assert.equal(t.post.length, 7); });
    assert.ok(Math.abs(r.teams.reduce((s, t) => s + t.delta, 0)) < 1e-9);
  });

  test("active roster over the Sleeper limit is a warning, not illegal", () => {
    const L = clone(base);
    const ro = L.rosters[LM.teamByCode(L, "DET").rid];
    while (ro.starters.length + ro.bench.length < 15) ro.bench.push({ pid: "z" + ro.bench.length, name: "Filler " + ro.bench.length });
    const r = one(L, playerOn(L, "SAC", s => s < 5).name, "SAC", "DET");
    assert.ok(r.warnings.some(w => /16 active players/.test(w)));
  });
});
