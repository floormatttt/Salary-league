/* LeagueMath: payroll, cap tiers and trade checking.
 * Pure functions on the league object from getLeague(); runs in the browser
 * (and in node for tests). No Apps Script calls in here. */
var LeagueMath = (function () {
  var TIERS = [
    { key: "cap",    label: "Under cap",  max: 150, match: null },  // no restrictions
    { key: "first",  label: "1st apron",  max: 200, match: 15 },    // may add up to $15M
    { key: "second", label: "2nd apron",  max: 250, match: 5 },     // may add up to $5M
    { key: "tax",    label: "Luxury tax", max: 300, match: 0 },     // can only lose cap
    { key: "over",   label: "Over max",   max: Infinity, match: 0 },
  ];

  function norm(s) {
    return String(s || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\(cap hold\)/g, "")
      .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
      .replace(/[^a-z]/g, "");
  }
  function isHoldName(s) { return /\(cap hold\)/i.test(String(s || "")); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function r1(v) { return Math.round(v * 10) / 10; }

  function tierOf(payroll) {
    var p = r1(payroll);
    for (var i = 0; i < TIERS.length; i++) if (p <= TIERS[i].max) return TIERS[i];
    return TIERS[TIERS.length - 1];
  }

  // Index Master list rows: key -> { active: [c], holds: [c] }
  function index(L) {
    if (L._idx) return L._idx;
    var idx = {};
    L.contracts.forEach(function (c) {
      var k = norm(c.n);
      var e = idx[k] || (idx[k] = { active: [], holds: [] });
      (c.hold ? e.holds : e.active).push(c);
    });
    Object.defineProperty(L, "_idx", { value: idx, enumerable: false, writable: true });
    return idx;
  }
  function resetIndex(L) { if (L._idx) L._idx = null; }

  function contractFor(L, name) {
    var e = index(L)[norm(name)];
    return e && e.active.length ? e.active[0] : null;
  }
  function holdContractFor(L, holdName) {
    var e = index(L)[norm(holdName)];
    return e && e.holds.length ? e.holds[0] : null;
  }

  function teamByCode(L, code) {
    for (var i = 0; i < L.teams.length; i++) if (L.teams[i].code === code) return L.teams[i];
    return null;
  }

  // Net cash balance this season: + means the team has sent more than it took.
  function cashBalance(L, code, season) {
    season = season || L.season;
    return r1(L.cash.reduce(function (s, x) {
      return x.code === code && x.season === season ? s + num(x.amt) : s;
    }, 0));
  }

  // Full cap sheet for a team. Payroll = all rostered players (incl. IR and taxi)
  // + cap holds + this season's cash balance, the same as the team tabs.
  function teamBook(L, code) {
    var t = teamByCode(L, code);
    var n = L.seasons.length;
    var payroll = new Array(n).fill(0);
    var players = [], holds = [], missing = [];
    var ro = t && L.rosters[t.rid] || { starters: [], bench: [], ir: [], taxi: [] };
    ["starters", "bench", "ir", "taxi"].forEach(function (slot) {
      (ro[slot] || []).forEach(function (p) {
        var c = contractFor(L, p.name);
        if (!c) missing.push(p.name);
        var sal = c ? c.sal.map(num) : new Array(n).fill(0);
        sal.forEach(function (v, i) { payroll[i] += v; });
        players.push({ pid: p.pid, name: p.name, slot: slot, c: c, sal: sal });
      });
    });
    L.holds.filter(function (h) { return h.code === code; }).forEach(function (h) {
      var c = holdContractFor(L, h.name);
      var sal = c ? c.sal.map(num) : new Array(n).fill(0);
      sal.forEach(function (v, i) { payroll[i] += v; });
      holds.push({ name: h.name, c: c, sal: sal, row: h.row });
    });
    var cash = cashBalance(L, code);
    payroll[0] += cash;
    var maxes = 0, smaxes = 0;
    players.forEach(function (p) {
      var s = p.c ? String(p.c.st[0] || "").toUpperCase() : "";
      if (s === "MAX") maxes++;
      if (s === "SMAX") smaxes++;
    });
    return {
      team: t, players: players, holds: holds, cash: cash, missing: missing,
      payroll: payroll.map(r1), tier: tierOf(payroll[0]),
      maxes: maxes, smaxes: smaxes,
      active: (ro.starters || []).length + (ro.bench || []).length,
    };
  }

  /* --------------------------- Trades --------------------------- *
   * trade = { teams: [code...], moves: [
   *   { type: "player", name, from, to },
   *   { type: "pick", label, from, to },
   *   { type: "cash", amt, from, to } ] }
   */
  function evaluateTrade(L, trade) {
    var n = L.seasons.length;
    var lim = L.limits;
    var res = { legal: true, teams: [], problems: [], warnings: [] };
    var codes = trade.teams;

    if (codes.length < 2) { res.legal = false; res.problems.push("Pick at least two teams."); return res; }
    if (!trade.moves.length) { res.legal = false; res.problems.push("Add something to the trade."); return res; }

    codes.forEach(function (code) {
      var b = teamBook(L, code);
      var inS = new Array(n).fill(0), outS = new Array(n).fill(0);
      var cashOut = 0, cashIn = 0, inP = [], outP = [], maxDelta = 0, smaxDelta = 0, activeDelta = 0;
      trade.moves.forEach(function (m) {
        if (m.from !== code && m.to !== code) return;
        if (m.type === "cash") {
          if (m.from === code) cashOut += num(m.amt);
          if (m.to === code) cashIn += num(m.amt);
          return;
        }
        if (m.type !== "player") return;
        var c = contractFor(L, m.name);
        var sal = c ? c.sal.map(num) : new Array(n).fill(0);
        var st = c ? String(c.st[0] || "").toUpperCase() : "";
        var sign = m.to === code ? 1 : -1;
        sal.forEach(function (v, i) { (sign > 0 ? inS : outS)[i] += v; });
        (sign > 0 ? inP : outP).push(m.name);
        if (st === "MAX") maxDelta += sign;
        if (st === "SMAX") smaxDelta += sign;
        activeDelta += sign; // arrivals go to the active roster
        if (!c) res.warnings.push(m.name + " has no contract on the Master list; counted as $0.");
      });
      var cashAfter = r1(b.cash + cashOut - cashIn);
      var post = b.payroll.map(function (p, i) {
        return r1(p - outS[i] + inS[i] + (i === 0 ? cashOut - cashIn : 0));
      });
      var delta = r1(post[0] - b.payroll[0]);
      var tier = b.tier; // judged on PRE-trade payroll
      var issues = [];

      if (tier.match !== null && delta > tier.match + 1e-9) {
        issues.push(tier.match === 0
          ? b.team.name + " is in the " + tier.label + " (" + money(b.payroll[0]) + "), so it can only lose cap. This adds " + money(delta) + "."
          : b.team.name + " is in the " + tier.label + " (" + money(b.payroll[0]) + "), so it can add at most " + money(tier.match) + ". This adds " + money(delta) + ".");
      }
      if (post[0] > lim.hardCap + 1e-9) {
        issues.push(b.team.name + " would be at " + money(post[0]) + ", over the " + money(lim.hardCap) + " max.");
      }
      if (cashAfter > lim.cash + 1e-9 || cashAfter < -lim.cash - 1e-9) {
        issues.push(b.team.name + "'s cash balance would be " + signed(cashAfter) + " (allowed " + signed(-lim.cash) + " to " + signed(lim.cash) + ").");
      }
      if (b.maxes + maxDelta > lim.maxes) issues.push(b.team.name + " would have " + (b.maxes + maxDelta) + " max contracts (limit " + lim.maxes + ").");
      if (b.smaxes + smaxDelta > lim.supermaxes) issues.push(b.team.name + " would have " + (b.smaxes + smaxDelta) + " supermax contracts (limit " + lim.supermaxes + ").");

      var warns = [];
      post.forEach(function (p, i) {
        if (i > 0 && p > lim.hardCap + 1e-9) warns.push(b.team.name + " would be at " + money(p) + " in " + L.seasons[i] + ", over the " + money(lim.hardCap) + " max.");
      });
      if (lim.activeRoster && b.active + activeDelta > lim.activeRoster) {
        warns.push(b.team.name + " would have " + (b.active + activeDelta) + " active players (" + lim.activeRoster + " slots); they'd need to move or drop " + (b.active + activeDelta - lim.activeRoster) + ".");
      }

      issues.forEach(function (x) { res.problems.push(x); });
      warns.forEach(function (x) { res.warnings.push(x); });
      res.teams.push({
        code: code, name: b.team.name, tier: tier, tierAfter: tierOf(post[0]),
        pre: b.payroll, post: post, delta: delta,
        inSal: inS.map(r1), outSal: outS.map(r1), inP: inP, outP: outP,
        cashBefore: b.cash, cashAfter: cashAfter, cashIn: cashIn, cashOut: cashOut,
        ok: issues.length === 0,
      });
    });

    // A player can only be traded by the team that has him
    trade.moves.forEach(function (m) {
      if (m.type !== "player") return;
      var b = teamBook(L, m.from);
      if (!b.players.some(function (p) { return norm(p.name) === norm(m.name); })) {
        res.problems.push(m.name + " isn't on " + (b.team ? b.team.name : m.from) + "'s roster.");
      }
    });
    res.legal = res.problems.length === 0;
    return res;
  }

  function money(v) { return (v < 0 ? "-$" : "$") + Math.abs(r1(v)).toFixed(1) + "M"; }
  function signed(v) { return (v > 0 ? "+" : v < 0 ? "-" : "") + "$" + Math.abs(r1(v)).toFixed(1) + "M"; }

  // What kind of money a contract season is (colors on the site and in the .xlsx):
  // g guaranteed · po player option · to team option · max · smax · hold cap hold · fa UFA/RFA text · "" empty
  function moneyKind(c, i) {
    if (!c) return "";
    var v = c.sal[i], s = String(c.st[i] || "").toUpperCase();
    if (typeof v !== "number") return v ? "fa" : "";
    if (c.hold || s === "HOLD") return "hold";
    return { SMAX: "smax", MAX: "max", PO: "po", TO: "to" }[s] || "g";
  }
  var MONEY_KINDS = [["g", "Guaranteed"], ["po", "Player option"], ["to", "Team option"], ["max", "Max"], ["smax", "Supermax"], ["hold", "Cap hold"], ["fa", "Free agent (UFA/RFA)"]];

  return {
    MONEY_KINDS: MONEY_KINDS, moneyKind: moneyKind,
    TIERS: TIERS, norm: norm, isHoldName: isHoldName, tierOf: tierOf, index: index, resetIndex: resetIndex,
    contractFor: contractFor, teamByCode: teamByCode, cashBalance: cashBalance,
    teamBook: teamBook, evaluateTrade: evaluateTrade, money: money, signed: signed, r1: r1,
  };
})();
if (typeof module !== "undefined") module.exports = LeagueMath;
