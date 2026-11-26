// The Sleeper sync (sync/sync.mjs) with a fake Sleeper.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../sync/sync.mjs";
import { MU, ROOT, freshData, rostersFromSheet } from "./helpers.mjs";

const LEAGUE = JSON.parse(readFileSync(path.join(ROOT, "fixtures/sleeper/league.json"), "utf8"));
const NOW = Date.parse("2026-11-26T12:00:00Z");
const AFTER = Date.parse("2026-11-26T01:00:00Z"); // after the import cutoff (2026-11-25 22:26 UTC)
const BEFORE = Date.parse("2026-11-25T20:00:00Z");

function pidOf(D, name) { return Object.keys(D.players).find(id => D.players[id][0] === name); }

function fakeSleeper(txns, extra = {}) {
  const calls = [];
  const fetchJson = async url => {
    calls.push(url);
    const p = url.replace("https://api.sleeper.app/v1", "");
    if (p === `/league/${LEAGUE.league_id}`) return Object.assign({}, LEAGUE, { previous_league_id: null });
    if (p === `/league/${LEAGUE.league_id}/rosters`) return rostersFromSheet();
    if (p === `/league/${LEAGUE.league_id}/transactions/1`) return txns;
    if (/\/transactions\/\d+$/.test(p)) return [];
    if (p in extra) return extra[p];
    throw new Error("unexpected fetch " + url);
  };
  return { fetchJson, calls };
}
function data() {
  const D = freshData();
  D.state.playersAt = D.state.espnAt = new Date(NOW).toISOString(); // skip the daily refreshes
  return D;
}

describe("sync", () => {
  test("drop -> cap hold on the dropping team; add -> PENDING row; trade logged; old moves ignored", async () => {
    const D = data();
    const dyson = pidOf(D, "Dyson Daniels"), mpj = pidOf(D, "Michael Porter Jr."), herb = pidOf(D, "Herbert Jones");
    D.players["999001"] = ["Brand Newguy", "GS"];
    const txns = [
      { transaction_id: "old1", status: "complete", type: "free_agent", status_updated: BEFORE, drops: { [mpj]: 17 }, roster_ids: [17] },
      { transaction_id: "t1", status: "complete", type: "free_agent", status_updated: AFTER, drops: { [dyson]: 2 }, roster_ids: [2] },
      { transaction_id: "t2", status: "complete", type: "waiver", status_updated: AFTER + 1000, adds: { "999001": 2 }, roster_ids: [2], settings: { waiver_bid: 3 } },
      { transaction_id: "t3", status: "complete", type: "trade", status_updated: AFTER + 2000, adds: { [herb]: 17 }, drops: { [herb]: 2 }, roster_ids: [2, 17],
        draft_picks: [{ season: "2028", round: 1, roster_id: 2, owner_id: 17, previous_owner_id: 2 }] },
      { transaction_id: "t4", status: "failed", type: "waiver", status_updated: AFTER, adds: { [mpj]: 5 } },
    ];
    const { fetchJson } = fakeSleeper(txns);
    const notes = await runSync(D, fetchJson, NOW);
    assert.match(notes.join(" "), /applied 4 new transaction/);

    assert.ok(D.contracts.rows.some(r => r.n === "Dyson Daniels (cap hold)"));
    assert.ok(D.holds.some(h => h.code === "ATL" && h.name === "Dyson Daniels (cap hold)"));
    const pend = D.contracts.rows.find(r => r.n === "Brand Newguy");
    assert.equal(pend.nba, "GSW");
    assert.match(pend.det, /PENDING/);
    assert.ok(D.contracts.rows.some(r => r.n === "Michael Porter Jr."), "move before the cutoff was ignored");

    const [trade, add, drop] = D.log;
    assert.equal(trade.type, "Trade");
    assert.equal(trade.teams, "Atlanta ↔ Orlando");
    assert.match(trade.players, /Orlando gets: Herbert Jones, 2028 1st \(Atlanta's\)/);
    assert.equal(add.type, "Waiver add");
    assert.equal(add.status, "⏳ Needs contract");
    assert.equal(drop.type, "Drop");
    assert.equal(drop.status, "Cap hold created");
    assert.ok(["t1", "t2", "t3", "t4"].every(id => D.state.seen.includes(id)));
    assert.equal(D.txns.length, 4, "completed transactions kept for the player cards");

    // running again changes nothing
    const before = JSON.stringify([D.contracts, D.holds, D.log, D.state]);
    await runSync(D, fetchJson, NOW + 300000);
    assert.equal(JSON.stringify([D.contracts, D.holds, D.log, D.state]), before);
  });

  test("an add and drop of the same player in one batch cancels out", async () => {
    const D = data();
    D.players["999002"] = ["Quick Flip", "BOS"];
    const { fetchJson } = fakeSleeper([
      { transaction_id: "a", status: "complete", type: "free_agent", status_updated: AFTER, adds: { "999002": 3 }, roster_ids: [3] },
      { transaction_id: "b", status: "complete", type: "free_agent", status_updated: AFTER + 1, drops: { "999002": 3 }, roster_ids: [3] },
    ]);
    await runSync(D, fetchJson, NOW);
    assert.ok(!D.contracts.rows.some(r => MU.plain(r.n) === "Quick Flip"));
    assert.ok(D.log.slice(0, 2).every(e => e.status === "No change"));
  });

  test("first run on a fresh league only records a baseline", async () => {
    const D = data();
    D.state = { started: false, seen: [], playersAt: D.state.playersAt, espnAt: D.state.espnAt };
    const { fetchJson } = fakeSleeper([{ transaction_id: "x", status: "complete", type: "free_agent", status_updated: AFTER, drops: { [pidOf(D, "Dyson Daniels")]: 2 }, roster_ids: [2] }]);
    const rows = D.contracts.rows.length;
    await runSync(D, fetchJson, NOW);
    assert.equal(D.contracts.rows.length, rows);
    assert.ok(!D.contracts.rows.some(r => /Dyson Daniels \(cap hold\)/.test(r.n)));
    assert.equal(D.state.started, true);
    assert.equal(D.log[0].type, "Info");
  });

  test("daily refresh keeps the old ESPN index when the fetch looks broken", async () => {
    const D = data();
    D.state.espnAt = "";
    D.espn = { keep: [{ id: "1" }] };
    const espn = {};
    for (let i = 1; i <= 30; i++) espn[`https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${i}/roster`] = null;
    const { fetchJson } = fakeSleeper([], {});
    const f = async url => (url.includes("espn.com") ? null : fetchJson(url));
    const notes = await runSync(D, f, NOW);
    assert.deepEqual(D.espn, { keep: [{ id: "1" }] });
    assert.match(notes.join(" "), /kept the old index/);
  });
});
