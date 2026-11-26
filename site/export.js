/* "Download spreadsheet": a read-only .xlsx snapshot of the league, built in the
 * browser with SheetJS (loaded only when someone clicks the button).
 * Tabs: Master list · Standings · one per team (like the old team tabs) ·
 * Cap Holds · Cash Ledger · Draft Picks · League Log · Rules */
var Export = (function () {
  var SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  var MONEY = '"$"0.0;-"$"0.0';

  function loadLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = SHEETJS;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { rej(new Error("Couldn't load the spreadsheet library. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }

  // Array-of-arrays -> sheet; numbers in `moneyCols` get a $0.0 format
  function sheet(X, rows, moneyCols, widths) {
    var ws = X.utils.aoa_to_sheet(rows);
    var range = X.utils.decode_range(ws["!ref"] || "A1");
    for (var r = range.s.r; r <= range.e.r; r++) {
      (moneyCols || []).forEach(function (c) {
        var cell = ws[X.utils.encode_cell({ r: r, c: c })];
        if (cell && cell.t === "n") cell.z = MONEY;
      });
    }
    if (widths) ws["!cols"] = widths.map(function (w) { return { wch: w }; });
    ws["!freeze"] = { xSplit: 1, ySplit: 1 };
    return ws;
  }
  function range(a, n) { var o = []; for (var i = 0; i < n; i++) o.push(a + i); return o; }
  function sal(v) { return v == null ? "" : v; }

  function build(X, L, log, rules) {
    var wb = X.utils.book_new();
    var n = L.seasons.length;
    var idx = {};
    L.teams.forEach(function (t) {
      var ro = L.rosters[t.rid] || {};
      ["starters", "bench", "ir", "taxi"].forEach(function (s) { (ro[s] || []).forEach(function (p) { var k = LeagueMath.norm(p.name); idx[k] = (idx[k] || 0) + 1; }); });
    });

    // Master list (same columns as the old sheet)
    var head = ["Player name", "NBA team"].concat(L.seasons, ["Contract details", "Status codes"], L.seasons, ["On a roster? (count)"]);
    var rows = [head].concat(L.contracts.map(function (c) {
      return [c.n, c.nba].concat(c.sal.map(sal), [c.det, ""], c.st, [c.hold ? 0 : idx[LeagueMath.norm(c.n)] || 0]);
    }));
    X.utils.book_append_sheet(wb, sheet(X, rows, range(2, n), [28, 8].concat(range(0, n).map(function () { return 9; }), [26, 6], range(0, n).map(function () { return 7; }), [8])), "Master list");

    // Standings
    var st = [["Rank", "Team", "Code", "Owner", "W", "L", "T", "PF"].concat(L.seasons.map(function (s) { return "Payroll " + s; }), ["Level", "Cash balance", "Max", "Supermax"])];
    L.teams.forEach(function (t) {
      var b = LeagueMath.teamBook(L, t.code);
      st.push([t.rank == null ? "" : t.rank, t.name, t.code, t.owner, t.w, t.l, t.t, t.pf].concat(b.payroll, [b.tier.label, b.cash, b.maxes, b.smaxes]));
    });
    X.utils.book_append_sheet(wb, sheet(X, st, range(8, n).concat([n + 9]), [6, 18, 6, 18, 4, 4, 4, 8]), "Standings");

    // One tab per team, laid out like the old team tabs
    L.teams.slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).forEach(function (t) {
      var b = LeagueMath.teamBook(L, t.code);
      var out = [["Slot", "Player", "NBA team"].concat(L.seasons, ["Contract details"])];
      var SL = { starters: "Starter", bench: "Bench", ir: "IR", taxi: "Taxi" };
      b.players.forEach(function (p) { out.push([SL[p.slot], p.name + (p.c ? "" : " (no contract)"), p.c ? p.c.nba : ""].concat(p.c ? p.c.sal.map(sal) : range(0, n).map(function () { return ""; }), [p.c ? p.c.det : ""])); });
      b.holds.forEach(function (h) { out.push(["Cap Hold", h.name, h.c ? h.c.nba : ""].concat(h.c ? h.c.sal.map(sal) : [], [""])); });
      out.push([]);
      out.push(["", "", "Cash considerations", b.cash]);
      out.push(["", "", "Total Payroll:"].concat(b.payroll));
      out.push(["", "", "Level"].concat(b.payroll.map(function (p) { return LeagueMath.tierOf(p).label; })));
      out.push(["", "", "Room to $" + L.limits.hardCap + "M max"].concat(b.payroll.map(function (p) { return LeagueMath.r1(L.limits.hardCap - p); })));
      X.utils.book_append_sheet(wb, sheet(X, out, range(3, n), [9, 30, 10].concat(range(0, n).map(function () { return 9; }), [26])), t.code);
    });

    X.utils.book_append_sheet(wb, sheet(X, [["Team", "Player", "Added", "Note"]].concat(L.holds.map(function (h) { return [h.code, h.name, String(h.added || "").slice(0, 10), h.note]; })), [], [6, 32, 12, 30]), "Cap Holds");
    X.utils.book_append_sheet(wb, sheet(X, [["Date", "Season", "Team", "Amount", "Note", "Trade ref"]].concat(L.cash.map(function (x) { return [String(x.date || "").slice(0, 10), x.season, x.code, x.amt, x.note, x.ref]; })), [3], [12, 9, 6, 9, 30, 24]), "Cash Ledger");
    var pk = [["Team", "Draft", "Round", "Pick"]];
    L.teams.forEach(function (t) { (L.picks[t.code] || []).forEach(function (p) { pk.push([t.code, p.season, p.round, p.label]); }); });
    X.utils.book_append_sheet(wb, sheet(X, pk, [], [6, 7, 6, 30]), "Draft Picks");
    if (log) X.utils.book_append_sheet(wb, sheet(X, [["Time", "Type", "Team(s)", "Player(s)", "Details", "Status"]].concat(log.map(function (r) {
      return [r.ts ? new Date(r.ts).toLocaleString() : "", r.type, r.teams, r.players, r.details, r.status]; })), [], [20, 16, 28, 60, 50, 16]), "League Log");
    if (rules) X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rules.rows), "Rules");
    return wb;
  }

  function download(L, getLog, getRules) {
    return Promise.all([loadLib(), getLog().catch(function () { return null; }), getRules().catch(function () { return null; })]).then(function (r) {
      var X = r[0];
      var wb = build(X, L, r[1] && r[1].rows, r[2]);
      X.writeFile(wb, "salary-league-" + new Date().toISOString().slice(0, 10) + ".xlsx");
    });
  }

  return { download: download, build: build };
})();
