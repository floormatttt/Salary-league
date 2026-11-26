/* League: builds the league object the pages use (the same shape LeagueMath
 * expects) from the data files plus live Sleeper data, and formats data files
 * the same way in the browser and in the sync so commits diff cleanly. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./LeagueMath.js"), require("./Mutations.js"));
  else root.League = factory(root.LeagueMath, root.Mutations);
})(this, function (LM, MU) {
  var CONFIG = {
    leagueId: "1341793858815557632",
    limits: { hardCap: 300, cash: 10, maxes: 2, supermaxes: 1 },
  };
  // data/<file> for each key of the data object
  var FILES = {
    contracts: "contracts.json", holds: "holds.json", cash: "cash.json", teams: "teams.json",
    log: "log.json", adminLog: "admin-log.json", rules: "rules.json", players: "players.json",
    espn: "espn.json", txns: "txns.json", state: "state.json",
  };

  // One array element per line: readable diffs, small files.
  function toJson(v) {
    if (Array.isArray(v)) return v.length ? "[\n" + v.map(function (x) { return JSON.stringify(x); }).join(",\n") + "\n]\n" : "[]\n";
    if (v && typeof v === "object") {
      var keys = Object.keys(v);
      return "{\n" + keys.map(function (k) {
        var x = v[k];
        var s = Array.isArray(x) && x.length && typeof x[0] === "object"
          ? "[\n" + x.map(function (e) { return "  " + JSON.stringify(e); }).join(",\n") + "\n]"
          : JSON.stringify(x);
        return JSON.stringify(k) + ": " + s;
      }).join(",\n") + "\n}\n";
    }
    return JSON.stringify(v) + "\n";
  }

  // Sleeper's "2026" is the 2026-27 season, so the next draft is 2027.
  // Next 3 drafts plus any later season that shows up in traded picks.
  // Labels match the League Log: "2029 1st (Dallas's)" / "2028 2nd (own)".
  function computePicks(rosters, teamOf, sl, traded) {
    var rounds = Number(sl.settings && sl.settings.draft_rounds) || 2;
    var first = Number(sl.season) + 1;
    var seasons = [first, first + 1, first + 2];
    (traded || []).forEach(function (p) { var s = Number(p.season); if (s > first + 2 && seasons.indexOf(s) < 0) seasons.push(s); });
    seasons.sort();
    var owner = {};
    (traded || []).forEach(function (p) { owner[p.season + "|" + p.round + "|" + p.roster_id] = String(p.owner_id); });
    var out = {};
    seasons.forEach(function (s) {
      for (var rd = 1; rd <= rounds; rd++) {
        rosters.forEach(function (r) {
          var orig = String(r.roster_id), own = owner[s + "|" + rd + "|" + orig] || orig;
          var to = teamOf(own), from = teamOf(orig);
          if (!to) return;
          (out[to.code] = out[to.code] || []).push({
            season: s, round: rd, from: from ? from.code : "",
            label: s + " " + MU.ordinal(rd) + " (" + (own === orig ? "own" : (from ? from.name : "Roster " + orig) + "'s") + ")",
          });
        });
      }
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return a.season - b.season || a.round - b.round || (/\(own\)/.test(b.label) - /\(own\)/.test(a.label)); });
    });
    return out;
  }

  // D: data files (contracts, holds, cash, teams, players, state).
  // S: live Sleeper { league, rosters, users, traded }.
  function build(D, S) {
    var byRid = {};
    D.teams.forEach(function (t) { byRid[String(t.rid)] = t; });
    var teamOf = function (rid) { return byRid[String(rid)] || null; };
    var owners = {};
    (S.users || []).forEach(function (u) { owners[u.user_id] = u.display_name || u.username || ""; });
    var nm = function (pid) { var p = D.players[pid]; return p ? p[0] : String(pid); };
    var ent = function (pid) { return { pid: String(pid), name: nm(pid) }; };

    var rosters = {}, teams = [];
    (S.rosters || []).forEach(function (r) {
      var rid = String(r.roster_id);
      var st = (r.starters || []).map(String).filter(function (p) { return p && p !== "0"; });
      var ir = (r.reserve || []).map(String), tx = (r.taxi || []).map(String);
      var bench = (r.players || []).map(String).filter(function (p) { return p !== "0" && st.indexOf(p) < 0 && ir.indexOf(p) < 0 && tx.indexOf(p) < 0; });
      rosters[rid] = { starters: st.map(ent), bench: bench.map(ent), ir: ir.map(ent), taxi: tx.map(ent) };
      var t = teamOf(rid);
      if (!t || !t.code) return;
      var s = r.settings || {};
      teams.push({ rid: rid, code: t.code, name: t.name, owner: owners[r.owner_id] || t.owner || "", rank: t.rank == null ? null : t.rank,
        w: s.wins || 0, l: s.losses || 0, t: s.ties || 0,
        pf: Math.round(((s.fpts || 0) + (s.fpts_decimal || 0) / 100) * 100) / 100 });
    });
    teams.sort(function (a, b) { return (a.rank == null ? 99 : a.rank) - (b.rank == null ? 99 : b.rank) || a.name.localeCompare(b.name); });

    var seasons = D.contracts.seasons;
    return {
      season: seasons[0],
      seasons: seasons,
      teams: teams,
      contracts: D.contracts.rows.map(function (r) {
        return { id: r.id, n: r.n, hold: MU.isHold(r.n), nba: r.nba, sal: r.sal, st: r.st, det: r.det || "", fill: r.fill || "" };
      }),
      rosters: rosters,
      holds: D.holds.slice(),
      cash: D.cash.slice(),
      picks: computePicks(S.rosters || [], teamOf, S.league || {}, S.traded),
      limits: Object.assign({ activeRoster: ((S.league || {}).roster_positions || []).length || null }, CONFIG.limits),
      lastSync: (D.state && D.state.lastChange) || "",
    };
  }

  return { CONFIG: CONFIG, FILES: FILES, toJson: toJson, build: build, computePicks: computePicks };
});
