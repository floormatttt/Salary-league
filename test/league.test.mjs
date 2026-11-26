// Import + league building against the workbook snapshot.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LM, League, WORKBOOK, freshData, league, tabTotals } from "./helpers.mjs";

const MEM_MISSING = ["Kalkbrenner", "Dunn", "Carter", "Bona", "Diawara", "Reed"];

describe("import from the Google Sheet", () => {
  const D = freshData();

  test("contracts: every Master list row, values as numbers / UFA / RFA", () => {
    assert.equal(D.contracts.rows.length, 480);
    assert.deepEqual(D.contracts.seasons, ["2026-27", "2027-28", "2028-29", "2029-30", "2030-31", "2031-32", "2032-33"]);
    const jj = D.contracts.rows.find(r => r.n === "Jalen Johnson");
    assert.deepEqual(jj.sal, [32, 43, 40, "UFA", null, null, null]);
    assert.equal(jj.det, "MIA Restructure");
    assert.ok(D.contracts.rows.every(r => r.sal.length === 7 && r.st.length === 7));
  });

  test("cap holds come from every team tab's Cap Hold rows", () => {
    const tabHolds = Object.keys(WORKBOOK).filter(k => /^[A-Z]{3}$/.test(k))
      .flatMap(k => WORKBOOK[k].rows.filter(r => r[0] === "Cap Hold" && r[1]).map(r => k + "|" + (/\(cap hold\)/.test(r[1]) ? r[1] : r[1] + " (cap hold)")));
    assert.deepEqual(D.holds.map(h => h.code + "|" + h.name).sort(), tabHolds.sort());
  });

  test("one opening cash row per team, matching the team tabs", () => {
    const want = { ATL: -10, CHA: 2, DEN: 10, DET: 10, LAC: -10, LAL: 5, MEM: 8, MIA: 6, PHI: -4, TOR: -3, UTA: -1 };
    assert.deepEqual(Object.fromEntries(D.cash.map(x => [x.code, x.amt])), want);
    assert.ok(D.cash.every(x => x.season === "2026-27" && x.note === "Opening balance"));
  });

  test("teams, ranks, log, rules, players, sync state", () => {
    assert.equal(D.teams.length, 30);
    assert.equal(D.teams.find(t => t.code === "OKC").rank, 1);
    assert.equal(D.log.length, 28);
    assert.equal(D.log[0].type, "Trade");
    assert.match(D.log[0].ts, /^2026-11-2\dT/);
    assert.ok(D.rules.rows.length > 50);
    assert.ok(Object.keys(D.players).length > 2000);
    assert.equal(D.state.started, true);
    assert.equal(D.state.since, "2026-11-25T22:26:42.000Z", "sheet's last sync (2:26:42 PM Pacific)");
    assert.equal(D.state.seen.length, 30);
  });

  test("toJson round-trips every file", () => {
    for (const k of Object.keys(League.FILES)) assert.deepEqual(JSON.parse(League.toJson(D[k])), D[k], k);
  });
});

describe("league built from data + Sleeper", () => {
  const L = league();

  test("shape", () => {
    assert.equal(L.season, "2026-27");
    assert.equal(L.teams.length, 30, "32 rosters, 2 unknown");
    assert.deepEqual(L.limits, { activeRoster: 15, hardCap: 300, cash: 10, maxes: 2, supermaxes: 1 });
    assert.equal(L.teams[0].code, "OKC", "sorted by rank");
    assert.equal(L.teams[0].owner, "Ejjizzy");
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

  test("players without a contract are flagged and count $0", () => {
    assert.ok(LM.teamBook(L, "HOU").missing.includes("Thomas Bryant"));
    assert.ok(LM.teamBook(L, "GSW").missing.includes("Jabari Walker"));
  });

  test("draft picks: next 3 drafts, labelled like the log, each pick once", () => {
    const all = Object.values(L.picks).flat();
    assert.ok(all.every(p => p.season >= 2027 && p.season <= 2029));
    assert.ok(L.picks.ATL.some(p => p.label === "2029 1st (Dallas's)"));
    const keys = all.map(p => p.season + "|" + p.round + "|" + p.from + "|" + p.label);
    assert.equal(new Set(keys).size, keys.length);
  });
});
