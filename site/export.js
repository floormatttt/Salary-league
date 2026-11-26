/* "Download spreadsheet": a read-only .xlsx snapshot of the league, built in the
 * browser with xlsx-js-style (SheetJS plus cell styles; loaded only when someone
 * clicks the button). Styling is skipped quietly by plain SheetJS (the tests).
 * Tabs: Master list · Standings · one per team (like the old team tabs) ·
 * Cap Holds · Cash Ledger · Draft Picks · League Log · Rules */
var Export = (function () {
  var LIB = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.min.js";
  var MONEY = '"$"0.0;-"$"0.0';
  var FONT = "Calibri";
  var INK = "0F1729", MUTED = "6B7280", LINE = "E5E8EE", HEAD = "0D1424";
  // kind of money (LeagueMath.moneyKind) -> [fill, text]
  // guaranteed (g) isn't colored
  var KIND = { po: ["DCFCE7", "14532D"], to: ["FEE2E2", "991B1B"], max: ["FCE7F3", "9D174D"], smax: ["EDE9FE", "5B21B6"],
               hold: ["F1F3F6", "5D6778"], ufa: ["1E3A8A", "FFFFFF"], rfa: ["BAE6FD", "075985"] };
  var TIER = { cap: ["E6F4EA", "166534"], first: ["FBF3DB", "854D0E"], second: ["FDEBDD", "9A3412"], tax: ["FBE4E4", "991B1B"], over: ["F7E3F7", "86198F"] };

  function loadLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = LIB;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { rej(new Error("Couldn't load the spreadsheet library. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }

  /* ---------- styling helpers ---------- */
  function font(o) { return Object.assign({ name: FONT, sz: 11, color: { rgb: INK } }, o || {}); }
  function fill(rgb) { return { patternType: "solid", fgColor: { rgb: rgb } }; }
  var hair = { style: "thin", color: { rgb: LINE } };
  function style(ws, X, r, c, s) {
    var a = X.utils.encode_cell({ r: r, c: c });
    if (!ws[a]) ws[a] = { t: "s", v: "" };
    var cur = ws[a].s || {};
    ws[a].s = Object.assign({}, cur, s, { font: Object.assign({}, cur.font || font(), s.font || {}) });
  }
  function moneyCell(ws, X, r, c, kind) {
    var k = KIND[kind];
    if (kind === "fa") style(ws, X, r, c, { font: { color: { rgb: "8B93A3" }, bold: true, sz: 9 }, alignment: { horizontal: "center", vertical: "center" } });
    else if (kind === "ufa" || kind === "rfa") style(ws, X, r, c, { fill: fill(k[0]), font: { color: { rgb: k[1] }, bold: true, sz: 9 }, alignment: { horizontal: "center", vertical: "center" } });
    else if (k) style(ws, X, r, c, { fill: fill(k[0]), font: { color: { rgb: k[1] }, italic: kind === "hold", bold: kind === "max" || kind === "smax" } });
  }
  function tierCell(ws, X, r, c, key, bold) {
    var t = TIER[key];
    if (t) style(ws, X, r, c, { fill: fill(t[0]), font: { color: { rgb: t[1] }, bold: !!bold } });
  }
  function teamCell(ws, X, r, c, code) {
    var tc = typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[code];
    if (tc) style(ws, X, r, c, { fill: fill(tc[0].slice(1)), font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } });
  }

  // Array-of-arrays -> sheet with a dark header row, hairline rows, $0.0 money and widths
  function sheet(X, rows, moneyCols, widths) {
    var ws = X.utils.aoa_to_sheet(rows);
    var range = X.utils.decode_range(ws["!ref"] || "A1");
    for (var r = range.s.r; r <= range.e.r; r++) {
      for (var c = range.s.c; c <= range.e.c; c++) {
        var cell = ws[X.utils.encode_cell({ r: r, c: c })];
        var isMoney = (moneyCols || []).indexOf(c) >= 0;
        if (cell && cell.t === "n" && isMoney) cell.z = MONEY;
        if (r === 0) {
          style(ws, X, r, c, { fill: fill(HEAD), font: { color: { rgb: "FFFFFF" }, bold: true, sz: 10 },
            alignment: { horizontal: c === 0 ? "left" : "center", vertical: "center", wrapText: true }, border: { bottom: { style: "medium", color: { rgb: "E8590C" } } } });
        } else if (cell) {
          style(ws, X, r, c, { font: { bold: c === 0 }, border: { bottom: hair },
            alignment: { vertical: "center", horizontal: isMoney || cell.t === "n" ? "right" : "left" } });
          if (cell.t === "n" && isMoney) ws[X.utils.encode_cell({ r: r, c: c })].s.numFmt = MONEY;
        }
      }
    }
    if (widths) ws["!cols"] = widths.map(function (w) { return { wch: w }; });
    ws["!rows"] = [{ hpt: 28 }];
    ws["!freeze"] = { xSplit: 1, ySplit: 1 };
    return ws;
  }
  function range(a, n) { var o = []; for (var i = 0; i < n; i++) o.push(a + i); return o; }
  function sal(v) { return v == null ? "" : v; }
  function blanks(n) { return range(0, n).map(function () { return ""; }); }

  function build(X, L, log, rules) {
    var LM = LeagueMath;
    var wb = X.utils.book_new();
    var n = L.seasons.length;
    var idx = {};
    L.teams.forEach(function (t) {
      var ro = L.rosters[t.rid] || {};
      ["starters", "bench", "ir", "taxi"].forEach(function (s) { (ro[s] || []).forEach(function (p) { var k = LM.norm(p.name); idx[k] = (idx[k] || 0) + 1; }); });
    });

    // Master list (same columns as the old sheet), salaries colored by kind of money
    var head = ["Player name", "NBA team"].concat(L.seasons, ["Contract details", "Status codes"], L.seasons, ["On a roster? (count)"]);
    var rows = [head].concat(L.contracts.map(function (c) {
      return [c.n, c.nba].concat(c.sal.map(sal), [c.det, ""], c.st, [c.hold ? 0 : idx[LM.norm(c.n)] || 0]);
    }));
    var ml = sheet(X, rows, range(2, n), [28, 8].concat(range(0, n).map(function () { return 10; }), [28, 6], range(0, n).map(function () { return 7; }), [9]));
    L.contracts.forEach(function (c, r) {
      for (var i = 0; i < n; i++) moneyCell(ml, X, r + 1, 2 + i, LM.moneyKind(c, i));
      if (c.hold) style(ml, X, r + 1, 0, { font: { italic: true, color: { rgb: MUTED } } });
    });
    X.utils.book_append_sheet(wb, ml, "Master list");

    // Standings: team colors on the code, level colors on payroll
    var st = [["Rank", "Team", "Code", "Owner", "W", "L", "T", "PF"].concat(L.seasons.map(function (s) { return "Payroll " + s; }), ["Level", "Cash balance", "Max", "Supermax"])];
    var books = L.teams.map(function (t) { return LM.teamBook(L, t.code); });
    L.teams.forEach(function (t, i) {
      var b = books[i];
      st.push([t.rank == null ? "" : t.rank, t.name, t.code, t.owner, t.w, t.l, t.t, t.pf].concat(b.payroll, [b.tier.label, b.cash, b.maxes, b.smaxes]));
    });
    var sw = sheet(X, st, range(8, n).concat([n + 9]), [6, 18, 7, 18, 4, 4, 4, 8].concat(range(0, n).map(function () { return 11; }), [12, 11, 6, 9]));
    L.teams.forEach(function (t, i) {
      teamCell(sw, X, i + 1, 2, t.code);
      style(sw, X, i + 1, 0, { alignment: { horizontal: "center" }, font: { bold: true, color: { rgb: MUTED } } });
      books[i].payroll.forEach(function (p, j) { tierCell(sw, X, i + 1, 8 + j, LM.tierOf(p).key, j === 0); });
      tierCell(sw, X, i + 1, 8 + n, books[i].tier.key, true);
    });
    X.utils.book_append_sheet(wb, sw, "Standings");

    // One tab per team, laid out like the old team tabs
    L.teams.slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).forEach(function (t) {
      var b = LM.teamBook(L, t.code);
      var out = [["Slot", "Player", "NBA team"].concat(L.seasons, ["Contract details"])], meta = [null];
      var SL = { starters: "Starter", bench: "Bench", ir: "IR", taxi: "Taxi" };
      b.players.forEach(function (p) {
        out.push([SL[p.slot], p.name + (p.c ? "" : " (no contract)"), p.c ? p.c.nba : ""].concat(p.c ? p.c.sal.map(sal) : blanks(n), [p.c ? p.c.det : ""]));
        meta.push(p.c);
      });
      b.holds.forEach(function (h) { out.push(["Cap Hold", h.name, h.c ? h.c.nba : ""].concat(h.c ? h.c.sal.map(sal) : [], [""])); meta.push(h.c); });
      var gap = out.length;
      out.push([]);
      out.push(["", "", "Cash considerations", b.cash]);
      out.push(["", "", "Total Payroll:"].concat(b.payroll));
      out.push(["", "", "Level"].concat(b.payroll.map(function (p) { return LM.tierOf(p).label; })));
      out.push(["", "", "Room to $" + L.limits.hardCap + "M max"].concat(b.payroll.map(function (p) { return LM.r1(L.limits.hardCap - p); })));
      var ws = sheet(X, out, range(3, n), [9, 30, 10].concat(range(0, n).map(function () { return 10; }), [28]));
      meta.forEach(function (c, r) {
        if (!r) return;
        style(ws, X, r, 0, { font: { bold: false, color: { rgb: MUTED }, sz: 10 } });
        style(ws, X, r, 1, { font: { bold: true, italic: !c } });
        for (var i = 0; i < n; i++) moneyCell(ws, X, r, 3 + i, LM.moneyKind(c, i));
      });
      var tot = gap + 2;
      for (var c = 2; c < 3 + n; c++) {
        style(ws, X, tot, c, { font: { bold: true }, border: { top: { style: "medium", color: { rgb: INK } }, bottom: hair } });
        style(ws, X, gap + 1, c, { font: { color: { rgb: MUTED } } });
      }
      b.payroll.forEach(function (p, i) { var k = LM.tierOf(p).key; tierCell(ws, X, tot, 3 + i, k, true); tierCell(ws, X, tot + 1, 3 + i, k); style(ws, X, tot + 1, 3 + i, { alignment: { horizontal: "center" } }); });
      teamCell(ws, X, 0, 0, t.code);
      X.utils.book_append_sheet(wb, ws, t.code);
    });

    var holds = sheet(X, [["Team", "Player", "Added", "Note"]].concat(L.holds.map(function (h) { return [h.code, h.name, String(h.added || "").slice(0, 10), h.note]; })), [], [7, 32, 12, 30]);
    L.holds.forEach(function (h, i) { teamCell(holds, X, i + 1, 0, h.code); });
    X.utils.book_append_sheet(wb, holds, "Cap Holds");
    var cash = sheet(X, [["Date", "Season", "Team", "Amount", "Note", "Trade ref"]].concat(L.cash.map(function (x) { return [String(x.date || "").slice(0, 10), x.season, x.code, x.amt, x.note, x.ref]; })), [3], [12, 9, 7, 10, 30, 24]);
    L.cash.forEach(function (x, i) { teamCell(cash, X, i + 1, 2, x.code); style(cash, X, i + 1, 3, { font: { color: { rgb: x.amt < 0 ? "B91C1C" : "15803D" }, bold: true } }); });
    X.utils.book_append_sheet(wb, cash, "Cash Ledger");
    var pk = [["Team", "Draft", "Round", "Pick"]], pkCodes = [];
    L.teams.forEach(function (t) { (L.picks[t.code] || []).forEach(function (p) { pk.push([t.code, p.season, p.round, p.label]); pkCodes.push(t.code); }); });
    var pws = sheet(X, pk, [], [7, 7, 6, 30]);
    pkCodes.forEach(function (code, i) { teamCell(pws, X, i + 1, 0, code); });
    X.utils.book_append_sheet(wb, pws, "Draft Picks");
    if (log) X.utils.book_append_sheet(wb, sheet(X, [["Time", "Type", "Team(s)", "Player(s)", "Details", "Status"]].concat(log.map(function (r) {
      return [r.ts ? new Date(r.ts).toLocaleString() : "", r.type, r.teams, r.players, r.details, r.status]; })), [], [20, 16, 28, 60, 50, 16]), "League Log");
    if (rules) {
      var rw = X.utils.aoa_to_sheet(rules.rows);
      rw["!cols"] = [{ wch: 28 }, { wch: 60 }, { wch: 30 }, { wch: 30 }];
      X.utils.book_append_sheet(wb, rw, "Rules");
    }
    return wb;
  }

  function download(L, getLog, getRules) {
    return Promise.all([loadLib(), getLog().catch(function () { return null; }), getRules().catch(function () { return null; })]).then(function (r) {
      var X = r[0];
      var wb = build(X, L, r[1] && r[1].rows, r[2]);
      X.writeFile(wb, "salary-league-" + new Date().toISOString().slice(0, 10) + ".xlsx", { cellStyles: true });
    });
  }

  return { download: download, build: build };
})();
