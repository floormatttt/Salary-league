/* League site: routing, pages, trade machine, commissioner tools.
 * Data: data/*.json (this repo, kept current by the Sleeper sync and commissioner
 * edits) + live Sleeper rosters/records/picks + ESPN game logs, all fetched in
 * the browser. Routes (hash): "" standings · team/ATL · players ·
 * trade[/<encoded>] · log · rules · admin.   ?n=Name opens a player card. */
var LM = LeagueMath;

/* ============================ data ============================ */
var DATA = {};       // raw data files
var LIVE = {};       // live Sleeper: league, rosters, users, traded
var SLEEPER = "https://api.sleeper.app/v1";
var ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";

function getJson(url, what) {
  return fetch(url, { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error("Couldn't load " + (what || url) + " (HTTP " + r.status + ")");
    return r.json();
  });
}
// Data files: a fresh copy every load (the CDN caches for up to 10 minutes otherwise)
function dataFile(key) {
  if (DATA[key] !== undefined) return Promise.resolve(DATA[key]);
  return getJson("data/" + League.FILES[key] + "?t=" + Date.now(), League.FILES[key]).then(function (v) { DATA[key] = v; return v; });
}
function sleeper(path) { return getJson(SLEEPER + path, "Sleeper " + path); }

function loadLeague() {
  var id = League.CONFIG.leagueId;
  return Promise.all([dataFile("contracts"), dataFile("holds"), dataFile("cash"), dataFile("teams"), dataFile("players"), dataFile("state"),
    sleeper("/league/" + id), sleeper("/league/" + id + "/rosters"), sleeper("/league/" + id + "/users"), sleeper("/league/" + id + "/traded_picks")])
    .then(function (r) {
      LIVE = { league: r[6], rosters: r[7], users: r[8], traded: r[9] };
      return rebuild();
    });
}
function rebuild() { var L = League.build(DATA, LIVE); setLeague(L); return L; }
function when(ts) {
  var d = new Date(ts);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

var gameLogs = {};
var LOCAL = {
  getLog: function () {
    return dataFile("log").then(function (rows) {
      return { rows: rows.map(function (r) { return Object.assign({ when: when(r.ts) }, r); }), lastSync: S.L.lastSync ? when(S.L.lastSync) : "" };
    });
  },
  getRules: function () { return dataFile("rules"); },
  getCard: function (name) { return dataFile("espn").then(function (espn) { return CardData.card(S.L, DATA.players, espn, name); }); },
  getGameLog: function (espnId, season) {
    if (!espnId) return { ok: false, msg: "No ESPN match for this player, so there's no game log." };
    var key = espnId + "|" + (season || "");
    if (gameLogs[key]) return gameLogs[key];
    var url = ESPN_WEB + "/athletes/" + encodeURIComponent(espnId) + "/gamelog" + (season ? "?season=" + encodeURIComponent(season) : "");
    return (gameLogs[key] = getJson(url, "the ESPN game log").then(function (j) {
      return CardData.gameLog(j, LIVE.league && LIVE.league.scoring_settings);
    }, function () { delete gameLogs[key]; return { ok: false, msg: "ESPN didn't return a game log. Try again in a minute." }; }));
  },
  getTxns: function (sid) {
    if (!sid) return { ok: false, msg: "No Sleeper match for this player, so no league transactions." };
    return dataFile("txns").then(function (list) {
      var byRid = {}; DATA.teams.forEach(function (t) { byRid[String(t.rid)] = t; });
      return CardData.txns(list, sid, function (rid) { var t = byRid[String(rid)]; return t ? t.name : "Roster " + rid; },
        function (pid) { var p = DATA.players[pid]; return p ? p[0] : String(pid); });
    });
  },
};
// Same call style the card code uses
function api(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  return Promise.resolve().then(function () { return LOCAL[fn].apply(null, args); });
}

var S = {
  L: null, books: {}, rIdx: null, log: null, rules: null, hash: "",
  pl: { q: "", f: "all", limit: 150 },
  lg: { team: "", type: "", n: 100 },
  trade: { teams: [], moves: [] }, shareUrl: "",
  admin: { tab: "pending", edit: null, q: "", log: null, waive: null },
};

/* ============================ helpers ============================ */
function $(id) { return document.getElementById(id); }
function view() { return $("view"); }
function money(v) { return v == null || v === "" ? "" : (v < 0 ? "-$" : "$") + Math.abs(LM.r1(v)).toFixed(1); }
function signed(v) { v = LM.r1(v || 0); return (v > 0 ? "+" : v < 0 ? "-" : "") + "$" + Math.abs(v).toFixed(1); }
function cls(v) { return v < 0 ? "neg" : ""; }
function tierChip(p) { var t = LM.tierOf(p); return '<span class="tier t-' + t.key + '">' + esc(t.label) + "</span>"; }
function plain(n) { return String(n || "").replace(/\s*\(cap hold\)\s*/i, " ").trim(); }
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? " selected" : "") + ">" + esc(label) + "</option>"; }
function teamName(code) { var t = LM.teamByCode(S.L, code); return t ? t.name : code; }
function teamLink(code, label) { return '<a class="team" href="#team/' + esc(code) + '" data-go="team/' + esc(code) + '">' + esc(label || teamName(code)) + "</a>"; }
function teamOptions(sel, blank) {
  return (blank != null ? opt("", blank, !sel) : "") + S.L.teams.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
    .map(function (t) { return opt(t.code, t.name + " (" + t.code + ")", t.code === sel); }).join("");
}
function salCell(c, i) {
  if (!c) return "";
  var v = c.sal[i], s = c.st[i];
  var out = typeof v === "number" ? money(v) : v ? '<span class="fa">' + esc(v) + "</span>" : "";
  return out + (s ? '<span class="st ' + esc(s) + '">' + esc(s) + "</span>" : "");
}
function book(code) { return S.books[code] || (S.books[code] = LM.teamBook(S.L, code)); }
function setLeague(L) { S.L = L; S.books = {}; S.rIdx = null; S.plRows = null; LM.resetIndex(L); }
// norm(name) -> { code, slot } for everyone on a fantasy roster
function rosterIdx() {
  if (S.rIdx) return S.rIdx;
  var idx = {};
  S.L.teams.forEach(function (t) {
    var ro = S.L.rosters[t.rid] || {};
    ["starters", "bench", "ir", "taxi"].forEach(function (slot) {
      (ro[slot] || []).forEach(function (p) { idx[LM.norm(p.name)] = { code: t.code, slot: slot, name: p.name }; });
    });
  });
  return (S.rIdx = idx);
}
function holdTeam(name) {
  var k = LM.norm(name), h = S.L.holds.filter(function (x) { return LM.norm(x.name) === k; })[0];
  return h ? h.code : "";
}
var SLOT = { starters: "Starters", bench: "Bench", ir: "Injured reserve", taxi: "Taxi" };

var toastTimer = null;
function toast(msg, bad) {
  var el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  el.style.display = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.style.display = "none"; }, bad ? 7000 : 3500);
}
function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
function recall(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

/* ============================ routing ============================ */
var Nav = {
  go: function (h) {
    h = h || "";
    if (location.hash.slice(1) === h) route(h);
    else location.hash = h;
  },
  // Update the URL without re-rendering (trade machine keeps its hash current)
  quiet: function (h) {
    S.hash = h;
    history.replaceState(null, "", location.pathname + location.search + "#" + h);
  },
};

var PAGES = { standings: pageStandings, team: pageTeam, players: pagePlayers, trade: pageTrade, log: pageLog, rules: pageRules, admin: pageAdmin };

function route(h, keepScroll) {
  h = String(h || "").replace(/^#/, "");
  S.hash = h;
  var i = h.indexOf("/"), page = (i < 0 ? h : h.slice(0, i)) || "standings", arg = i < 0 ? "" : h.slice(i + 1);
  if (!PAGES[page]) page = "standings";
  Array.prototype.forEach.call(document.querySelectorAll("#nav a"), function (a) {
    a.classList.toggle("on", a.getAttribute("data-page") === page);
  });
  var html = PAGES[page](arg);
  if (html != null) view().innerHTML = html + footer();
  if (!keepScroll) window.scrollTo(0, 0);
}
function rerender() { route(S.hash, true); }
function footer() {
  return '<div class="foot">Rosters and records are live from Sleeper' + (S.L && S.L.lastSync ? " · league data last changed " + esc(when(S.L.lastSync)) : "") +
    ' · <button class="linkbtn" data-act="download">Download spreadsheet</button></div>';
}

/* ============================ player popup ============================ */
function openPlayer(name) {
  name = plain(name);
  if (!name) return;
  $("modalTitle").textContent = name;
  $("modal").classList.add("open");
  $("modal").setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("card").parentNode.scrollTop = 0;
  Card.open($("card"), name);
}
function closePlayer() {
  $("modal").classList.remove("open");
  $("modal").setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  Card.close();
}

/* ============================ standings ============================ */
function pageStandings() {
  var L = S.L;
  var rows = L.teams.map(function (t) {
    var b = book(t.code), p = b.payroll[0];
    return '<tr><td><div class="tm"><span class=rk>' + (t.rank == null ? "" : t.rank) + "</span><div>" + teamLink(t.code) +
      '<div class="muted small">' + esc(t.owner) + "</div></div></div></td>" +
      "<td><b>" + money(p) + "</b></td><td class=l>" + tierChip(p) + "</td><td>" + t.w + "-" + t.l + (t.t ? "-" + t.t : "") + "</td><td>" + f1(t.pf) +
      '</td><td class="' + cls(b.cash) + '">' + (b.cash ? signed(b.cash) : "—") +
      "</td><td>" + b.maxes + "/" + L.limits.maxes + "</td><td>" + b.smaxes + "/" + L.limits.supermaxes + "</td></tr>";
  }).join("");
  return '<div class="pagehead"><div><h1>Standings</h1><div class="sub">' + esc(L.season) + " · ranked by the commissioners · payroll includes cap holds and cash</div></div>" +
    '<button class="btn" data-act="download">Download spreadsheet</button></div>' +
    '<div class="tbl"><table><tr><th>Team</th><th>Payroll</th><th class=l>Level</th><th>W-L-T</th><th>PF</th><th>Cash</th><th>Max</th><th>Supermax</th></tr>' +
    rows + "</table></div>";
}

/* ============================ team page ============================ */
function pageTeam(code) {
  var L = S.L;
  var t = LM.teamByCode(L, code) || LM.teamByCode(L, recall("slTeam")) || L.teams[0];
  store("slTeam", t.code);
  var b = book(t.code), p = b.payroll[0], n = L.seasons.length;
  var lim = L.limits;
  var space = function (line) { var v = line - p; return '<b class="' + cls(v) + '">' + money(v) + "</b>"; };
  var head = '<div class="pagehead"><div><h1>' + esc(t.name) + '</h1><div class="sub">' + esc(t.owner) + " · " + t.w + "-" + t.l + (t.t ? "-" + t.t : "") +
    " · " + f1(t.pf) + " PF" + (t.rank != null ? " · ranked #" + t.rank : "") + "</div></div>" +
    '<select data-act="pickTeam" aria-label="Team">' + teamOptions(t.code) + "</select></div>";
  var statsHtml = '<div class="box"><div class="stats">' +
    '<div class="stat"><b>' + money(p) + "</b><span>Payroll " + esc(L.season) + "</span></div>" +
    '<div class="stat"><b>' + tierChip(p) + "</b><span>Level</span></div>" +
    '<div class="stat">' + space(150) + "<span>Room to 1st apron</span></div>" +
    '<div class="stat">' + space(200) + "<span>Room to 2nd apron</span></div>" +
    '<div class="stat">' + space(250) + "<span>Room to luxury tax</span></div>" +
    '<div class="stat">' + space(lim.hardCap) + "<span>Room to $" + lim.hardCap + "M max</span></div>" +
    '<div class="stat"><b class="' + cls(b.cash) + '">' + signed(b.cash) + "</b><span>Cash balance (±$" + lim.cash + "M)</span></div>" +
    '<div class="stat"><b>' + b.maxes + " / " + lim.maxes + "</b><span>Max contracts</span></div>" +
    '<div class="stat"><b>' + b.smaxes + " / " + lim.supermaxes + "</b><span>Supermax</span></div>" +
    '<div class="stat"><b>' + b.active + (lim.activeRoster ? " / " + lim.activeRoster : "") + "</b><span>Active roster</span></div>" +
    "</div></div>";
  var warn = b.missing.length ? '<div class="box"><b class="err">No contract on the Master list:</b> ' +
    b.missing.map(function (x) { return pbtn(x); }).join(", ") + ' <span class="muted small">(counted as $0)</span></div>' : "";

  var seasonsTh = L.seasons.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("");
  var cols = n + 3;
  var body = "";
  ["starters", "bench", "ir", "taxi"].forEach(function (slot) {
    var ps = b.players.filter(function (x) { return x.slot === slot; });
    if (!ps.length) return;
    body += '<tr class="grp"><td colspan="' + cols + '">' + SLOT[slot] + " · " + ps.length + "</td></tr>";
    ps.forEach(function (x) {
      body += '<tr><td class="name">' + pbtn(x.name) + (x.c ? "" : '<span class="flag bad">No contract</span>') +
        (x.c && /pending/i.test(x.c.det) ? '<span class="flag">Pending</span>' : "") + '</td><td class="l muted">' + esc(x.c ? x.c.nba : "") + "</td>" +
        L.seasons.map(function (_, i) { return "<td>" + salCell(x.c, i) + "</td>"; }).join("") +
        '<td class="l muted small">' + esc(x.c ? x.c.det : "") + "</td></tr>";
    });
  });
  if (b.holds.length) {
    body += '<tr class="grp"><td colspan="' + cols + '">Cap holds · ' + b.holds.length + "</td></tr>";
    b.holds.forEach(function (h) {
      body += '<tr><td class="name">' + pbtn(h.name) + (h.c ? "" : '<span class="flag bad">Not on Master list</span>') +
        '</td><td class="l muted">' + esc(h.c ? h.c.nba : "") + "</td>" +
        L.seasons.map(function (_, i) { return "<td>" + salCell(h.c, i) + "</td>"; }).join("") + '<td class="l muted small">' + esc(h.c ? h.c.det : "") + "</td></tr>";
    });
  }
  body += '<tr class="grp"><td colspan="' + cols + '">Totals</td></tr>' +
    '<tr><td>Cash considerations</td><td></td>' + L.seasons.map(function (_, i) {
      return '<td class="' + (i === 0 ? cls(b.cash) : "") + '">' + (i === 0 ? signed(b.cash) : "") + "</td>"; }).join("") + "<td></td></tr>" +
    '<tr class="total"><td>Total payroll</td><td></td>' + b.payroll.map(function (v) {
      return '<td class="tot t-' + LM.tierOf(v).key + '">' + money(v) + "</td>"; }).join("") + "<td></td></tr>" +
    "<tr><td>Level</td><td></td>" + b.payroll.map(function (v) { return "<td>" + tierChip(v) + "</td>"; }).join("") + "<td></td></tr>" +
    "<tr><td>Room to $" + lim.hardCap + "M max</td><td></td>" + b.payroll.map(function (v) {
      return '<td class="' + cls(lim.hardCap - v) + '">' + money(lim.hardCap - v) + "</td>"; }).join("") + "<td></td></tr>";
  var table = '<div class="tbl"><table><tr><th>Player</th><th class=l>NBA</th>' + seasonsTh + "<th class=l>Details</th></tr>" + body + "</table></div>";

  var picks = (L.picks[t.code] || []);
  var bySeason = {};
  picks.forEach(function (pk) { (bySeason[pk.season] = bySeason[pk.season] || []).push(pk); });
  var picksHtml = Object.keys(bySeason).length ? Object.keys(bySeason).sort().map(function (s) {
    return '<div class="row start"><b style="width:44px">' + esc(s) + '</b><div class="picks">' + bySeason[s].map(function (pk) {
      return '<span class="chip' + (/\(own\)/.test(pk.label) ? " own" : "") + '">' + esc(pk.label.replace(/^\d{4} /, "")) + "</span>"; }).join("") + "</div></div>";
  }).join("") : '<div class="empty">No draft picks in the next drafts.</div>';

  return head + statsHtml + warn + table + '<h2 class="sec">Draft picks</h2>' + box("", picksHtml);
}

/* ============================ players ============================ */
function playerRows() {
  if (S.plRows) return S.plRows;
  var idx = rosterIdx(), seen = {};
  var rows = S.L.contracts.map(function (c) {
    var r = c.hold ? null : idx[LM.norm(c.n)];
    if (r) seen[LM.norm(c.n)] = true;
    return { c: c, n: c.n, key: LM.norm(c.n) + " " + c.n.toLowerCase() + " " + c.nba.toLowerCase(),
             team: c.hold ? holdTeam(c.n) : r ? r.code : "", hold: c.hold, rostered: !!r, pending: /pending/i.test(c.det) };
  });
  Object.keys(idx).forEach(function (k) {
    if (seen[k]) return;
    var r = idx[k];
    rows.push({ c: null, n: r.name, key: k + " " + r.name.toLowerCase(), team: r.code, hold: false, rostered: true, pending: false, missing: true });
  });
  return (S.plRows = rows);
}
var PL_FILTERS = [["all", "All"], ["rostered", "Rostered"], ["fa", "Free agents"], ["holds", "Cap holds"], ["pending", "Pending contracts"]];
function plFiltered() {
  var q = S.pl.q.trim().toLowerCase(), qn = LM.norm(q), f = S.pl.f;
  return playerRows().filter(function (r) {
    if (f === "rostered" && !r.rostered) return false;
    if (f === "fa" && (r.rostered || r.hold || r.pending)) return false;
    if (f === "holds" && !r.hold) return false;
    if (f === "pending" && !r.pending) return false;
    return !q || r.key.indexOf(q) >= 0 || (qn && r.key.indexOf(qn) >= 0) || (r.team && r.team.toLowerCase() === q);
  });
}
function plTable() {
  var rows = plFiltered(), L = S.L;
  var shown = rows.slice(0, S.pl.limit);
  var body = shown.map(function (r) {
    return '<tr><td class="name">' + pbtn(r.n) + (r.missing ? '<span class="flag bad">No contract</span>' : "") + (r.pending ? '<span class="flag">Pending</span>' : "") +
      '</td><td class="l muted">' + esc(r.c ? r.c.nba : "") + '</td><td class="l">' + (r.team ? teamLink(r.team, r.team) + (r.hold ? ' <span class="muted small">hold</span>' : "") : '<span class="muted">—</span>') + "</td>" +
      L.seasons.map(function (_, i) { return "<td>" + salCell(r.c, i) + "</td>"; }).join("") + "</tr>";
  }).join("");
  return '<div class="muted small" style="margin:0 2px 6px">' + rows.length + " player" + (rows.length === 1 ? "" : "s") + "</div>" +
    '<div class="tbl"><table><tr><th>Player</th><th class=l>NBA</th><th class=l>Team</th>' + L.seasons.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr>" +
    (body || '<tr><td colspan="10" class="empty">Nobody matches.</td></tr>') + "</table></div>" +
    (rows.length > shown.length ? '<button class="more" data-act="plMore">Show ' + Math.min(150, rows.length - shown.length) + " more</button>" : "");
}
function pagePlayers() {
  return '<div class="pagehead"><div><h1>Players</h1><div class="sub">Every Master list contract plus anyone rostered without one</div></div></div>' +
    '<div class="row"><input type="search" class="grow" id="plq" placeholder="Search a player or NBA team" value="' + esc(S.pl.q) + '" autocomplete="off"></div>' +
    '<div class="seg" style="margin-bottom:10px">' + PL_FILTERS.map(function (f) {
      return '<button data-act="plFilter" data-v="' + f[0] + '" class="' + (S.pl.f === f[0] ? "on" : "") + '">' + f[1] + "</button>"; }).join("") + "</div>" +
    '<div id="plTable">' + plTable() + "</div>";
}

/* ============================ trade machine ============================ */
function tradeEncode(T) {
  return "trade/" + encodeURIComponent(JSON.stringify({ t: T.teams, m: T.moves.map(function (m) {
    return [m.type[0], m.type === "player" ? m.name : m.type === "pick" ? m.label : m.amt, m.from, m.to]; }) }));
}
function tradeDecode(s) {
  try {
    var o = JSON.parse(decodeURIComponent(s));
    var codes = S.L.teams.map(function (t) { return t.code; });
    var teams = (o.t || []).filter(function (c) { return codes.indexOf(c) >= 0; }).slice(0, 4);
    var moves = (o.m || []).map(function (m) {
      var type = { p: "player", k: "pick", c: "cash" }[m[0]];
      var mv = { type: type, from: m[2], to: m[3] };
      if (type === "player") mv.name = String(m[1]); else if (type === "pick") mv.label = String(m[1]); else mv.amt = Number(m[1]) || 0;
      return mv;
    }).filter(function (m) { return m.type && teams.indexOf(m.from) >= 0 && teams.indexOf(m.to) >= 0; });
    return { teams: teams, moves: moves };
  } catch (e) { return null; }
}
// "(own)" on a pick means the sending team's own pick
function pickName(label, from) { return String(label).replace("(own)", "(" + teamName(from) + "'s)"); }
function moveOf(type, key, from) {
  return S.trade.moves.filter(function (m) { return m.type === type && m.from === from && (type === "player" ? m.name === key : m.label === key); })[0];
}
function destSelect(type, key, from) {
  var m = moveOf(type, key, from);
  var others = S.trade.teams.filter(function (c) { return c !== from; });
  return '<select data-act="move" data-type="' + type + '" data-key="' + esc(key) + '" data-from="' + esc(from) + '" aria-label="Send to">' +
    opt("", "Keep", !m) + others.map(function (c) { return opt(c, "→ " + c, m && m.to === c); }).join("") + "</select>";
}
function tradeTeamBox(code) {
  var b = book(code), L = S.L;
  var players = b.players.slice().sort(function (x, y) { return (y.sal[0] || 0) - (x.sal[0] || 0); });
  var pl = players.map(function (x) {
    var moving = !!moveOf("player", x.name, code);
    return '<div class="asset' + (moving ? " moving" : "") + '"><span class="nm">' + pbtn(x.name) +
      (x.c && /MAX/.test(x.c.st[0]) ? '<span class="st ' + esc(x.c.st[0]) + '">' + esc(x.c.st[0]) + "</span>" : "") + '</span><span class="sal">' +
      (x.c ? money(x.sal[0]) : '<span class="flag bad">No contract</span>') + "</span>" + destSelect("player", x.name, code) + "</div>";
  }).join("");
  var pk = (L.picks[code] || []).map(function (p) {
    var moving = !!moveOf("pick", p.label, code);
    return '<div class="asset' + (moving ? " moving" : "") + '"><span class="nm">' + esc(p.label) + "</span>" + destSelect("pick", p.label, code) + "</div>";
  }).join("");
  var cash = S.trade.moves.filter(function (m) { return m.type === "cash" && m.from === code; }).map(function (m, i) {
    return '<div class="asset moving"><span class="nm">' + money(m.amt) + "M cash → " + esc(m.to) + '</span><button class="btn sm" data-act="rmCash" data-from="' + esc(code) +
      '" data-to="' + esc(m.to) + '" data-amt="' + m.amt + '">Remove</button></div>';
  }).join("");
  var others = S.trade.teams.filter(function (c) { return c !== code; });
  return '<div class="box"><div class="row"><b>' + esc(b.team.name) + "</b><span>" + money(b.payroll[0]) + " " + tierChip(b.payroll[0]) + "</span></div>" +
    '<h3 class="sec">Players</h3>' + pl +
    (pk ? '<details class="more"><summary>Draft picks (' + (L.picks[code] || []).length + ")</summary>" + pk + "</details>" : "") +
    '<h3 class="sec" style="margin-top:12px">Cash · balance ' + signed(b.cash) + "</h3>" + cash +
    '<div class="row start" style="margin-top:6px"><input type="number" min="0.5" step="0.5" inputmode="decimal" placeholder="$M" style="width:84px" data-role="cashAmt" data-from="' + esc(code) + '">' +
    '<select data-role="cashTo" data-from="' + esc(code) + '">' + others.map(function (c) { return opt(c, "→ " + c); }).join("") + "</select>" +
    '<button class="btn sm" data-act="addCash" data-from="' + esc(code) + '">Add cash</button></div></div>';
}
function tradeResults() {
  var T = S.trade, L = S.L;
  if (T.teams.length < 2) return '<div class="box empty">Pick at least two teams.</div>';
  if (!T.moves.length) return '<div class="box empty">Choose who goes where. Every player and pick has a "Keep / → team" menu.</div>';
  var r = LM.evaluateTrade(L, T);
  var head = '<div class="box"><div class="verdict ' + (r.legal ? "ok" : "no") + '">' + (r.legal ? "✓ Legal trade" : "✗ Not legal") + "</div>" +
    (r.problems.length ? '<ul class="issues err">' + r.problems.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "") +
    (r.warnings.length ? '<ul class="issues" style="color:var(--warn)">' + r.warnings.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "") +
    '<p class="muted small" style="margin:8px 0 0">Apron level is judged on payroll before the trade. Commissioners still vote (3-2) on every trade.</p></div>';
  var th = L.seasons.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("");
  var teams = r.teams.map(function (t) {
    var limit = t.tier.match === null ? "no limit" : t.tier.match === 0 ? "can only lose cap" : "limit +" + money(t.tier.match);
    var picksIn = T.moves.filter(function (m) { return m.type === "pick" && m.to === t.code; }).map(function (m) { return pickName(m.label, m.from); });
    var picksOut = T.moves.filter(function (m) { return m.type === "pick" && m.from === t.code; }).map(function (m) { return pickName(m.label, m.from); });
    var gets = t.inP.map(function (x) { return pbtn(x); }).concat(picksIn.map(esc), t.cashIn ? [money(t.cashIn) + "M cash"] : []);
    var sends = t.outP.map(function (x) { return pbtn(x); }).concat(picksOut.map(esc), t.cashOut ? [money(t.cashOut) + "M cash"] : []);
    var row = function (label, arr, f) { return "<tr><td>" + label + "</td>" + arr.map(function (v, i) { return f(v, i); }).join("") + "</tr>"; };
    return '<div class="box"><div class="row"><b>' + (t.ok ? '<span class="ok">✓</span> ' : '<span class="err">✗</span> ') + esc(t.name) + "</b>" +
      '<span class="small">' + tierChip(t.pre[0]) + " → " + tierChip(t.post[0]) + "</span></div>" +
      '<div class="small" style="margin-bottom:8px"><div><b>Gets:</b> ' + (gets.join(", ") || "nothing") + "</div><div><b>Sends:</b> " + (sends.join(", ") || "nothing") + "</div>" +
      '<div class="muted">Change this season <b class="' + (t.ok ? "" : "err") + '">' + signed(t.delta) + "</b> (" + limit + ") · cash balance " + signed(t.cashBefore) + " → " + signed(t.cashAfter) + "</div></div>" +
      '<div class="tbl"><table><tr><th></th>' + th + "</tr>" +
      row("Before", t.pre, function (v) { return "<td>" + money(v) + "</td>"; }) +
      row("Out", t.outSal, function (v) { return "<td>" + (v ? "-" + money(v) : "") + "</td>"; }) +
      row("In", t.inSal, function (v) { return "<td>" + (v ? "+" + money(v) : "") + "</td>"; }) +
      row("Cash", t.pre, function (_, i) { var c = t.cashOut - t.cashIn; return "<td>" + (i === 0 && c ? signed(c) : "") + "</td>"; }) +
      '<tr class="total"><td>After</td>' + t.post.map(function (v) { return '<td class="tot t-' + LM.tierOf(v).key + '">' + money(v) + "</td>"; }).join("") + "</tr>" +
      row("Level after", t.post, function (v) { return "<td>" + tierChip(v) + "</td>"; }) +
      "</table></div></div>";
  }).join("");
  var hasCash = T.moves.some(function (m) { return m.type === "cash"; });
  var admin = S.admin.token && hasCash ? '<div class="box"><button class="btn pri" data-act="recordTradeCash">Record cash from this trade</button>' +
    ' <span class="muted small">Adds the cash moves to the Cash Ledger for ' + esc(L.season) + ".</span></div>" : "";
  // phones: the verdict stays visible while choosing players
  var bar = '<button class="vbar ' + (r.legal ? "ok" : "no") + '" data-act="toResult">' +
    (r.legal ? "✓ Legal trade" : "✗ Not legal · " + r.problems.length + " problem" + (r.problems.length === 1 ? "" : "s")) + "<span>See result ↓</span></button>";
  return head + teams + admin + bar;
}
function pageTrade(arg) {
  if (arg) { var d = tradeDecode(arg); if (d) S.trade = d; }
  var T = S.trade;
  var slots = Math.min(4, Math.max(2, T.teams.length + 1));
  var pickers = "";
  for (var i = 0; i < slots; i++) {
    pickers += '<label class="f">Team ' + (i + 1) + '<select data-act="tradeTeam" data-i="' + i + '">' +
      teamOptions(T.teams[i] || "", i < 2 ? "Pick a team" : "Add a team (optional)") + "</select></label>";
  }
  return '<div class="pagehead"><div><h1>Trade machine</h1><div class="sub">2–4 teams · players, picks and cash · checks every cap rule</div></div>' +
    '<div class="row start"><button class="btn" data-act="share">Copy share link</button><button class="btn" data-act="clearTrade">Clear</button></div></div>' +
    (S.shareUrl ? '<div class="box"><label class="f">Share link<input type="text" readonly id="shareUrl" value="' + esc(S.shareUrl) + '"></label></div>' : "") +
    '<div class="box"><div class="form">' + pickers + "</div></div>" +
    '<div class="tm-teams">' + T.teams.map(tradeTeamBox).join("") + "</div>" +
    '<h2 class="sec">Result</h2><div id="tradeResult">' + tradeResults() + "</div>";
}
function tradeChanged() {
  // drop moves that no longer make sense (team removed, etc.)
  var T = S.trade;
  T.moves = T.moves.filter(function (m) { return T.teams.indexOf(m.from) >= 0 && T.teams.indexOf(m.to) >= 0 && m.from !== m.to; });
  S.shareUrl = "";
  Nav.quiet(tradeEncode(T));
  var y = window.scrollY;
  view().innerHTML = pageTrade("") + footer();
  window.scrollTo(0, y);
}

/* ============================ transactions ============================ */
function logKind(type) { return /trade/i.test(type) ? "Trade" : /add/i.test(type) ? "Add" : /drop/i.test(type) ? "Drop" : ""; }
function linkPlayers(text) {
  // "Team gets: A, B, 2029 1st (X's)  |  Team gets: C"  or a single name
  return String(text).split(/\s+\|\s+/).map(function (part) {
    var m = part.match(/^(.*? gets:)\s*(.*)$/);
    if (!m) return /^\d{4} \d/.test(part) || !part.trim() ? esc(part) : pbtn(part.trim());
    var items = m[2].split(/,\s*(?![^()]*\))/).map(function (it) {
      it = it.trim();
      return !it || /^\d{4} \d/.test(it) || it === "nothing" ? esc(it) : pbtn(it);
    });
    return "<div><b>" + esc(m[1]) + "</b> " + items.join(", ") + "</div>";
  }).join("");
}
function logList() {
  var f = S.lg, rows = S.log.rows.filter(function (r) {
    if (f.type && logKind(r.type) !== f.type && r.type !== f.type) return false;
    if (f.team && r.teams.toLowerCase().indexOf(teamName(f.team).toLowerCase()) < 0) return false;
    return true;
  });
  var shown = rows.slice(0, f.n);
  return box("", (shown.map(function (r) {
    return '<div class="ent"><div class="d">' + esc(r.when) + '</div><div class="body"><span class="badge ' + logKind(r.type) + '">' + esc(r.type) + "</span>" +
      "<b>" + esc(r.teams) + "</b>" + (r.status ? ' <span class="chip">' + esc(r.status) + "</span>" : "") +
      "<div>" + linkPlayers(r.players) + "</div>" + (r.details ? '<div class="muted small">' + esc(r.details) + "</div>" : "") + "</div></div>";
  }).join("") || '<div class="empty">No transactions match.</div>')) +
    (rows.length > shown.length ? '<button class="more" data-act="logMore">Show more</button>' : "");
}
function pageLog() {
  if (!S.log) {
    api("getLog").then(function (d) { S.log = d; if (/^log/.test(S.hash)) rerender(); }, function (e) { view().innerHTML = box("", '<div class="err">' + esc(e.message) + "</div>"); });
    return '<div class="pagehead"><h1>Transactions</h1></div>' + loading("Loading the League Log");
  }
  var types = [["", "All types"], ["Trade", "Trades"], ["Add", "Adds"], ["Drop", "Drops"]];
  S.log.rows.forEach(function (r) { if (!logKind(r.type) && !types.some(function (t) { return t[0] === r.type; })) types.push([r.type, r.type]); });
  return '<div class="pagehead"><div><h1>Transactions</h1><div class="sub">League Log, newest first' + (S.log.lastSync ? " · last synced " + esc(S.log.lastSync) : "") + "</div></div></div>" +
    '<div class="row start"><select data-act="logTeam" aria-label="Team">' + teamOptions(S.lg.team, "All teams") + "</select>" +
    '<select data-act="logType" aria-label="Type">' + types.map(function (t) { return opt(t[0], t[1], S.lg.type === t[0]); }).join("") + "</select></div>" +
    '<div id="logList">' + logList() + "</div>";
}

/* ============================ rules ============================ */
function pageRules() {
  if (!S.rules) {
    api("getRules").then(function (d) { S.rules = d; if (/^rules/.test(S.hash)) rerender(); }, function (e) { view().innerHTML = box("", '<div class="err">' + esc(e.message) + "</div>"); });
    return '<div class="pagehead"><h1>Rules</h1></div>' + loading("Loading the Rules tab");
  }
  var sections = [], cur = [];
  S.rules.rows.forEach(function (r) {
    if (!r.length || r.every(function (v) { return !v; })) { if (cur.length) sections.push(cur); cur = []; }
    else cur.push(r);
  });
  if (cur.length) sections.push(cur);
  var html = sections.map(function (rows) {
    var title = rows[0].filter(Boolean).length === 1 && rows.length > 1 ? rows.shift()[0] : "";
    var w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    return box(title, '<div class="tbl"><table class="rules">' + rows.map(function (r) {
      var cells = []; for (var i = 0; i < w; i++) cells.push("<td>" + esc(r[i] || "") + "</td>");
      return "<tr>" + cells.join("") + "</tr>";
    }).join("") + "</table></div>");
  }).join("");
  return '<div class="pagehead"><div><h1>Rules</h1><div class="sub">From the Rules tab</div></div></div>' + html;
}

/* ============================ commissioner ============================ */
var ADMIN_TABS = [["pending", "Pending"], ["contracts", "Contracts"], ["holds", "Cap holds"], ["waive", "Waived & re-signed"],
                  ["cash", "Cash"], ["ranks", "Rankings"], ["sync", "Sync & log"]];

function adminLogout(msg) { Admin.signOut(); if (msg) toast(msg, true); rerender(); }
// Runs mutation steps as one commit, then shows the result right away
// (the public site catches up when GitHub Pages redeploys, about a minute).
function adminCall(steps, okMsg) {
  return Admin.apply(steps).then(function (res) {
    ["contracts", "holds", "cash", "teams", "adminLog"].forEach(function (k) { DATA[k] = res.D[k]; });
    S.admin.log = null;
    rebuild();
    toast((typeof okMsg === "function" ? okMsg(res) : okMsg || "Saved") + ". The public site updates in about a minute.");
    return res;
  }, function (e) {
    if (/sign in again/i.test(e.message)) adminLogout(e.message); else toast(e.message, true);
    throw e;
  });
}
function activeNames() {
  return '<datalist id="activeNames">' + S.L.contracts.filter(function (c) { return !c.hold; })
    .map(function (c) { return "<option value=\"" + esc(c.n) + "\">"; }).join("") + "</datalist>";
}

function pageAdmin() {
  var A = S.admin;
  if (!Admin.signedIn()) {
    return '<div class="pagehead"><div><h1>Commissioner</h1><div class="sub">Edit contracts, cap holds, cash and rankings</div></div></div>' +
      '<div class="box" style="max-width:560px"><form id="loginForm"><label class="f">GitHub token<input type="password" id="pass" autocomplete="off" placeholder="github_pat_…"></label>' +
      '<div class="row" style="margin:10px 0 0"><button class="btn pri" type="submit">Sign in</button><span class="err small" id="loginMsg"></span></div></form>' +
      '<p class="muted small">Every edit is saved as a commit to the league\'s GitHub repo, so commissioners sign in with a GitHub token that can write to ' +
      esc(SITE.owner + "/" + SITE.repo) + '. Make one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub › Settings › Fine-grained tokens</a>: ' +
      "repository access “Only select repositories” → this repo; permissions <b>Contents: Read and write</b> and <b>Actions: Read and write</b>. " +
      "The token stays in this browser until you sign out.</p></div>";
  }
  var tabs = '<div class="seg" style="margin-bottom:12px">' + ADMIN_TABS.map(function (t) {
    return '<button data-act="adminTab" data-v="' + t[0] + '" class="' + (A.tab === t[0] ? "on" : "") + '">' + t[1] + "</button>"; }).join("") + "</div>";
  var body = ({ pending: adminPending, contracts: adminContracts, holds: adminHolds, waive: adminWaive, cash: adminCash,
                ranks: adminRanks, sync: adminSync })[A.tab]();
  return '<div class="pagehead"><div><h1>Commissioner</h1><div class="sub">Signed in as ' + esc(Admin.who()) + ' · every change is a commit to the repo and goes in the Admin Log</div></div>' +
    '<button class="btn" data-act="logout">Sign out</button></div>' + tabs + (A.edit ? contractEditor(A.edit) : "") + body + activeNames();
}

function contractEditor(c) {
  var L = S.L;
  var rows = L.seasons.map(function (s, i) {
    var v = c.sal[i];
    return "<tr><td>" + esc(s) + '</td><td class="l"><input type="text" data-sal="' + i + '" value="' + esc(typeof v === "number" ? v : v || "") + '" style="width:90px" placeholder="—"></td>' +
      '<td class="l"><select data-stat="' + i + '">' + ["", "PO", "TO", "MAX", "SMAX", "HOLD"].map(function (x) { return opt(x, x || "—", (c.st[i] || "") === x); }).join("") + "</select></td></tr>";
  }).join("");
  return '<div class="box" id="editor"><h3>' + (c.id ? "Edit contract · " + esc(c.n) : "New contract") + "</h3>" +
    '<div class="form"><label class="f">Player name<input type="text" data-k="n" value="' + esc(c.n) + '"></label>' +
    '<label class="f">NBA team<input type="text" data-k="nba" value="' + esc(c.nba) + '" placeholder="ATL (Z if unknown)" style="text-transform:uppercase"></label></div>' +
    '<div class="tbl" style="margin:10px 0"><table><tr><th>Season</th><th class=l>Salary ($M, UFA, RFA)</th><th class=l>Status</th></tr>' + rows + "</table></div>" +
    '<label class="f">Contract details<input type="text" data-k="det" value="' + esc(c.det) + '"></label>' +
    '<p class="muted small">' + (c.id ? "Name it “Player (cap hold)” to make it a cap hold." : "A new contract goes at the end of its NBA team's group.") + "</p>" +
    '<div class="row start"><button class="btn pri" data-act="saveContract">Save</button><button class="btn" data-act="cancelEdit">Cancel</button>' +
    (c.id ? '<button class="btn danger" data-act="deleteContract" data-confirm="Tap again to delete">Delete contract</button>' : "") + "</div></div>";
}
function editable(c) { return { id: c.id, n: c.n, nba: c.nba, sal: c.sal.slice(), st: c.st.slice(), det: c.det }; }
function contractList(list) {
  if (!list.length) return '<div class="empty">Nothing here.</div>';
  var idx = rosterIdx();
  return '<div class="tbl"><table><tr><th>Player</th><th class=l>NBA</th><th class=l>Team</th><th>' + esc(S.L.season) + '</th><th class=l>Details</th><th></th></tr>' +
    list.map(function (c) {
      var r = idx[LM.norm(c.n)];
      return '<tr><td class="name">' + pbtn(c.n) + '</td><td class="l muted">' + esc(c.nba) + '</td><td class="l">' + (c.hold ? esc(holdTeam(c.n)) : r ? esc(r.code) : "—") +
        "</td><td>" + salCell(c, 0) + '</td><td class="l muted small">' + esc(c.det) + '</td><td><button class="btn sm" data-act="edit" data-id="' + c.id + '">Edit</button></td></tr>';
    }).join("") + "</table></div>";
}
function contractSearch(q) {
  var qn = LM.norm(q);
  return S.L.contracts.filter(function (c) { return LM.norm(c.n).indexOf(qn) >= 0 || c.nba.toLowerCase() === q.trim().toLowerCase(); }).slice(0, 40);
}
function adminPending() {
  var list = S.L.contracts.filter(function (c) { return /pending/i.test(c.det); });
  return box("Pending contracts · " + list.length, '<p class="muted small" style="margin-top:0">The sync adds one of these whenever a team picks up a player without a contract. Set the salary and clear the PENDING note.</p>' + contractList(list));
}
function adminContracts() {
  var q = S.admin.q.trim();
  return '<div class="box"><div class="row"><input type="search" class="grow" id="cq" placeholder="Find a contract by player or NBA team" value="' + esc(q) + '">' +
    '<button class="btn" data-act="newContract">New contract</button></div><div id="cList">' + (q ? contractList(contractSearch(q)) : '<div class="empty">Search to edit or delete a contract.</div>') + "</div></div>";
}
function adminHolds() {
  var holds = S.L.holds.slice().sort(function (a, b) { return a.code.localeCompare(b.code) || a.name.localeCompare(b.name); });
  var rows = holds.map(function (h) {
    var c = S.L.contracts.filter(function (x) { return x.hold && LM.norm(x.n) === LM.norm(h.name); })[0];
    return "<tr><td>" + esc(h.code) + '</td><td class="l">' + pbtn(h.name) + (c ? "" : '<span class="flag bad">No contract</span>') + "</td><td>" + salCell(c, 0) + '</td><td class="l muted small">' + esc(h.note || "") + "</td><td>" +
      '<button class="btn sm danger" data-act="rmHold" data-id="' + h.id + '" data-confirm="Tap again">Remove</button></td></tr>';
  }).join("");
  return box("Make a player a cap hold",
      '<div class="form"><label class="f">Player<input type="text" list="activeNames" data-k="holdName" placeholder="Name on the contracts list"></label>' +
      '<label class="f">Team that carries it<select data-k="holdCode">' + teamOptions("", "Pick a team") + "</select></label>" +
      '<button class="btn pri" data-act="addHold">Add cap hold</button></div><p class="muted small">Renames his contract to “(cap hold)” and puts it on that team. Removing a hold takes it off the team but keeps the contract row; delete that under Contracts if it\'s gone for good.</p>') +
    box("Cap holds · " + holds.length, '<div class="tbl"><table><tr><th>Team</th><th class=l>Player</th><th>' + esc(S.L.season) + "</th><th class=l>Note</th><th></th></tr>" + rows + "</table></div>");
}
function adminWaive() {
  var w = S.admin.waive || {};
  return box("Waived & re-signed",
    '<p class="muted small" style="margin-top:0">For a player who was waived and signed again: his old contract becomes a cap hold on the team that waived him, and he gets a new $2.0M / 1-year minimum (then UFA) in his NBA team\'s group.</p>' +
    '<div class="form"><label class="f">Player<input type="text" list="activeNames" data-k="waiveName" value="' + esc(w.name || "") + '" placeholder="Name on the contracts list"></label>' +
    '<label class="f">Team that carries the cap hold<select data-k="waiveCode">' + teamOptions(w.code || "", "Which team waived him?") + "</select></label>" +
    '<button class="btn pri" data-act="waive">Convert</button></div>' +
    (w.msg ? '<p class="ok">' + esc(w.msg) + "</p>" : ""));
}
function adminCash() {
  var L = S.L, A = S.admin, season = A.cashSeason || L.season;
  var bal = {};
  L.cash.forEach(function (x) { if (x.season === season) bal[x.code] = LM.r1((bal[x.code] || 0) + x.amt); });
  var chips = Object.keys(bal).filter(function (k) { return bal[k]; }).sort().map(function (k) {
    return '<span class="chip ' + (Math.abs(bal[k]) > L.limits.cash ? "inj" : "") + '">' + esc(k) + " " + signed(bal[k]) + "</span>"; }).join(" ");
  var rows = L.cash.slice().reverse().map(function (x) {
    return "<tr><td>" + esc(x.code) + '</td><td class="l muted">' + esc(String(x.date || "").slice(0, 10)) + '</td><td class="l">' + esc(x.season) + '</td><td class="' + cls(x.amt) + '">' + signed(x.amt) +
      '</td><td class="l small">' + esc(x.note) + (x.ref ? ' <span class="muted">' + esc(x.ref) + "</span>" : "") + "</td><td>" +
      '<button class="btn sm danger" data-act="rmCashRow" data-id="' + x.id + '" data-confirm="Tap again">Delete</button></td></tr>';
  }).join("");
  return box("Record a cash transfer",
      '<div class="form"><label class="f">Season<select data-k="cashSeason">' + L.seasons.map(function (s) { return opt(s, s, s === season); }).join("") + "</select></label>" +
      '<label class="f">From (sends)<select data-k="cashFrom">' + teamOptions("", "Pick a team") + "</select></label>" +
      '<label class="f">To (receives)<select data-k="cashToTeam">' + teamOptions("", "Pick a team") + "</select></label>" +
      '<label class="f">Amount ($M)<input type="number" min="0.5" step="0.5" inputmode="decimal" data-k="cashAmt"></label>' +
      '<label class="f">Note<input type="text" data-k="cashNote" placeholder="e.g. trade with Utah"></label></div>' +
      '<div class="row start" style="margin-top:10px"><label class="check"><input type="checkbox" data-k="cashOverride"> Override the ±$' + L.limits.cash + 'M balance limit</label>' +
      '<button class="btn pri" data-act="recordCash">Record</button></div>' +
      '<p class="muted small">Adds two ledger rows: +amount for the sender (adds to its payroll) and −amount for the receiver.</p>') +
    box("Balances " + esc(season), chips || '<span class="muted">Every team is at $0.0.</span>') +
    box("Cash Ledger", '<div class="tbl"><table><tr><th>Team</th><th class=l>Date</th><th class=l>Season</th><th>Amount</th><th class=l>Note</th><th></th></tr>' + rows + "</table></div>");
}
function adminRanks() {
  return box("Power rankings", '<p class="muted small" style="margin-top:0">Rank numbers for the standings. Records and points come from Sleeper.</p>' +
    '<div class="tbl"><table><tr><th>Team</th><th>Rank</th><th>W-L-T</th><th>PF</th></tr>' + S.L.teams.map(function (t) {
      return "<tr><td>" + esc(t.name) + '</td><td><input type="number" min="1" max="30" style="width:70px" data-rank="' + esc(t.code) + '" value="' + (t.rank == null ? "" : t.rank) + '"></td><td>' +
        t.w + "-" + t.l + (t.t ? "-" + t.t : "") + "</td><td>" + f1(t.pf) + "</td></tr>"; }).join("") +
    '</table></div><div class="row start" style="margin-top:10px"><button class="btn pri" data-act="saveRanks">Save rankings</button></div>');
}
function adminSync() {
  var log = S.admin.log;
  if (!log) Admin.adminLog().then(function (r) { S.admin.log = r; if (S.admin.tab === "sync" && /^admin/.test(S.hash)) rerender(); },
    function (e) { S.admin.log = []; toast(e.message, true); });
  return box("Sleeper sync", '<p class="muted small" style="margin-top:0">Runs on GitHub every 5 minutes (GitHub sometimes runs it a few minutes late). Last change it made: ' +
      esc(S.L.lastSync ? when(S.L.lastSync) : "—") + ".</p>" +
      '<button class="btn pri" data-act="runSync">Run sync now</button>' +
      ' <a class="small" href="https://github.com/' + esc(SITE.owner + "/" + SITE.repo) + '/actions" target="_blank" rel="noopener">See runs on GitHub</a>') +
    box("Admin Log", !log ? loading() : log.length ? log.slice(0, 200).map(function (r) {
      return '<div class="ent"><div class="d">' + esc(when(r.ts)) + '</div><div class="body"><b>' + esc(r.action) + '</b> <span class="muted small">' + esc(r.who || "") + '</span><div class="small">' + esc(r.details) + "</div></div></div>"; }).join("")
      : '<div class="empty">Nothing logged yet.</div>');
}
function val(k) { var el = view().querySelector('[data-k="' + k + '"]'); return el ? (el.type === "checkbox" ? el.checked : el.value) : ""; }

/* ============================ events ============================ */
function armed(btn) {
  // two-tap confirm for destructive buttons
  if (!btn.hasAttribute("data-confirm")) return true;
  if (btn.classList.contains("armed")) return true;
  btn.classList.add("armed");
  btn.setAttribute("data-label", btn.textContent);
  btn.textContent = btn.getAttribute("data-confirm");
  setTimeout(function () { btn.classList.remove("armed"); btn.textContent = btn.getAttribute("data-label"); }, 4000);
  return false;
}
function busy(btn, p) {
  if (btn) btn.disabled = true;
  return p.then(function (r) { if (btn) btn.disabled = false; return r; }, function () { if (btn) btn.disabled = false; });
}

document.addEventListener("click", function (ev) {
  var t = ev.target;
  var p = t.closest && t.closest(".plink[data-player]");
  if (p) { ev.preventDefault(); openPlayer(p.getAttribute("data-player")); return; }
  var g = t.closest && t.closest("[data-go]");
  if (g) { ev.preventDefault(); if ($("modal").classList.contains("open")) closePlayer(); Nav.go(g.getAttribute("data-go")); return; }
  if (t.id === "modal" || t.id === "modalClose") { closePlayer(); return; }
  var b = t.closest && t.closest("button[data-act]");
  if (!b || !view().contains(b)) return;
  var act = b.getAttribute("data-act"), A = S.admin;
  if (!armed(b)) return;

  switch (act) {
    case "download":
      busy(b, Export.download(S.L, LOCAL.getLog, LOCAL.getRules).then(function () { toast("Spreadsheet downloaded"); }, function (e) { toast(e.message, true); }));
      break;
    case "plFilter": S.pl.f = b.getAttribute("data-v"); S.pl.limit = 150; rerender(); break;
    case "plMore": S.pl.limit += 150; $("plTable").innerHTML = plTable(); break;
    case "logMore": S.lg.n += 100; $("logList").innerHTML = logList(); break;

    case "toResult": window.scrollTo(0, $("tradeResult").getBoundingClientRect().top + window.scrollY - 70); break;
    case "clearTrade": S.trade = { teams: S.trade.teams.slice(0, 2), moves: [] }; tradeChanged(); break;
    case "share":
      S.shareUrl = location.href.split("#")[0].split("?")[0] + "#" + tradeEncode(S.trade);
      var y = window.scrollY; view().innerHTML = pageTrade("") + footer(); window.scrollTo(0, y);
      var inp = $("shareUrl"); inp.select();
      if (navigator.clipboard) navigator.clipboard.writeText(S.shareUrl).then(function () { toast("Link copied"); }, function () { toast("Copy the link from the box"); });
      else toast("Copy the link from the box");
      break;
    case "addCash":
      var from = b.getAttribute("data-from");
      var amt = LM.r1(Number(view().querySelector('[data-role="cashAmt"][data-from="' + from + '"]').value));
      var to = view().querySelector('[data-role="cashTo"][data-from="' + from + '"]').value;
      if (!(amt > 0)) { toast("Enter an amount in $M", true); break; }
      S.trade.moves.push({ type: "cash", amt: amt, from: from, to: to }); tradeChanged(); break;
    case "rmCash":
      var f = b.getAttribute("data-from"), tt = b.getAttribute("data-to"), a = Number(b.getAttribute("data-amt")), done = false;
      S.trade.moves = S.trade.moves.filter(function (m) { if (!done && m.type === "cash" && m.from === f && m.to === tt && m.amt === a) { done = true; return false; } return true; });
      tradeChanged(); break;
    case "recordTradeCash":
      var ref = "Trade " + new Date().toISOString().slice(0, 10) + " " + S.trade.teams.join("/");
      var steps = S.trade.moves.filter(function (m) { return m.type === "cash"; }).map(function (m) {
        return ["recordCash", { season: S.L.season, from: m.from, to: m.to, amt: m.amt, note: "Trade: " + m.from + " → " + m.to, ref: ref }];
      });
      busy(b, adminCall(steps, "Cash recorded in the ledger").then(rerender));
      break;

    case "logout": adminLogout(); break;
    case "adminTab": A.tab = b.getAttribute("data-v"); A.edit = null; rerender(); break;
    case "edit":
      var id = Number(b.getAttribute("data-id"));
      A.edit = editable(S.L.contracts.filter(function (c) { return c.id === id; })[0]); rerender(); window.scrollTo(0, $("editor").offsetTop - 70); break;
    case "newContract": A.edit = { id: null, n: "", nba: "", sal: [], st: [], det: "" }; rerender(); break;
    case "cancelEdit": A.edit = null; rerender(); break;
    case "saveContract":
      var ed = $("editor"), c = {
        id: A.edit.id, n: val("n").trim(), nba: val("nba").trim().toUpperCase(), det: val("det"),
        sal: S.L.seasons.map(function (_, i) { return ed.querySelector('[data-sal="' + i + '"]').value.trim(); }),
        st: S.L.seasons.map(function (_, i) { return ed.querySelector('[data-stat="' + i + '"]').value; }),
      };
      busy(b, adminCall([["saveContract", c]], "Contract saved").then(function () { A.edit = null; rerender(); }));
      break;
    case "deleteContract":
      busy(b, adminCall([["deleteContract", { id: A.edit.id }]], "Contract deleted").then(function () { A.edit = null; rerender(); }));
      break;
    case "addHold":
      busy(b, adminCall([["addHold", { name: val("holdName"), code: val("holdCode") }]], function (r) { return r.logs[0]; }).then(rerender));
      break;
    case "rmHold":
      busy(b, adminCall([["removeHold", { id: Number(b.getAttribute("data-id")) }]], "Cap hold removed").then(rerender));
      break;
    case "waive":
      var w = { name: val("waiveName"), code: val("waiveCode") };
      if (!w.code) { A.waive = Object.assign(w, { msg: "" }); toast("Which team carries his cap hold? Pick the team that waived him.", true); break; }
      busy(b, adminCall([["waiveResign", w]], "Done").then(function (res) { A.waive = { msg: res.logs[0] }; rerender(); }));
      break;
    case "recordCash":
      A.cashSeason = val("cashSeason");
      busy(b, adminCall([["recordCash", { season: val("cashSeason"), from: val("cashFrom"), to: val("cashToTeam"), amt: Number(val("cashAmt")),
        note: val("cashNote"), override: val("cashOverride") }]], "Cash recorded").then(rerender));
      break;
    case "rmCashRow":
      busy(b, adminCall([["deleteCash", { id: Number(b.getAttribute("data-id")) }]], "Ledger row deleted").then(rerender));
      break;
    case "saveRanks":
      var ranks = Array.prototype.map.call(view().querySelectorAll("[data-rank]"), function (el) { return { code: el.getAttribute("data-rank"), rank: el.value }; });
      busy(b, adminCall([["setRanks", ranks]], "Rankings saved").then(rerender));
      break;
    case "runSync":
      busy(b, Admin.runSync().then(function () { toast("Sync started on GitHub. Changes show up here in a couple of minutes."); }, function (e) { toast(e.message, true); }));
      break;
  }
});

document.addEventListener("change", function (ev) {
  var t = ev.target, act = t.getAttribute && t.getAttribute("data-act");
  if (!act || !view().contains(t)) return;
  if (act === "pickTeam") Nav.go("team/" + t.value);
  else if (act === "tradeTeam") {
    var i = Number(t.getAttribute("data-i")), teams = S.trade.teams.slice();
    if (t.value && teams.indexOf(t.value) >= 0 && teams[i] !== t.value) { toast("That team is already in the trade", true); t.value = teams[i] || ""; return; }
    if (t.value) teams[i] = t.value; else teams.splice(i, 1);
    S.trade.teams = teams.filter(Boolean).slice(0, 4);
    tradeChanged();
  } else if (act === "move") {
    var type = t.getAttribute("data-type"), key = t.getAttribute("data-key"), from = t.getAttribute("data-from");
    S.trade.moves = S.trade.moves.filter(function (m) { return !(m.type === type && m.from === from && (type === "player" ? m.name === key : m.label === key)); });
    if (t.value) { var m = { type: type, from: from, to: t.value }; m[type === "player" ? "name" : "label"] = key; S.trade.moves.push(m); }
    tradeChanged();
  } else if (act === "logTeam") { S.lg.team = t.value; S.lg.n = 100; $("logList").innerHTML = logList(); }
  else if (act === "logType") { S.lg.type = t.value; S.lg.n = 100; $("logList").innerHTML = logList(); }
});

var inputTimer = null;
document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t.id === "plq") { clearTimeout(inputTimer); inputTimer = setTimeout(function () { S.pl.q = t.value; S.pl.limit = 150; $("plTable").innerHTML = plTable(); }, 120); }
  else if (t.id === "cq") { clearTimeout(inputTimer); inputTimer = setTimeout(function () {
    S.admin.q = t.value; $("cList").innerHTML = S.admin.q.trim() ? contractList(contractSearch(S.admin.q)) : '<div class="empty">Search to edit or delete a contract.</div>'; }, 120); }
});

document.addEventListener("submit", function (ev) {
  if (ev.target.id !== "loginForm") return;
  ev.preventDefault();
  var btn = ev.target.querySelector("button");
  busy(btn, Admin.signIn($("pass").value).then(function (who) { toast("Signed in as " + who); rerender(); },
    function (e) { $("loginMsg").textContent = e.message; }));
});

document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && $("modal").classList.contains("open")) closePlayer(); });

/* ============================ start ============================ */
(function start() {
  Card.bind($("card"));
  loadLeague().then(function () {
    window.addEventListener("hashchange", function () { if (location.hash.slice(1) !== S.hash) route(location.hash.slice(1)); });
    route(location.hash.slice(1));
    var n = new URLSearchParams(location.search).get("n");
    if (n) openPlayer(n);
  }, function (e) {
    view().innerHTML = box("", '<div class="err">Couldn\'t load the league: ' + esc(e.message) + '</div><p class="muted small">Sleeper or this site may be having a moment. Reload to try again.</p>');
  });
})();
