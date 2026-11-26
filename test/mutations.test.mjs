// Commissioner edits (lib/Mutations.js) on the imported data.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LM, MU, freshData, league } from "./helpers.mjs";

const row = (D, n) => D.contracts.rows.find(r => r.n === n);

describe("contracts", () => {
  test("edit by id; salaries parsed; statuses checked", () => {
    const D = freshData();
    const jj = row(D, "Jalen Johnson");
    MU.saveContract(D, { id: jj.id, n: "Jalen Johnson", nba: "atl", sal: ["$33", "43", 40, "ufa"], st: ["max"], det: "Edited" });
    assert.deepEqual(jj.sal, [33, 43, 40, "UFA", null, null, null]);
    assert.equal(jj.st[0], "MAX");
    assert.equal(jj.nba, "ATL");
    assert.throws(() => MU.saveContract(D, { id: jj.id, n: "X", sal: ["lots"] }), /isn't a salary/);
    assert.throws(() => MU.saveContract(D, { id: jj.id, n: "X", st: ["MEGA"] }), /Unknown status/);
    assert.throws(() => MU.saveContract(D, { id: 99999, n: "X" }), /isn't there anymore/);
  });

  test("an extension fills the new years, then UFA, and tags the details", () => {
    const D = freshData();
    const jj = row(D, "Jalen Johnson");
    const res = MU.extend(D, { id: jj.id, years: 2, amt: "45", st: "max" });   // starts in his free-agency year (2029-30)
    assert.deepEqual(jj.sal.slice(0, 6), [32, 43, 40, 45, 45, "UFA"]);
    assert.deepEqual(jj.st.slice(3, 6), ["MAX", "MAX", ""]);
    assert.match(jj.det, /Max Ext 29-30$/);
    assert.match(res.log, /Extended Jalen Johnson \(ATL\): \$45\.0M × 2 years \(29-30 to 30-31\) · MAX/);
    MU.extend(D, { id: jj.id, years: 1, amt: 50 });
    assert.equal(jj.sal[5], 50, "the next extension starts at the new free-agency year");
    assert.equal((jj.det.match(/Ext/g) || []).length, 1, "re-extending replaces the tag");
    assert.throws(() => MU.extend(D, { id: jj.id, years: 9, amt: 5 }), /1 to 5 years/);
    const fa = D.contracts.rows.find(r => typeof r.sal[0] !== "number" && !r.n.includes("cap hold"));
    if (fa) assert.throws(() => MU.extend(D, { id: fa.id, years: 1, amt: 5 }), /no free-agency year/);
  });

  test("a restructure changes only the existing years and tags the team", () => {
    const D = freshData();
    const jj = row(D, "Jalen Johnson");
    const res = MU.restructure(D, { id: jj.id, team: "HOU", sal: [30, 45, 40], st: ["", "PO", ""] });
    assert.deepEqual(jj.sal.slice(0, 4), [30, 45, 40, "UFA"]);
    assert.equal(jj.st[1], "PO");
    assert.match(jj.det, /HOU Restructure$/);
    assert.match(res.log, /Restructured Jalen Johnson \(ATL\): \$32\.0M \/ \$43\.0M \/ \$40\.0M → \$30\.0M \/ \$45\.0M \/ \$40\.0M/);
    assert.throws(() => MU.restructure(D, { id: jj.id, sal: [30, 45, 40, 20] }), /only changes the years he already has/);
    assert.throws(() => MU.restructure(D, { id: jj.id, sal: [30, 45, 40] , st: ["", "PO", ""] }), /Nothing changed/);
    assert.throws(() => MU.restructure(D, { id: jj.id, sal: [30, "", 40] }), /needs a salary/);
  });

  test("a new contract lands at the end of its NBA team's group, with a new id", () => {
    const D = freshData();
    const lastAtl = D.contracts.rows.map((r, i) => [r.nba, i]).filter(x => x[0] === "ATL").pop()[1];
    const res = MU.saveContract(D, { n: "New Guy", nba: "ATL", sal: [5, "UFA"] });
    assert.equal(D.contracts.rows[lastAtl + 1].n, "New Guy");
    assert.equal(res.id, 481);
    MU.deleteContract(D, { id: res.id });
    assert.ok(!row(D, "New Guy"));
  });
});

describe("cap holds", () => {
  test("add renames the contract and puts the hold on the team; remove keeps the contract", () => {
    const D = freshData();
    MU.addHold(D, { code: "SAC", name: "Dyson Daniels" });
    assert.ok(row(D, "Dyson Daniels (cap hold)"));
    const h = D.holds.find(x => x.name === "Dyson Daniels (cap hold)");
    assert.equal(h.code, "SAC");
    assert.equal(LM.teamBook(league(D), "SAC").holds.some(x => x.name === h.name), true);
    MU.removeHold(D, { id: h.id });
    assert.ok(!D.holds.some(x => x.id === h.id));
    assert.ok(row(D, "Dyson Daniels (cap hold)"), "contract row stays");
    assert.throws(() => MU.addHold(D, { code: "SAC", name: "Nobody Atall" }), /isn't on the contracts list/);
    assert.throws(() => MU.addHold(D, { code: "XXX", name: "Jalen Johnson" }), /Pick a team/);
  });

  test("waived & re-signed: old contract -> hold on the waiving team, new $2.0 / UFA minimum in his NBA group", () => {
    const D = freshData();
    assert.throws(() => MU.waiveResign(D, { name: "CJ McCollum" }), /Pick a team/);
    const r = MU.waiveResign(D, { name: "CJ McCollum", code: "WAS" });
    const old = D.contracts.rows.find(x => x.id === r.holdId), neu = D.contracts.rows.find(x => x.id === r.newId);
    assert.equal(old.n, "CJ McCollum (cap hold)");
    assert.deepEqual(old.sal.slice(0, 3), [24.5, 24.5, "UFA"], "salaries untouched");
    assert.deepEqual([neu.n, neu.nba, neu.sal[0], neu.sal[1], neu.fill], ["CJ McCollum", "ATL", 2, "UFA", "min"]);
    assert.ok(D.contracts.rows.indexOf(neu) > D.contracts.rows.indexOf(old));
    assert.ok(D.holds.some(h => h.code === "WAS" && h.name === "CJ McCollum (cap hold)"));
    // payroll: WAS carries the 24.5 hold; whoever rosters McCollum now pays 2.0
    const L = league(D);
    assert.equal(LM.contractFor(L, "CJ McCollum").sal[0], 2);
  });
});

describe("cash", () => {
  test("two ledger rows; blocked outside ±$10M unless override; delete one row", () => {
    const D = freshData();
    assert.throws(() => MU.recordCash(D, { season: "2026-27", from: "SAC", to: "ATL", amt: 1 }), /ATL would be at -\$11\.0M/);
    MU.recordCash(D, { season: "2026-27", from: "SAC", to: "ATL", amt: 1, override: true });
    MU.recordCash(D, { season: "2026-27", from: "ATL", to: "WAS", amt: 4, note: "Trade" });
    assert.equal(MU.cashBalance(D, "ATL", "2026-27"), -7);
    assert.equal(MU.cashBalance(D, "SAC", "2026-27"), 1);
    assert.equal(LM.cashBalance(league(D), "WAS"), -4);
    MU.deleteCash(D, { id: D.cash.find(x => x.code === "WAS").id });
    assert.equal(MU.cashBalance(D, "WAS", "2026-27"), 0);
    assert.throws(() => MU.recordCash(D, { season: "2026-27", from: "SAC", to: "SAC", amt: 1 }), /different teams/);
    assert.throws(() => MU.recordCash(D, { season: "2026", from: "SAC", to: "ATL", amt: 1 }), /2026-27/);
  });
});

test("rankings", () => {
  const D = freshData();
  const r = MU.setRanks(D, [{ code: "TOR", rank: 1 }, { code: "OKC", rank: "2" }, { code: "WAS", rank: "" }]);
  assert.equal(D.teams.find(t => t.code === "TOR").rank, 1);
  assert.equal(D.teams.find(t => t.code === "OKC").rank, 2);
  assert.equal(D.teams.find(t => t.code === "WAS").rank, null);
  assert.match(r.log, /Toronto 2→1/);
  assert.equal(league(D).teams[0].code, "TOR");
});
