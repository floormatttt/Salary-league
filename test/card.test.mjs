// Player card data (lib/Card.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CardData, freshData, league } from "./helpers.mjs";

test("card: fantasy team, contract rows, roster count", () => {
  const D = freshData(), L = league(D);
  const c = CardData.card(L, D.players, {}, "jalen johnson");
  assert.equal(c.found, true);
  assert.equal(c.name, "Jalen Johnson");
  assert.ok(c.sleeperId);
  assert.equal(c.contracts[0].years[0].salary, "$32.0");
  assert.equal(c.contracts[0].years[3].salary, "UFA");
  assert.equal(c.contracts[0].onRoster, "1");
  assert.ok(c.fantasy && c.fantasy.team);
  assert.equal(CardData.card(L, D.players, {}, "Zzz Nobody").found, false);
  const hold = CardData.card(L, D.players, {}, "Dorian Finney-Smith (cap hold)");
  assert.ok(hold.contracts.some(k => k.hold));
});

test("fantasy scoring and summary from a box score", () => {
  const s = CardData.scorer({ pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, dd: 1, td: 2, xyz: 4 });
  const g = { pts: 20, reb: 10, ast: 10, stl: 1, blk: 0, to: 2, pf: 1, fgm: 8, fga: 15, fg3m: 2, fg3a: 5, ftm: 2, fta: 2, min: 34 };
  assert.equal(s.score(g), 20 + 12 + 15 + 3 - 2 + 1 + 2);
  assert.deepEqual(s.unscored, ["xyz"]);
  // this league's real settings: half a point per three made (Sleeper's "tpm")
  const league = CardData.scorer({ ast: 1, blk: 2, bonus_pt_40p: 2, bonus_pt_50p: 2, dd: 1, ff: -2, pts: 0.5, reb: 1, stl: 2, td: 2, tf: -2, to: -1, tpm: 0.5 });
  assert.equal(league.score(g), 10 + 10 + 10 + 2 - 2 + 1 + 2 + 2 * 0.5, "2 threes = +1.0");
  assert.deepEqual(league.unscored, ["ff", "tf"], "only flagrant/technical fouls aren't in the box score");
  const sum = CardData.summarize([Object.assign({ fp: 51 }, g), Object.assign({ fp: 20 }, g, { min: 0 })]);
  assert.equal(sum.g, 1, "DNPs don't count");
  assert.equal(sum.adv.td, 1);
  assert.equal(sum.eligibility, "Supermax eligible (30+ FPPG)");
});

test("transactions for one player", () => {
  const list = [
    { ts: 2, s: "2026", ty: "trade", a: { p1: 2 }, d: { p1: 1 }, r: [1, 2], p: [["2028", 1, 1, 2, 1]] },
    { ts: 1, s: "2026", ty: "waiver", a: { p1: 1 }, d: null, r: [1], b: 7 },
  ];
  const t = CardData.txns(list, "p1", rid => "Team " + rid, p => p.toUpperCase());
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].text, "Team 1 → Team 2");
  assert.deepEqual(t.rows[0].parts[1].items, [{ player: "P1" }, { pick: "2028 1st (Team 1's)" }]);
  assert.equal(t.rows[1].type, "Waiver Add");
  assert.match(t.rows[1].text, /\$7 bid/);
});
