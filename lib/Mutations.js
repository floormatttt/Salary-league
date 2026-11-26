/* Mutations: every change to the league data, as pure functions on the data
 * object D. Used by the commissioner page (browser), the Sleeper sync (node)
 * and the tests, so the rules live in one place.
 *
 * D = {
 *   contracts: { seasons: ["2026-27", ...7], rows: [{ id, n, nba, sal[7], st[7], det, fill? }] },
 *   holds:     [{ id, code, name, added, note }],
 *   cash:      [{ id, date, season, code, amt, note, ref }],
 *   teams:     [{ rid, code, name, rank }],
 *   log:       [{ ts, type, teams, players, details, status }]   newest first
 *   adminLog:  [{ ts, who, action, details }]                     newest first
 * }
 * Each admin mutation returns { log: "what changed" } and throws Error with a
 * readable message when the change isn't allowed.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./LeagueMath.js"));
  else root.Mutations = factory(root.LeagueMath);
})(this, function (LM) {
  var N = 7; // seasons on the contracts table
  var STATUSES = ["PO", "TO", "MAX", "SMAX", "HOLD"];
  var CASH_LIMIT = 10;
  var TEAM_CODES = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW", "HOU", "IND", "LAC", "LAL", "MEM",
    "MIA", "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS"];
  // Sleeper NBA abbreviations that differ from the contracts table's
  var NBA_ABBR_FIX = { GS: "GSW", NY: "NYK", SA: "SAS", NO: "NOP", NOR: "NOP", PHO: "PHX", UTAH: "UTA", WSH: "WAS", BRK: "BKN", CHO: "CHA" };
  var HOLD_RE = /\s*\(cap hold\)\s*/i;

  function fail(msg) { throw new Error(msg); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function nextId(list) { return list.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 0) + 1; }
  function plain(name) { return String(name || "").replace(HOLD_RE, " ").replace(/\s+/g, " ").trim(); }
  function holdName(name) { return plain(name) + " (cap hold)"; }
  function isHold(name) { return HOLD_RE.test(String(name || "")); }
  function nbaCode(t) { t = String(t || "").trim().toUpperCase(); return NBA_ABBR_FIX[t] || t || "Z"; }
  function today() { return new Date().toISOString(); }
  function money(v) { return (v < 0 ? "-$" : "$") + Math.abs(r1(v)).toFixed(1) + "M"; }
  function checkTeam(code) { if (TEAM_CODES.indexOf(code) < 0) fail("Pick a team."); return code; }

  function rowById(D, id) {
    var row = D.contracts.rows.filter(function (r) { return r.id === Number(id); })[0];
    if (!row) fail("That contract isn't there anymore. Reload and try again.");
    return row;
  }
  // Active (non-hold) and hold rows for a player name
  function find(D, name) {
    var k = LM.norm(name), out = { active: [], holds: [] };
    D.contracts.rows.forEach(function (r) { if (LM.norm(r.n) === k) (isHold(r.n) ? out.holds : out.active).push(r); });
    return out;
  }
  // Insert a row at the end of its NBA team's block (or the end of the list)
  function insertInBlock(D, row) {
    var rows = D.contracts.rows, at = -1;
    rows.forEach(function (r, i) { if (r.nba === row.nba) at = i; });
    row.id = nextId(rows);
    if (at < 0) rows.push(row); else rows.splice(at + 1, 0, row);
    return { row: row, inBlock: at >= 0 };
  }
  function salValue(v) {
    if (v == null || v === "") return null;
    var s = String(v).trim();
    if (/^(UFA|RFA)$/i.test(s)) return s.toUpperCase();
    var n = Number(s.replace(/[$,\s]/g, ""));
    if (s === "" || isNaN(n)) fail('"' + v + '" isn\'t a salary. Use a number, UFA or RFA.');
    return r1(n);
  }
  function pad(a, f) { a = (a || []).slice(0, N); while (a.length < N) a.push(f); return a; }
  function emptyRow(n, nba) { return { n: n, nba: nba, sal: pad([], null), st: pad([], ""), det: "" }; }

  /* ============================ contracts ============================ */

  // c = { id?, n, nba, sal[7], st[7], det }. No id -> new row in its NBA team's block.
  function saveContract(D, c) {
    var name = String(c.n || "").trim();
    if (!name) fail("A contract needs a player name.");
    var sal = pad(c.sal, "").map(salValue);
    var st = pad(c.st, "").map(function (s) {
      s = String(s || "").trim().toUpperCase();
      if (s && STATUSES.indexOf(s) < 0) fail('Unknown status "' + s + '".');
      return s;
    });
    var fields = { n: name, nba: nbaCode(c.nba), sal: sal, st: st, det: String(c.det || "") };
    var row;
    if (c.id) { row = rowById(D, c.id); Object.keys(fields).forEach(function (k) { row[k] = fields[k]; }); }
    else row = insertInBlock(D, fields).row;
    return { id: row.id, log: (c.id ? "Edited " : "Added ") + name + " (" + row.nba + ") " +
      sal.filter(function (v) { return v != null; }).map(function (v) { return typeof v === "number" ? money(v) : v; }).join(" / ") +
      (row.det ? " · " + row.det : "") };
  }

  // Restructure: new salaries/statuses for the years he already has. No years added or removed.
  // Tags the details "OKC Restructure" (team that did it) like the sheet did.
  function restructure(D, r) {
    var row = rowById(D, r.id), sal = pad(row.sal, null), st = pad(row.st, ""), before = sal.slice(), changed = false;
    var nsal = pad(r.sal, undefined), nst = pad(r.st, undefined);
    for (var i = 0; i < N; i++) {
      if (typeof sal[i] !== "number") {
        if (nsal[i] !== undefined && nsal[i] !== null && String(nsal[i]).trim() !== "" && String(nsal[i]).trim().toUpperCase() !== String(sal[i] == null ? "" : sal[i]).toUpperCase())
          fail("A restructure only changes the years he already has.");
        continue;
      }
      if (nsal[i] !== undefined) {
        var v = salValue(nsal[i]);
        if (typeof v !== "number" || !(v > 0)) fail("Every existing year needs a salary in $M.");
        if (v !== sal[i]) { sal[i] = v; changed = true; }
      }
      if (nst[i] !== undefined) {
        var s2 = String(nst[i] || "").trim().toUpperCase();
        if (s2 && STATUSES.indexOf(s2) < 0) fail('Unknown status "' + s2 + '".');
        if (s2 !== (st[i] || "")) { st[i] = s2; changed = true; }
      }
    }
    if (!changed) fail("Nothing changed.");
    row.sal = sal; row.st = st;
    var tag = (r.team ? String(r.team).toUpperCase() + " " : "") + "Restructure";
    var det = String(row.det || "").replace(/(;\s*)?([A-Z]{2,3} )?Restructure/g, "").replace(/^;\s*/, "");
    row.det = det ? det + "; " + tag : tag;
    var fmt = function (a) { return a.filter(function (v) { return typeof v === "number"; }).map(money).join(" / "); };
    return { id: row.id, log: "Restructured " + row.n + " (" + row.nba + "): " + fmt(before) + " → " + fmt(sal) };
  }

  // Season index of his free-agency year: the first season without a salary (null if he's a free agent now)
  function faYear(row) {
    for (var i = 0; i < N; i++) if (typeof row.sal[i] !== "number") return i >= 1 ? i : null;
    return null;
  }

  // Extension: `years` seasons at `amt` ($M) starting in his free-agency year, then UFA.
  // Tags the details "Ext 27-28" (or "Max Ext" / "SMax Ext") like the sheet did.
  function extend(D, e) {
    var row = rowById(D, e.id);
    var start = faYear(row), years = Number(e.years), amt = salValue(e.amt), kind = String(e.st || "").toUpperCase();
    if (start == null) fail(row.n + " has no free-agency year coming up to extend into.");
    if (!(years >= 1 && years <= 5)) fail("An extension is 1 to 5 years.");
    if (typeof amt !== "number" || !(amt > 0)) fail("Enter the salary per year in $M.");
    if (kind && kind !== "MAX" && kind !== "SMAX") fail("An extension is a regular, max or supermax deal.");
    var sal = pad(row.sal, null), st = pad(row.st, "");
    for (var i = start; i < N; i++) {
      if (i < start + years) { sal[i] = amt; st[i] = kind; }
      else if (i === start + years) { sal[i] = "UFA"; st[i] = ""; }
      else { sal[i] = null; st[i] = ""; }
    }
    row.sal = sal; row.st = st;
    var seasons = D.contracts.seasons || [];
    var short = function (s) { return String(s || "").replace(/^\d\d(\d\d)-(\d\d)$/, "$1-$2"); };
    var tag = (kind === "MAX" ? "Max " : kind === "SMAX" ? "SMax " : "") + "Ext " + short(seasons[start]);
    row.det = row.det ? row.det.replace(/(;\s*)?(S?Max )?Ext \d\d-\d\d/g, "").replace(/^;\s*/, "") : "";
    row.det = row.det ? row.det + "; " + tag : tag;
    var last = seasons[Math.min(N - 1, start + years - 1)];
    return { id: row.id, log: "Extended " + row.n + " (" + row.nba + "): " + money(amt) + " × " + years + (years === 1 ? " year" : " years") +
      " (" + short(seasons[start]) + " to " + short(last) + ")" + (kind ? " · " + kind : "") };
  }

  function deleteContract(D, d) {
    var row = rowById(D, d.id);
    D.contracts.rows.splice(D.contracts.rows.indexOf(row), 1);
    return { log: "Deleted " + row.n + " (" + row.nba + ")" };
  }

  /* ============================ cap holds ============================ */

  // Rename the player's active row to "Name (cap hold)". Salaries and statuses stay.
  function makeHold(D, name) {
    var f = find(D, name);
    if (f.active.length) {
      var row = f.active[0];
      var was = row.n;
      row.n = holdName(was);
      return { ok: true, name: row.n, msg: "contract → cap hold" + (f.active.length > 1 ? " (he has " + f.active.length + " rows; only the first was converted)" : "") };
    }
    if (f.holds.length) return { ok: true, name: f.holds[0].n, msg: "already a cap hold" };
    return { ok: false, name: holdName(name), msg: "⚠ not on the contracts list" };
  }

  // Add a hold to a team's list (no duplicates). Returns false if it was already there.
  function appendHold(D, code, name, note, when) {
    var k = LM.norm(name);
    if (D.holds.some(function (h) { return h.code === code && LM.norm(h.name) === k; })) return false;
    D.holds.push({ id: nextId(D.holds), code: code, name: holdName(name), added: when || today(), note: note || "" });
    return true;
  }

  function addHold(D, h) {
    var code = checkTeam(String(h.code || "").trim());
    var name = plain(h.name);
    if (!name) fail("Pick a player.");
    var m = makeHold(D, name);
    if (!m.ok) fail(name + " isn't on the contracts list. Add his contract first.");
    var added = appendHold(D, code, m.name, h.note || "Added by a commissioner");
    return { log: m.name + " → " + code + ": " + m.msg + (added ? "" : " (already on " + code + "'s holds)") };
  }

  // Takes the hold off the team. Its contract row stays; delete it separately if it's gone for good.
  function removeHold(D, h) {
    var i = D.holds.findIndex(function (x) { return x.id === Number(h.id); });
    if (i < 0) fail("That cap hold was already removed. Reload and try again.");
    var x = D.holds.splice(i, 1)[0];
    return { log: x.name + " removed from " + x.code };
  }

  // Waived & re-signed (the cap-hold-and-min-contract procedure):
  //  1. his contract row becomes "Name (cap hold)" (team, salaries, statuses untouched)
  //  2. a new row at the end of his NBA team's block: Name | team | $2.0 | UFA, marked as a minimum (blue)
  //  3. the hold goes to the team that carries it (w.code; the page asks for it)
  function waiveResign(D, w) {
    var name = plain(w.name);
    if (!name) fail("Pick a player.");
    var code = checkTeam(String(w.code || "").trim());
    var f = find(D, name);
    if (!f.active.length) fail(name + " has no active contract to turn into a cap hold.");
    var old = f.active[0];
    var nm = old.n;
    old.n = holdName(nm);
    var row = emptyRow(nm, old.nba);
    row.sal[0] = 2; row.sal[1] = "UFA"; row.fill = "min";
    var ins = insertInBlock(D, row);
    appendHold(D, code, old.n, "Waived & re-signed");
    return { holdId: old.id, newId: ins.row.id, log: nm + ": old contract → cap hold on " + code + "; new $2.0M / UFA minimum (" + old.nba + ")" };
  }

  /* ============================== cash ============================== */

  function cashBalance(D, code, season) {
    return r1(D.cash.reduce(function (s, x) { return x.code === code && x.season === season ? s + Number(x.amt) : s; }, 0));
  }

  // t = { season, from, to, amt, note, ref, override }. Two rows: +amt for the sender
  // (adds to its payroll), -amt for the receiver.
  function recordCash(D, t) {
    var amt = r1(Number(t.amt));
    if (!(amt > 0)) fail("Amount must be more than $0.");
    checkTeam(t.from); checkTeam(t.to);
    if (t.from === t.to) fail("Pick two different teams.");
    var season = String(t.season || "").trim();
    if (!/^\d{4}-\d{2}$/.test(season)) fail("Season looks like 2026-27.");
    var after = {};
    after[t.from] = r1(cashBalance(D, t.from, season) + amt);
    after[t.to] = r1(cashBalance(D, t.to, season) - amt);
    var bad = Object.keys(after).filter(function (k) { return Math.abs(after[k]) > CASH_LIMIT + 1e-9; });
    if (bad.length && !t.override) {
      fail(bad.map(function (k) { return k + " would be at " + (after[k] > 0 ? "+" : "-") + "$" + Math.abs(after[k]).toFixed(1) + "M"; }).join(", ") +
        " (limit ±$" + CASH_LIMIT + "M). Check \"override\" to record it anyway.");
    }
    var when = t.date || today(), id = nextId(D.cash);
    D.cash.push({ id: id, date: when, season: season, code: t.from, amt: amt, note: t.note || "Sent to " + t.to, ref: t.ref || "" },
                { id: id + 1, date: when, season: season, code: t.to, amt: -amt, note: t.note || "Received from " + t.from, ref: t.ref || "" });
    return { log: season + ": " + t.from + " sent " + money(amt) + " to " + t.to + (bad.length ? " (override)" : "") + (t.note ? " · " + t.note : "") };
  }

  function checkSeason(s) {
    s = String(s || "").trim();
    if (!/^\d{4}-\d{2}$/.test(s)) fail("Season looks like 2026-27.");
    return s;
  }
  // One team's balance up or down. dir "add": the team gets cash (balance down, payroll down);
  // dir "take": the team pays cash (balance up, payroll up).
  function adjustCash(D, a) {
    var code = checkTeam(a.code), season = checkSeason(a.season), amt = r1(Number(a.amt));
    if (!(amt > 0)) fail("Amount must be more than $0.");
    if (a.dir !== "add" && a.dir !== "take") fail("Add or take?");
    var delta = a.dir === "add" ? -amt : amt, after = r1(cashBalance(D, code, season) + delta);
    if (Math.abs(after) > CASH_LIMIT + 1e-9 && !a.override)
      fail(code + " would be at " + (after > 0 ? "+" : "-") + "$" + Math.abs(after).toFixed(1) + "M (limit ±$" + CASH_LIMIT + "M). Check \"override\" to record it anyway.");
    D.cash.push({ id: nextId(D.cash), date: a.date || today(), season: season, code: code, amt: delta, note: a.note || (a.dir === "add" ? "Commissioner: added cash" : "Commissioner: took cash"), ref: "" });
    return { log: season + ": " + (a.dir === "add" ? "added " + money(amt) + " to " : "took " + money(amt) + " from ") + code + " · balance " + (after > 0 ? "+" : after < 0 ? "-" : "") + money(Math.abs(after)) };
  }
  // Every team back to $0.0 for a season: one offsetting row per team (the history stays in the ledger)
  function resetCash(D, r) {
    var season = checkSeason(r.season), when = r.date || today(), id = nextId(D.cash), n = 0;
    TEAM_CODES.forEach(function (code) {
      var b = cashBalance(D, code, season);
      if (!b) return;
      D.cash.push({ id: id++, date: when, season: season, code: code, amt: r1(-b), note: "Reset to $0", ref: "Reset " + when.slice(0, 10) });
      n++;
    });
    if (!n) fail("Every team is already at $0.0 for " + season + ".");
    return { log: season + ": reset cash to $0.0 for " + n + " team" + (n === 1 ? "" : "s") };
  }
  function deleteCash(D, d) {
    var i = D.cash.findIndex(function (x) { return x.id === Number(d.id); });
    if (i < 0) fail("That ledger row was already deleted. Reload and try again.");
    var x = D.cash.splice(i, 1)[0];
    return { log: "Deleted ledger row: " + x.season + " " + x.code + " " + (x.amt > 0 ? "+" : "") + money(x.amt) + " " + x.note };
  }

  /* ============================ rankings ============================ */

  function setRanks(D, ranks) {
    var changed = [];
    (ranks || []).forEach(function (r) {
      var t = D.teams.filter(function (x) { return x.code === r.code; })[0];
      if (!t) return;
      var v = r.rank === "" || r.rank == null ? null : Number(r.rank);
      if (v !== null && !(v >= 1 && v <= 99)) fail("Ranks are numbers from 1 to 30.");
      if (v !== t.rank) changed.push(t.name + " " + (t.rank == null ? "—" : t.rank) + "→" + (v == null ? "—" : v));
      t.rank = v;
    });
    return { log: changed.join(", ") || "No changes" };
  }

  /* ============================ sync (Sleeper) ============================ */

  // A new player added in Sleeper: a PENDING row in his NBA team's block, unless
  // he already has an active contract. (An old cap hold doesn't count.)
  function addPending(D, name, nba) {
    var f = find(D, name);
    if (f.active.length) return { created: false, msg: "Already has a contract; no new entry" };
    var row = emptyRow(name, nbaCode(nba));
    row.det = "PENDING — needs contract";
    var ins = insertInBlock(D, row);
    return { created: true, msg: "New contract row in " + (ins.inBlock ? row.nba + " block" : "the list (no " + row.nba + " block)") +
      (f.holds.length ? " (his old cap hold is still there)" : "") + ". Waiting on a commissioner" };
  }

  function ordinal(n) { return n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th"); }

  // Port of the sheet sync's applyTransactions_. txns: Sleeper transactions not seen
  // before (any order). ctx: { nameOf(pid), nbaOf(pid), teamOf(rid) -> {name, code} | null }.
  // Logs Trade / Add / Drop / Commissioner moves (newest first in D.log), turns
  // drops into cap holds for the team that dropped him, and adds PENDING rows for adds.
  function applyTransactions(D, txns, ctx) {
    var fresh = txns.filter(function (t) { return t.status === "complete"; })
      .sort(function (a, b) { return (a.status_updated || a.created) - (b.status_updated || b.created); });
    var team = function (rid) { var t = ctx.teamOf(rid); return t ? t.name : "Roster " + rid + " (unmapped)"; };
    var entries = [], history = {};
    var track = function (pid, from, to, entry) {
      (history[pid] = history[pid] || []).push({ from: from != null ? String(from) : null, to: to != null ? String(to) : null, entry: entry });
    };
    var mk = function (type, teams, players, when) { return { ts: new Date(when).toISOString(), type: type, teams: teams, players: players, details: "", status: "" }; };

    fresh.forEach(function (t) {
      var when = t.status_updated || t.created;
      var adds = t.adds || {}, drops = t.drops || {};
      var pids = Object.keys(adds).concat(Object.keys(drops)).filter(function (p, i, a) { return a.indexOf(p) === i; });
      var prefix = t.type === "commissioner" ? "Commissioner " : t.type === "waiver" ? "Waiver " : "";
      var label = function (w) { return prefix ? prefix + w : w.charAt(0).toUpperCase() + w.slice(1); };

      if (t.type === "trade") {
        var rids = (t.roster_ids || []).map(String);
        var parts = rids.map(function (rid) {
          var got = pids.filter(function (p) { return String(adds[p]) === rid; }).map(ctx.nameOf);
          var picks = (t.draft_picks || []).filter(function (pk) { return String(pk.owner_id) === rid && String(pk.previous_owner_id) !== rid; })
            .map(function (pk) { return pk.season + " " + ordinal(pk.round) + " (" + (String(pk.roster_id) === rid ? "own" : team(pk.roster_id) + "'s") + ")"; });
          var items = got.concat(picks);
          return team(rid) + " gets: " + (items.length ? items.join(", ") : "nothing");
        });
        var e = mk("Trade", rids.map(team).join(" ↔ "), parts.join("  |  "), when);
        e.status = "Logged";
        entries.push(e);
        pids.forEach(function (p) {
          if (adds[p] != null) track(p, drops[p], adds[p], null);
          else { var d = mk("Drop", team(drops[p]), ctx.nameOf(p), when); d.details = "Dropped as part of a trade"; entries.push(d); track(p, drops[p], null, d); }
        });
        return;
      }
      var moved = pids.filter(function (p) { return adds[p] != null && drops[p] != null; });
      if (moved.length) {
        var m = mk(label("move"), (t.roster_ids || []).map(team).join(" ↔ "),
          moved.map(function (p) { return ctx.nameOf(p) + ": " + team(drops[p]) + " → " + team(adds[p]); }).join(", "), when);
        m.status = "Logged";
        entries.push(m);
        moved.forEach(function (p) { track(p, drops[p], adds[p], null); });
      }
      pids.filter(function (p) { return adds[p] != null && drops[p] == null; }).forEach(function (p) {
        var a = mk(label("add"), team(adds[p]), ctx.nameOf(p), when); entries.push(a); track(p, null, adds[p], a);
      });
      pids.filter(function (p) { return drops[p] != null && adds[p] == null; }).forEach(function (p) {
        var d = mk(label("drop"), team(drops[p]), ctx.nameOf(p), when); entries.push(d); track(p, drops[p], null, d);
      });
    });

    // Net effect per player over this batch decides the data changes, so an add
    // that was undone in the same batch creates nothing.
    Object.keys(history).forEach(function (pid) {
      var h = history[pid];
      var started = h[0].from != null, ends = h[h.length - 1].to != null;
      var last = h.filter(function (x) { return x.entry; }).pop();
      var name = ctx.nameOf(pid);
      if (started && !ends) {
        var dropper = ctx.teamOf(h[h.length - 1].from);
        var m = makeHold(D, name);
        var where = dropper ? (appendHold(D, dropper.code, m.name, "Dropped (sync)", last && last.entry.ts) ? "added to " + dropper.code + " cap holds" : "already in " + dropper.code + " cap holds")
                            : "⚠ team not mapped; add the cap hold by hand";
        if (last) { last.entry.details = (last.entry.details ? last.entry.details + "; " : "") + m.msg + "; " + where; last.entry.status = m.ok && dropper ? "Cap hold created" : "⚠ Review"; }
      } else if (!started && ends) {
        var res = addPending(D, name, ctx.nbaOf(pid));
        if (last) { last.entry.details = res.msg; last.entry.status = res.created ? "⏳ Needs contract" : "OK"; }
      }
      h.forEach(function (x) {
        if (x.entry && !x.entry.status) { x.entry.details = x.entry.details || "Reversed within the same sync; no changes"; x.entry.status = "No change"; }
      });
    });
    D.log = entries.slice().reverse().concat(D.log);
    return entries.length;
  }

  return {
    TEAM_CODES: TEAM_CODES, STATUSES: STATUSES, NBA_ABBR_FIX: NBA_ABBR_FIX, plain: plain, holdName: holdName, isHold: isHold, nbaCode: nbaCode,
    saveContract: saveContract, extend: extend, restructure: restructure, faYear: faYear, deleteContract: deleteContract, addHold: addHold, removeHold: removeHold, waiveResign: waiveResign,
    recordCash: recordCash, adjustCash: adjustCash, resetCash: resetCash, deleteCash: deleteCash, setRanks: setRanks, cashBalance: cashBalance,
    makeHold: makeHold, appendHold: appendHold, addPending: addPending, applyTransactions: applyTransactions, find: find, ordinal: ordinal,
  };
});
