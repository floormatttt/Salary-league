/* Player card: shared formatting helpers + renderers + a small controller.
 * Card: team-colored header + quick numbers, then tabs: Overview (contract, bio) · Game log · Stats · Transactions.
 * Needs api(fn, ...args) -> Promise (defined in SiteApp). */

/* ---------------- formatting helpers (used site-wide) ---------------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function f1(v) { return v == null || isNaN(v) ? "—" : (Math.round(v * 10) / 10).toFixed(1); }
function f2(v) { return v == null || isNaN(v) ? "—" : (Math.round(v * 100) / 100).toFixed(2); }
function pct(v) { return v == null || isNaN(v) ? "—" : (v * 100).toFixed(1) + "%"; }
function shortDate(d) { var x = new Date(d); return isNaN(x) ? "" : (x.getMonth() + 1) + "/" + x.getDate(); }
function longDate(d) {
  var x = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T12:00:00" : d); // date-only strings: no time-zone shift
  return isNaN(x) ? "" : x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function moneyOf(s) { var n = Number(String(s).replace(/[$,]/g, "")); return String(s).trim() === "" || isNaN(n) ? null : n; }
function stat(label, val) { return '<div class="stat"><b>' + esc(val) + "</b><span>" + esc(label) + "</span></div>"; }
function loading(msg) { return '<div class="loading">' + esc(msg || "Loading") + "</div>"; }
function box(title, inner) { return '<div class="box">' + (title ? "<h3>" + esc(title) + "</h3>" : "") + inner + "</div>"; }
function pbtn(name, label) { return '<button class="plink" data-player="' + esc(name) + '">' + esc(label || name) + "</button>"; }

var Card = (function () {
  /* ---------------- helpers ---------------- */
  function tstyle(code) { return typeof teamStyle === "function" && teamStyle(code) ? teamStyle(code) : ' style="--c1:#1a2336;--c2:#e8590c"'; }
  function vars(code) {
    var c = typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[code];
    return c ? "--c1:" + c[0] + ";--c2:" + c[1] : "--c1:#1a2336;--c2:#e8590c";
  }
  // money kind for one contract year (same colors as the rest of the site)
  function kindOf(y, hold) {
    var v = moneyOf(y.salary);
    return LeagueMath.moneyKind({ sal: [v != null ? v : String(y.salary || "").trim()], st: [y.status], hold: hold }, 0);
  }
  function pill(y, hold) {
    var k = kindOf(y, hold), v = moneyOf(y.salary);
    if (!k) return '<span class="muted">—</span>';
    if (k === "ufa" || k === "rfa" || k === "fa") return '<span class="fa m-' + k + '">' + esc(String(y.salary).trim()) + "</span>";
    return '<span class="mny m-' + k + '">$' + v.toFixed(1) + (y.status && y.status !== "HOLD" ? "<em>" + esc(y.status) + "</em>" : "") + "</span>";
  }
  function tile(label, val, cls) { return '<div class="ptile' + (cls ? " " + cls : "") + '"><b>' + val + "</b><span>" + esc(label) + "</span></div>"; }
  function sbox(title, cls, inner) { return '<div class="box pbox ' + (cls || "") + '">' + (title ? "<h3>" + esc(title) + "</h3>" : "") + inner + "</div>"; }

  /* ---------------- renderers (return HTML strings) ---------------- */
  function header(c) {
    var e = c.espn || {};
    var initials = String(c.name || "?").split(" ").map(function (w) { return w[0]; }).join("").slice(0, 3);
    var img = e.img ? '<img class="phero-shot" src="' + esc(e.img) + '" alt="">' : '<div class="phero-shot none">' + esc(initials) + "</div>";
    var top = [c.nbaTeam, e.pos, e.jersey ? "#" + e.jersey : ""].filter(Boolean).map(esc).join(" · ");
    var meta = [e.ht, e.wt, e.age !== "" && e.age != null ? e.age + " yrs" : "", e.exp !== "" && e.exp != null ? (e.exp ? e.exp + (e.exp === 1 ? " yr pro" : " yrs pro") : "Rookie") : ""]
      .filter(Boolean).map(esc).join(" · ");
    var chips = [];
    if (c.fantasy) chips.push('<span class="chip team tc"' + tstyle(c.fantasy.code) + ">" + esc(c.fantasy.team) + (c.fantasy.owner ? " · " + esc(c.fantasy.owner) : "") + "</span>",
                              '<span class="chip glass">' + esc(c.fantasy.slot) + "</span>");
    else chips.push('<span class="chip glass">Not on a league roster</span>');
    if (e.inj) chips.push('<span class="chip inj">' + esc(e.inj.status) + "</span>");
    chips.push('<span class="chip elig" data-role="elig" style="display:none"></span>');
    return '<div class="phero"' + tstyle(c.nbaTeam) + '><div class="phero-num" aria-hidden="true">' + esc(e.jersey ? e.jersey : c.nbaTeam || "") + "</div>" + img +
      '<div class="phero-txt"><div class="phero-top">' + top + "</div><h1>" + esc(c.name) + '</h1><div class="meta">' + meta + '</div><div class="chips">' + chips.join("") + "</div></div></div>" +
      '<div class="pquick" data-role="quick">' + quick(c, null) + "</div>";
  }

  // the numbers people look for first: salary, contract length, fantasy production
  function quick(c, d) {
    var k = c.contracts && c.contracts[0], y0 = k && k.years[0];
    var yrs = k ? k.years.filter(function (y) { return moneyOf(y.salary) != null; }).length : 0;
    var s = d && d.ok && d.summary;
    return tile(c.seasons && c.seasons[0] ? c.seasons[0] : "Salary", y0 ? pill(y0, k.hold) : "—", "money") +
      tile("Years left", k ? String(yrs) : "—") +
      tile("FPPG", s ? f1(s.avg.fp) : d ? "—" : '<span class="muted">…</span>', "hot") +
      tile("PTS", s ? f1(s.avg.pts) : "—") + tile("REB", s ? f1(s.avg.reb) : "—") + tile("AST", s ? f1(s.avg.ast) : "—");
  }

  function gameLog(d, seasonSel, all) {
    var top = '<div class="row"><b>' + esc(d && d.season ? d.season + " season" : "Game log") + "</b>" + seasonSel + "</div>";
    if (!d || !d.ok) return top + sbox("", "", '<div class="err">' + esc(d && d.msg || "Couldn't load the game log.") + "</div>");
    if (!d.rows.length) return top + sbox("", "", '<div class="muted">No games yet this season.</div>');
    var s = d.summary, avg = s ? s.avg.fp : 0, sd = s ? s.adv.fpSd || 0 : 0;
    var strip = s ? '<div class="ptiles">' + tile("FPPG", f1(s.avg.fp), "hot") + tile("Last 5", f1(s.adv.last5)) +
      tile("Last 10", f1(s.adv.last10)) + tile("High", f1(s.adv.high), "good") + tile("Games", s.g) + "</div>" : "";
    var head = "<tr><th>Date</th><th class=l>Opp</th><th class=l>Result</th><th>FP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>" +
               "<th>STL</th><th>BLK</th><th>TO</th><th>FG</th><th>3PT</th><th>FT</th><th>PF</th></tr>";
    var shown = all ? d.rows : d.rows.slice(0, 10);
    var body = shown.map(function (g) {
      var tag = g.type === "RS" ? "" : '<span class="tag">' + esc(g.type) + "</span>";
      var heat = sd && g.fp >= avg + sd * 0.6 ? " hi" : sd && g.fp <= avg - sd * 0.6 ? " lo" : "";
      return "<tr><td>" + esc(shortDate(g.date)) + tag + '</td><td class="l">' + esc((g.at === "@" ? "@ " : "vs ") + g.opp) +
        '</td><td class="l"><span class="wl ' + esc(g.res) + '">' + esc(g.res) + "</span> " + esc(g.score) +
        '</td><td class="fp' + heat + '">' + f1(g.fp) + "</td><td>" + g.min + "</td><td><b>" + g.pts + "</b></td><td>" + g.reb + "</td><td>" + g.ast +
        "</td><td>" + g.stl + "</td><td>" + g.blk + "</td><td>" + g.to + "</td><td>" + g.fgm + "-" + g.fga +
        "</td><td>" + g.fg3m + "-" + g.fg3a + "</td><td>" + g.ftm + "-" + g.fta + "</td><td>" + g.pf + "</td></tr>";
    }).join("");
    var more = d.rows.length > 10
      ? '<button class="more" data-role="moreGames">' + (all ? "Show last 10 only" : "Show all " + d.rows.length + " games") + "</button>" : "";
    return top + strip + '<div class="tbl"><table class="glog">' + head + body + "</table></div>" + more;
  }

  function txns(d) {
    if (!d || !d.ok) return sbox("", "", '<div class="muted">' + esc(d && d.msg || "Couldn't load transactions.") + "</div>");
    if (!d.rows.length) return sbox("", "", '<div class="muted">No league transactions for this player.</div>');
    var tn = function (n) { return typeof tname === "function" ? tname(n) : "<b>" + esc(n) + "</b>"; };
    return sbox("", "", d.rows.map(function (t) {
      var kind = /Trade/.test(t.type) ? "Trade" : /Add/.test(t.type) ? "Add" : /Drop/.test(t.type) ? "Drop" : "";
      var parts = (t.parts || []).map(function (p) {
        var items = p.items.length ? p.items.map(function (it) { return it.player ? pbtn(it.player) : '<span class="pickchip">' + esc(it.pick) + "</span>"; }).join(" ") : "nothing";
        return '<div class="ppart">' + tn(p.team) + ' <span class="muted small">gets</span> ' + items + "</div>";
      }).join("");
      return '<div class="txn"><div class="d"><b>' + esc(longDate(t.ts)) + "</b>" + (t.season ? "<span>" + esc(t.season) + "</span>" : "") + "</div><div>" +
        '<span class="badge ' + kind + '">' + esc(t.type) + "</span><div>" + esc(t.text) + "</div>" + (parts ? '<div class="parts">' + parts + "</div>" : "") + "</div></div>";
    }).join(""));
  }

  function contract(c) {
    if (!c.contracts || !c.contracts.length) return sbox("Contract", "", '<div class="muted">Not on the Master list.</div>');
    return c.contracts.map(function (k) {
      var first = moneyOf(k.years[0] && k.years[0].salary);
      var total = k.years.reduce(function (s, y) { return s + (moneyOf(y.salary) || 0); }, 0);
      var yrs = k.years.filter(function (y) { return moneyOf(y.salary) != null; }).length;
      var end = k.years.filter(function (y) { return /^(UFA|RFA)$/i.test(String(y.salary).trim()); })[0];
      var max = Math.max.apply(null, k.years.map(function (y) { return moneyOf(y.salary) || 0; }).concat([1]));
      var bars = k.years.filter(function (y) { return y.salary || y.status; }).map(function (y) {
        var v = moneyOf(y.salary), kind = kindOf(y, k.hold);
        return '<div class="cy"><span class="cy-s">' + esc(y.season) + '</span><div class="cy-bar">' +
          (v != null ? '<i class="m-' + kind + '" style="width:' + Math.max(4, v / max * 100).toFixed(1) + '%"></i>' : "") + '</div><span class="cy-v">' + pill(y, k.hold) + "</span></div>";
      }).join("");
      var summary = '<div class="ptiles">' +
        tile("% of $" + c.cap + "M cap", first != null ? pct(first / c.cap) : "—") + tile("Years left", yrs) +
        tile("Total", "$" + total.toFixed(1) + "M") + tile(end ? "Then, " + String(end.season).replace(/^20/, "") : "Then", end ? '<span class="fa m-' + String(end.salary).trim().toLowerCase() + '">' + esc(end.salary) + "</span>" : "—") + "</div>";
      return sbox((k.hold ? "Cap hold" : "Contract") + (k.team ? " · " + k.team : ""), "pcon",
        summary + '<div class="cyears">' + bars + "</div>" +
        (k.details ? '<div class="pdet"><span>Details</span>' + esc(k.details) + "</div>" : "") +
        (k.hold ? "" : '<p class="small pnote">On ' + esc(k.onRoster) + " league roster" + (k.onRoster === "1" ? "" : "s") + "</p>"));
    }).join("");
  }

  function bio(c) {
    var e = c.espn || {};
    var rows = [
      ["Team", c.nbaTeam], ["Position", e.pos], ["Jersey", e.jersey ? "#" + e.jersey : ""], ["Height", e.ht], ["Weight", e.wt],
      ["Age", e.age], ["Born", e.dob ? longDate(e.dob) : ""], ["From", e.born],
      ["College", e.college], ["Experience", e.exp !== "" && e.exp != null ? e.exp + (e.exp === 1 ? " year" : " years") : ""],
      ["Injury", e.inj ? e.inj.status + (e.inj.date ? " (" + longDate(e.inj.date) + ")" : "") : "None listed"],
    ].filter(function (r) { return r[1] !== "" && r[1] != null; });
    return sbox("Bio", "", '<div class="facts">' + rows.map(function (r) {
      return '<div class="fact' + (r[0] === "Injury" && e.inj ? " bad" : "") + '"><span>' + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></div>"; }).join("") + "</div>");
  }

  function stats(c, d) {
    if (!d) return sbox("", "", loading("Loading stats"));
    if (!d.ok || !d.summary) return sbox("", "", '<div class="muted">' + esc(d.msg || "No regular-season games yet.") + "</div>");
    var s = d.summary;
    return sbox((d.season || "") + " averages · " + s.g + " games", "s-avg",
      '<div class="ptiles">' + tile("FPPG", f1(s.avg.fp), "hot") + tile("MIN", f1(s.avg.min)) + tile("PTS", f1(s.avg.pts)) +
      tile("REB", f1(s.avg.reb)) + tile("AST", f1(s.avg.ast)) + tile("STL", f1(s.avg.stl)) + tile("BLK", f1(s.avg.blk)) +
      tile("TO", f1(s.avg.to)) + tile("3PM", f1(s.avg.fg3m)) + tile("FG%", pct(s.pct.fg)) + tile("3P%", pct(s.pct.fg3)) +
      tile("FT%", pct(s.pct.ft)) + "</div>") +
    sbox("Advanced", "s-adv",
      '<div class="ptiles">' + tile("TS%", pct(s.adv.ts)) + tile("eFG%", pct(s.adv.efg)) + tile("3PA rate", pct(s.adv.par3)) +
      tile("FT rate", pct(s.adv.ftr)) + tile("AST/TO", f2(s.adv.astTo)) + tile("FP / min", f2(s.adv.fpMin)) +
      tile("FP std dev", f1(s.adv.fpSd)) + tile("FP high", f1(s.adv.high), "good") + tile("FP low", f1(s.adv.low), "bad") +
      tile("Double-doubles", s.adv.dd) + tile("Triple-doubles", s.adv.td) + "</div>") +
    sbox("Per 36 minutes", "s-36",
      '<div class="ptiles">' + tile("FP", f1(s.per36.fp), "hot") + tile("PTS", f1(s.per36.pts)) + tile("REB", f1(s.per36.reb)) +
      tile("AST", f1(s.per36.ast)) + tile("STL", f1(s.per36.stl)) + tile("BLK", f1(s.per36.blk)) + "</div>") +
    (d.playoffs ? sbox("Playoffs · " + d.playoffs.g + " games", "s-po",
      '<div class="ptiles">' + tile("FPPG", f1(d.playoffs.avg.fp), "hot") + tile("PTS", f1(d.playoffs.avg.pts)) +
      tile("REB", f1(d.playoffs.avg.reb)) + tile("AST", f1(d.playoffs.avg.ast)) + "</div>") : "");
  }

  /* ---------------- controller ---------------- */
  // tabs: Overview (contract + bio) · Game log · Stats · Transactions
  var TABS = [["over", "Overview"], ["log", "Game log"], ["stats", "Stats"], ["txn", "Transactions"]];
  var st = null; // { root, name, card, log, season, all, tab }

  function q(role) { return st.root.querySelector('[data-role="' + role + '"]'); }
  function fail(role) {
    var mine = st;
    return function (err) { if (st === mine) q(role).innerHTML = sbox("", "", '<div class="err">Something went wrong: ' + esc(err && err.message || err) + "</div>"); };
  }

  function seasonSelect() {
    var now = new Date(), y = now.getFullYear() + (now.getMonth() >= 8 ? 1 : 0); // ESPN season = end year
    var opts = [["", "This season"], [String(y - 1), (y - 2) + "-" + String(y - 1).slice(2)], [String(y - 2), (y - 3) + "-" + String(y - 2).slice(2)]];
    return '<select data-role="season" aria-label="Season">' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === st.season ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("") + "</select>";
  }
  function tabs() {
    return '<div class="ptabs" role="tablist">' + TABS.map(function (t) {
      return '<button role="tab" data-role="tab" data-v="' + t[0] + '" aria-selected="' + (st.tab === t[0]) + '" class="' + (st.tab === t[0] ? "on" : "") + '">' + t[1] + "</button>";
    }).join("") + "</div>";
  }
  function showTab(v) {
    st.tab = v;
    var sb = st.root.parentNode, bar = st.root.querySelector(".ptabs");   // keep the new tab's top in view
    if (sb && bar && sb.scrollTop > bar.offsetTop) sb.scrollTop = bar.offsetTop;
    Array.prototype.forEach.call(st.root.querySelectorAll("[data-panel]"), function (p) { p.hidden = p.getAttribute("data-panel") !== v; });
    Array.prototype.forEach.call(st.root.querySelectorAll('[data-role="tab"]'), function (b) {
      var on = b.getAttribute("data-v") === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on));
    });
  }

  function open(root, name) {
    name = String(name || "").trim();
    st = { root: root, name: name, card: null, log: null, season: "", all: false, tab: "over" };
    root.removeAttribute("style");
    root.innerHTML = '<div data-role="header">' + sbox("", "", loading("Loading " + name)) + "</div>" + tabs() +
      '<div data-panel="over"><div data-role="con">' + loading() + '</div><div data-role="bio"></div></div>' +
      '<div data-panel="log" hidden><div data-role="log">' + loading() + "</div></div>" +
      '<div data-panel="stats" hidden><div data-role="stats">' + loading() + "</div></div>" +
      '<div data-panel="txn" hidden><div data-role="txn">' + loading() + "</div></div>";
    var mine = st;
    return api("getCard", name).then(function (c) {
      if (st !== mine) return;
      st.card = c;
      if (!c.found) {
        q("header").innerHTML = sbox("", "", "Couldn't find <b>" + esc(c.query) + "</b> on Sleeper, ESPN, or the Master list.");
        ["con", "bio", "log", "stats", "txn"].forEach(function (r) { q(r).innerHTML = ""; });
        return;
      }
      root.setAttribute("style", vars(c.nbaTeam));     // the tabs and accents follow his NBA team's colors
      q("header").innerHTML = header(c);
      q("bio").innerHTML = bio(c);
      q("con").innerHTML = contract(c);
      q("stats").innerHTML = stats(c, null);
      loadLog();
      loadTxns(c, mine);
    }, fail("header"));
  }

  // His moves, drawn exactly like the Transactions page (falls back to the old list without the site's log)
  function loadTxns(c, mine) {
    if (typeof logEntry !== "function" || typeof LOCAL === "undefined") {
      api("getTxns", c.sleeperId).then(function (t) { if (st === mine) q("txn").innerHTML = txns(t); }, fail("txn"));
      return;
    }
    var key = LeagueMath.norm(c.name);
    var got = typeof S !== "undefined" && S.log ? Promise.resolve(S.log) : LOCAL.getLog().then(function (d) { if (typeof S !== "undefined") S.log = d; return d; });
    got.then(function (d) {
      if (st !== mine) return;
      var rows = d.rows.filter(function (r) {
        return String(r.players || "").split(/\s+\|\s+/).some(function (part) {
          return part.replace(/^.*? (gets|adds|drops):\s*/, "").split(/,\s*(?![^()]*\))/).some(function (it) { return LeagueMath.norm(it) === key; });
        });
      });
      q("txn").innerHTML = rows.length ? '<div class="box plog">' + rows.map(function (r) { return logEntry(r); }).join("") + "</div>"
        : sbox("", "", '<div class="muted">No league transactions for this player.</div>');
    }, fail("txn"));
  }

  function loadLog() {
    var mine = st, want = st.season, c = st.card;
    q("log").innerHTML = loading("Loading games");
    api("getGameLog", c.espn && c.espn.id, want).then(function (d) {
      if (st !== mine || st.season !== want) return; // player or season changed meanwhile
      st.log = d;
      q("log").innerHTML = gameLog(d, seasonSelect(), st.all);
      q("stats").innerHTML = stats(c, d);
      if (!want) { var qk = q("quick"); if (qk) qk.innerHTML = quick(c, d); }
      var chip = q("elig");
      if (chip && d && d.summary && d.summary.eligibility && !want) {
        chip.textContent = d.summary.eligibility; chip.style.display = "";
      }
    }, fail("log"));
  }

  // Wire once per root element
  function bind(root) {
    root.addEventListener("click", function (ev) {
      if (!st) return;
      var tab = ev.target.closest && ev.target.closest('[data-role="tab"]');
      if (tab) { showTab(tab.getAttribute("data-v")); return; }
      var t = ev.target.closest && ev.target.closest('[data-role="moreGames"]');
      if (!t) return;
      st.all = !st.all;
      q("log").innerHTML = gameLog(st.log, seasonSelect(), st.all);
    });
    root.addEventListener("change", function (ev) {
      if (st && ev.target.getAttribute("data-role") === "season") { st.season = ev.target.value; loadLog(); }
    });
  }

  function close() { st = null; }

  return { open: open, close: close, bind: bind, render: { header: header, gameLog: gameLog, txns: txns, contract: contract, bio: bio, stats: stats } };
})();
