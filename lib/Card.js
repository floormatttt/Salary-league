/* Card: data for the player popup (ported from the old PlayerCard.gs).
 *   card(L, players, espnIdx, name)     header, bio, fantasy team, contract rows
 *   parseGamelog(espnJson) / scorer(settings) / summarize(games)
 *   txns(txnList, pid, teamName(rid), nameOf(pid))
 *   espnRecord(athlete, team)           used by the sync to build espn.json
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./LeagueMath.js"), require("./Mutations.js"));
  else root.CardData = factory(root.LeagueMath, root.Mutations);
})(this, function (LM, MU) {
  var CAP = 150;

  function clean(s) { return String(s || "").replace(/\s*\(cap hold\)\s*/i, " ").replace(/\bDUPLICATE\b/g, " ").replace(/\s+/g, " ").trim(); }
  function fixAbbr(a) { a = String(a || "").toUpperCase(); return MU.NBA_ABBR_FIX[a] || a; }
  function salText(v) { return typeof v === "number" ? (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(1) : v || ""; }

  // players: { sleeperId: [name, nbaTeam] }. Index by normalized name once.
  function playerIndex(players) {
    if (players.__byKey) return players.__byKey;
    var byKey = {};
    Object.keys(players).forEach(function (id) {
      var p = players[id], k = LM.norm(p[0]);
      (byKey[k] = byKey[k] || []).push({ id: id, name: p[0], team: p[1] || "" });
    });
    Object.defineProperty(players, "__byKey", { value: byKey, enumerable: false });
    return byKey;
  }

  function card(L, players, espnIdx, raw) {
    var q = clean(raw), key = LM.norm(q);
    if (!key) return { found: false, query: String(raw || "") };
    var onRoster = {}, slotOf = {};
    L.teams.forEach(function (t) {
      var ro = L.rosters[t.rid] || {};
      [["starters", "Starter"], ["bench", "Bench"], ["ir", "IR"], ["taxi", "Taxi"]].forEach(function (s) {
        (ro[s[0]] || []).forEach(function (p) { onRoster[p.pid] = t; slotOf[p.pid] = s[1]; });
      });
    });
    var cands = playerIndex(players)[key] || [];
    var pick = cands.filter(function (c) { return onRoster[c.id]; })[0] || cands.filter(function (c) { return c.team; })[0] || cands[0] || null;
    var rows = L.contracts.filter(function (c) { return LM.norm(c.n) === key; });
    var nbaGuess = (pick && fixAbbr(pick.team)) || (rows[0] && rows[0].nba) || "";
    var ec = (espnIdx && espnIdx[key]) || [];
    var espn = ec.filter(function (r) { return r.team === nbaGuess; })[0] || ec[0] || null;
    var t = pick && onRoster[pick.id];
    var counts = {};
    L.teams.forEach(function (tm) {
      var ro = L.rosters[tm.rid] || {};
      ["starters", "bench", "ir", "taxi"].forEach(function (s) { (ro[s] || []).forEach(function (p) { var k = LM.norm(p.name); counts[k] = (counts[k] || 0) + 1; }); });
    });
    return {
      found: !!(pick || espn || rows.length),
      query: q,
      name: (pick && pick.name) || (espn && espn.name) || (rows[0] && clean(rows[0].n)) || q,
      sleeperId: pick ? pick.id : null,
      nbaTeam: (espn && espn.team) || nbaGuess,
      espn: espn,
      fantasy: t ? { team: t.name, owner: t.owner, code: t.code, slot: slotOf[pick.id] } : null,
      contracts: rows.map(function (c) {
        return {
          row: c.id, name: c.n, hold: c.hold, team: c.nba,
          years: L.seasons.map(function (s, i) { return { season: s, salary: salText(c.sal[i]), status: c.st[i] || "" }; }),
          details: c.det, onRoster: c.hold ? "0" : String(counts[LM.norm(c.n)] || 0),
        };
      }),
      seasons: L.seasons,
      cap: CAP,
    };
  }

  function espnRecord(a, team) {
    var inj = (a.injuries || [])[0], bp = a.birthPlace || {};
    return {
      id: String(a.id), name: a.fullName || a.displayName || "", team: team,
      pos: (a.position && a.position.abbreviation) || "", jersey: a.jersey || "", ht: a.displayHeight || "", wt: a.displayWeight || "",
      age: a.age != null ? a.age : "", dob: a.dateOfBirth || "", born: [bp.city, bp.state || bp.country].filter(Boolean).join(", "),
      college: (a.college && (a.college.name || a.college.shortName)) || "",
      exp: a.experience && a.experience.years != null ? a.experience.years : "",
      img: (a.headshot && a.headshot.href) || "",
      inj: inj ? { status: inj.status || (inj.type && inj.type.description) || "Injured", date: inj.date || "" } : null,
    };
  }

  function parseGamelog(j) {
    var names = j.names || [], events = j.events || {}, rows = [], seen = {}, season = "";
    var col = function (n) { return names.indexOf(n); };
    (j.seasonTypes || []).forEach(function (st) {
      var dn = String(st.displayName || "");
      if (/preseason/i.test(dn)) return;
      if (!season) season = (dn.match(/\d{4}-\d{2}/) || [""])[0];
      var type = /post/i.test(dn) ? "PO" : /play-?in/i.test(dn) ? "PI" : "RS";
      (st.categories || []).forEach(function (cat) {
        (cat.events || []).forEach(function (ev) {
          if (!ev || seen[ev.eventId]) return;
          seen[ev.eventId] = true;
          var s = ev.stats || [];
          var get = function (n) { return col(n) >= 0 ? s[col(n)] : ""; };
          var num = function (n) { return Number(get(n)) || 0; };
          var pair = function (n) { var m = String(get(n) || "").split("-"); return [Number(m[0]) || 0, Number(m[1]) || 0]; };
          var fg = pair("fieldGoalsMade-fieldGoalsAttempted"), f3 = pair("threePointFieldGoalsMade-threePointFieldGoalsAttempted"), ft = pair("freeThrowsMade-freeThrowsAttempted");
          var m = events[ev.eventId] || {};
          rows.push({
            id: String(ev.eventId), date: m.gameDate || "", opp: (m.opponent && m.opponent.abbreviation) || "", at: m.atVs || "",
            res: m.gameResult || "", score: m.score || "", type: type, min: num("minutes"),
            pts: num("points"), reb: num("totalRebounds"), ast: num("assists"), stl: num("steals"), blk: num("blocks"), to: num("turnovers"), pf: num("fouls"),
            fgm: fg[0], fga: fg[1], fg3m: f3[0], fg3a: f3[1], ftm: ft[0], fta: ft[1],
          });
        });
      });
    });
    rows.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    return { season: season, rows: rows };
  }

  // Sleeper scoring keys that can be computed from an ESPN box score
  function scorer(settings) {
    var cats = function (g) { return [g.pts, g.reb, g.ast, g.stl, g.blk].filter(function (v) { return v >= 10; }).length; };
    var F = {
      pts: function (g) { return g.pts; }, reb: function (g) { return g.reb; }, ast: function (g) { return g.ast; },
      stl: function (g) { return g.stl; }, blk: function (g) { return g.blk; }, to: function (g) { return g.to; }, pf: function (g) { return g.pf; },
      fgm: function (g) { return g.fgm; }, fga: function (g) { return g.fga; }, fgmi: function (g) { return g.fga - g.fgm; },
      ftm: function (g) { return g.ftm; }, fta: function (g) { return g.fta; }, ftmi: function (g) { return g.fta - g.ftm; },
      fg3m: function (g) { return g.fg3m; }, fg3a: function (g) { return g.fg3a; }, fg3mi: function (g) { return g.fg3a - g.fg3m; },
      // Sleeper's names for threes: tpm (made, e.g. +0.5 each in this league), tpa (attempted), tpmi (missed)
      tpm: function (g) { return g.fg3m; }, tpa: function (g) { return g.fg3a; }, tpmi: function (g) { return g.fg3a - g.fg3m; },
      dd: function (g) { return cats(g) >= 2 ? 1 : 0; }, td: function (g) { return cats(g) >= 3 ? 1 : 0; }, qd: function (g) { return cats(g) >= 4 ? 1 : 0; },
      bonus_pt_40p: function (g) { return g.pts >= 40 ? 1 : 0; }, bonus_pt_50p: function (g) { return g.pts >= 50 ? 1 : 0; },
      bonus_reb_20p: function (g) { return g.reb >= 20 ? 1 : 0; }, bonus_ast_15p: function (g) { return g.ast >= 15 ? 1 : 0; },
    };
    settings = settings || {};
    var used = Object.keys(settings).filter(function (k) { return Number(settings[k]) !== 0; });
    var scored = used.filter(function (k) { return F[k]; });
    return {
      unscored: used.filter(function (k) { return !F[k]; }),
      score: function (g) { return Math.round(scored.reduce(function (s, k) { return s + Number(settings[k]) * F[k](g); }, 0) * 100) / 100; },
    };
  }

  function summarize(games) {
    var g = games.filter(function (x) { return x.min > 0; }), n = g.length;
    if (!n) return null;
    var T = {};
    ["min", "pts", "reb", "ast", "stl", "blk", "to", "pf", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "fp"].forEach(function (k) {
      T[k] = g.reduce(function (s, x) { return s + (x[k] || 0); }, 0);
    });
    var per = function (k) { return T[k] / n; };
    var div = function (a, b) { return b ? a / b : null; };
    var fps = g.map(function (x) { return x.fp || 0; });
    var mean = per("fp");
    var sd = Math.sqrt(fps.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / n);
    var lastN = function (k) { var s = fps.slice(0, k); return s.length ? s.reduce(function (a, b) { return a + b; }, 0) / s.length : null; };
    var cats = function (x) { return [x.pts, x.reb, x.ast, x.stl, x.blk].filter(function (v) { return v >= 10; }).length; };
    return {
      g: n,
      avg: { min: per("min"), pts: per("pts"), reb: per("reb"), ast: per("ast"), stl: per("stl"), blk: per("blk"), to: per("to"), fp: mean, fg3m: per("fg3m") },
      pct: { fg: div(T.fgm, T.fga), fg3: div(T.fg3m, T.fg3a), ft: div(T.ftm, T.fta) },
      adv: {
        ts: div(T.pts, 2 * (T.fga + 0.44 * T.fta)), efg: div(T.fgm + 0.5 * T.fg3m, T.fga), par3: div(T.fg3a, T.fga), ftr: div(T.fta, T.fga),
        astTo: div(T.ast, T.to), fpMin: div(T.fp, T.min), fpSd: sd, last5: lastN(5), last10: lastN(10),
        high: Math.max.apply(null, fps), low: Math.min.apply(null, fps),
        dd: g.filter(function (x) { return cats(x) >= 2; }).length, td: g.filter(function (x) { return cats(x) >= 3; }).length,
      },
      per36: { pts: div(T.pts * 36, T.min), reb: div(T.reb * 36, T.min), ast: div(T.ast * 36, T.min),
               stl: div(T.stl * 36, T.min), blk: div(T.blk * 36, T.min), fp: div(T.fp * 36, T.min) },
      eligibility: mean > 30 ? "Supermax eligible (30+ FPPG)" : mean > 22.5 ? "Max eligible (22.5+ FPPG)" : "",
    };
  }

  // ESPN game log JSON -> the card's game log object
  function gameLog(j, scoringSettings) {
    if (!j) return { ok: false, msg: "ESPN didn't return a game log." };
    var gl = parseGamelog(j), fp = scorer(scoringSettings);
    gl.rows.forEach(function (g) { g.fp = fp.score(g); });
    return {
      ok: true, season: gl.season, rows: gl.rows,
      summary: summarize(gl.rows.filter(function (g) { return g.type === "RS"; })),
      playoffs: gl.rows.some(function (g) { return g.type !== "RS"; }) ? summarize(gl.rows.filter(function (g) { return g.type !== "RS"; })) : null,
      unscored: fp.unscored,
    };
  }

  // Compact Sleeper transactions (from txns.json) involving one player, newest first.
  // t = { ts, s: season, ty: type, a: adds, d: drops, r: roster ids, p: [[season, round, orig, owner, prevOwner]], b: bid }
  function txns(list, pid, team, nm) {
    pid = String(pid);
    var out = [];
    list.forEach(function (t) {
      var a = t.a || {}, d = t.d || {};
      if (a[pid] == null && d[pid] == null) return;
      var base = { ts: t.ts, season: t.s };
      if (t.ty === "trade") {
        var parts = (t.r || []).map(function (rid) {
          rid = String(rid);
          var items = Object.keys(a).filter(function (p) { return String(a[p]) === rid; }).map(function (p) { return { player: nm(p) }; });
          (t.p || []).forEach(function (pk) {
            if (String(pk[3]) === rid && String(pk[4]) !== rid) items.push({ pick: pk[0] + " " + MU.ordinal(pk[1]) + " (" + (String(pk[2]) === rid ? "own" : team(pk[2]) + "'s") + ")" });
          });
          return { team: team(rid), items: items };
        });
        out.push(Object.assign(base, { type: "Trade", text: a[pid] != null ? team(d[pid]) + " → " + team(a[pid]) : "Dropped by " + team(d[pid]) + " as part of a trade", parts: parts }));
        return;
      }
      var pre = t.ty === "commissioner" ? "Commissioner " : t.ty === "waiver" ? "Waiver " : "";
      if (a[pid] != null && d[pid] != null) out.push(Object.assign(base, { type: pre + "Move", text: team(d[pid]) + " → " + team(a[pid]) }));
      else if (a[pid] != null) {
        var dropped = Object.keys(d).filter(function (p) { return String(d[p]) === String(a[pid]); }).map(nm);
        out.push(Object.assign(base, { type: pre + "Add", text: "Added by " + team(a[pid]) + (t.b != null ? " · $" + t.b + " bid" : "") + (dropped.length ? " (dropped " + dropped.join(", ") + ")" : "") }));
      } else {
        var added = Object.keys(a).filter(function (p) { return String(a[p]) === String(d[pid]); }).map(nm);
        out.push(Object.assign(base, { type: pre + "Drop", text: "Dropped by " + team(d[pid]) + (added.length ? " (added " + added.join(", ") + ")" : "") }));
      }
    });
    out.sort(function (x, y) { return y.ts - x.ts; });
    return { ok: true, rows: out };
  }

  return { card: card, espnRecord: espnRecord, parseGamelog: parseGamelog, scorer: scorer, summarize: summarize, gameLog: gameLog, txns: txns, clean: clean, fixAbbr: fixAbbr };
});
