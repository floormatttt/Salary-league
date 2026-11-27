/* League site: routing, pages, trade machine, commissioner tools.
 * Data: data/*.json (this repo, kept current by the Sleeper sync and commissioner
 * edits) + live Sleeper rosters/records/picks + ESPN game logs, all fetched in
 * the browser. Routes (hash): "" home · contracts · standings · team/ATL ·
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
  return Promise.all([dataFile("contracts"), dataFile("holds"), dataFile("cash"), dataFile("teams"), dataFile("players"), dataFile("state"), dataFile("espn").catch(function () { DATA.espn = {}; return {}; }),
    sleeper("/league/" + id), sleeper("/league/" + id + "/rosters"), sleeper("/league/" + id + "/users"), sleeper("/league/" + id + "/traded_picks")])
    .then(function (r) {
      LIVE = { league: r[7], rosters: r[8], users: r[9], traded: r[10] };
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
  // Every Sleeper transaction (data/txns.json, this league and the ones before it), with the
  // League Log's notes (cap hold created, needs contract…) on the moves they describe.
  getLog: function () {
    return Promise.all([dataFile("log"), dataFile("txns").catch(function () { return []; }), dataFile("adminLog").catch(function () { return []; })]).then(function (r) {
      var log = r[0], tx = r[1] || [], alog = r[2] || [];
      var byTs = {};
      log.forEach(function (x) { byTs[new Date(x.ts).getTime()] = x; });
      var rows = tx.length ? tx.map(function (t) { return fromSleeper(t, byTs[t.ts]); }) : log.slice();
      rows = rows.concat(holdRows(tx), extensionRows(alog));
      rows.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
      return { rows: rows.map(function (x) { return Object.assign({ when: when(x.ts) }, x); }), lastSync: S.L.lastSync ? when(S.L.lastSync) : "" };
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
// One Sleeper transaction -> a log row { ts, season, type, teams, players, details, status }.
// players: "Team gets: A, B, 2029 1st (X's)  |  Team gets: …" for trades, "Team adds: … | Team drops: …" otherwise.
function fromSleeper(t, note) {
  var byRid = {}; DATA.teams.forEach(function (x) { byRid[String(x.rid)] = x.name; });
  var team = function (rid) { return byRid[String(rid)] || "Roster " + rid; };
  var nm = function (pid) { var p = DATA.players[pid]; return p ? p[0] : "Player " + pid; };
  var a = t.a || {}, d = t.d || {}, row = { ts: new Date(t.ts).toISOString(), season: t.s, details: "", status: "" };
  if (t.ty === "trade") {
    var rids = (t.r || []).map(String);
    row.type = "Trade";
    row.teams = rids.map(team).join(" ↔ ");
    row.players = rids.map(function (rid) {
      var items = Object.keys(a).filter(function (p) { return String(a[p]) === rid; }).map(nm);
      (t.p || []).forEach(function (pk) {
        if (String(pk[3]) === rid && String(pk[4]) !== rid) items.push(pk[0] + " " + Mutations.ordinal(pk[1]) + " (" + team(pk[2]) + "'s)");
      });
      return team(rid) + " gets: " + (items.join(", ") || "nothing");
    }).join("  |  ");
  } else {
    var rosters = [];
    Object.keys(a).concat(Object.keys(d)).forEach(function (p) { var rid = String(a[p] != null ? a[p] : d[p]); if (rosters.indexOf(rid) < 0) rosters.push(rid); });
    Object.keys(d).forEach(function (p) { if (rosters.indexOf(String(d[p])) < 0) rosters.push(String(d[p])); });
    var adds = Object.keys(a).length, drops = Object.keys(d).length;
    row.type = (t.ty === "commissioner" ? "Commish " : "") + (adds && drops ? "Add/Drop" : adds ? "Add" : "Drop");
    row.teams = rosters.map(team).join(" ↔ ");
    row.players = rosters.map(function (rid) {
      var add = Object.keys(a).filter(function (p) { return String(a[p]) === rid; }).map(nm);
      var drop = Object.keys(d).filter(function (p) { return String(d[p]) === rid; }).map(nm);
      return [add.length ? team(rid) + " adds: " + add.join(", ") : "", drop.length ? team(rid) + " drops: " + drop.join(", ") : ""].filter(Boolean).join("  |  ");
    }).filter(Boolean).join("  |  ");
    if (t.b != null) row.details = "$" + t.b + " FAAB bid";
  }
  if (note) { row.details = note.details || row.details; row.status = note.status || ""; }
  return row;
}
// Cap holds as log rows, dated by the Sleeper drop that made them (else the date they were added)
function holdRows(tx) {
  var ridOf = {}, nameOf = {};
  DATA.teams.forEach(function (t) { ridOf[t.code] = String(t.rid); nameOf[t.code] = t.name; });
  var drops = {};                                   // rid|norm(name) -> latest drop
  (tx || []).forEach(function (t) {
    Object.keys(t.d || {}).forEach(function (pid) {
      var p = DATA.players[pid], k = String(t.d[pid]) + "|" + LM.norm(p ? p[0] : "");
      if (!drops[k] || drops[k].ts < t.ts) drops[k] = t;
    });
  });
  var season = LIVE.league && LIVE.league.season;
  return (DATA.holds || []).map(function (h) {
    var name = plain(h.name), drop = drops[ridOf[h.code] + "|" + LM.norm(name)];
    return { ts: drop ? new Date(drop.ts).toISOString() : h.added, season: drop ? drop.s : season, type: "Cap hold", teams: nameOf[h.code] || h.code,
      players: name, details: /^Imported/.test(h.note || "") ? "" : h.note || "", status: "" };
  });
}
// Extensions recorded on the commissioner page (dated, from the admin log)
function extensionRows(alog) {
  var season = LIVE.league && LIVE.league.season;
  return (alog || []).filter(function (r) { return /Extension|Restructure/.test(r.action); }).map(function (r) {
    var re = /Restructure/.test(r.action);
    var m = (re ? /Restructured (.*?) \(([A-Z]+)\): (.*)$/ : /Extended (.*?) \(([A-Z]+)\): (.*)$/).exec(r.details) || [];
    var who = rosterIdx()[LM.norm(m[1] || "")];
    return { ts: r.ts, season: season, type: re ? "Restructure" : "Extension", teams: who ? teamName(who.code) : "", players: m[1] || "", details: m[3] || r.details, status: "" };
  });
}
// Extensions already on the books (contract details say "Ext 27-28"), not dated
function bookedExtensions() {
  var idx = rosterIdx();
  return S.L.contracts.filter(function (c) { return !c.hold && /\bExt\b|Restructure/.test(c.det); }).map(function (c) {
    var r = idx[LM.norm(c.n)];
    return { c: c, code: r ? r.code : "", kind: /\bExt\b/.test(c.det) ? "Ext" : "Rest" };
  });
}
function seasonLabel(s) { s = Number(s); return s ? s + "-" + String((s + 1) % 100).padStart(2, "0") : ""; }

// Same call style the card code uses
function api(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  return Promise.resolve().then(function () { return LOCAL[fn].apply(null, args); });
}

var S = {
  L: null, books: {}, rIdx: null, log: null, rules: null, hash: "",
  pl: { q: "", f: "all", ks: [], kmode: "any", team: "", sort: "s0", asc: false, limit: 150, more: false,
        ss: 0, smin: "", smax: "", yl: "", fmin: "", gmin: "" },
  st: { season: "", q: "", f: "all", team: "", sort: "fppg", asc: false, per: "game", qual: true, limit: 100 },
  stats: {},
  lg: { team: "", type: "", season: "", n: 100 },
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
// A salary as a pill colored by the kind of money (LeagueMath.moneyKind); the status code stays as text
/* Custom dropdown: a button plus a menu of rich options (team colors, badges).
 * items: [{ v, html, label }]; picking one runs onPick(act, v), same as a <select> change. */
function dropdown(act, value, items, aria, cls) {
  var cur = items.filter(function (it) { return it.v === value; })[0] || items[0];
  return '<div class="dd' + (cls ? " " + cls : "") + '"><button type="button" class="dd-btn" data-act="ddToggle" aria-haspopup="listbox" aria-expanded="false" aria-label="' + esc(aria) + '">' +
    '<span class="dd-cur">' + cur.html + '</span><svg class="dd-caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<div class="dd-menu" role="listbox" hidden>' + items.map(function (it) {
      return '<button type="button" role="option" class="dd-opt' + (it.v === value ? " on" : "") + (it.cls ? " " + it.cls : "") + '" data-act="ddPick" data-dd="' + esc(act) + '" data-v="' + esc(it.v) + '"' +
        (it.style || "") + ' aria-selected="' + (it.v === value) + '">' + it.html + "</button>";
    }).join("") + "</div></div>";
}
// Team items: color chip + name + payroll level dot
function teamItems(blank) {
  var list = S.L.teams.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (t) {
    var p = book(t.code).payroll[0], tier = LM.tierOf(p);
    return { v: t.code, style: teamStyle(t.code), cls: "team-opt",
      html: '<span class="tcode tc"' + teamStyle(t.code) + ">" + esc(t.code) + '</span><span class="dd-name">' + esc(t.name) + "</span>" +
        '<span class="dd-dot t-' + tier.key + '" title="' + esc(tier.label) + '"></span>' };
  });
  return blank != null ? [{ v: "", cls: "all-opt", html: '<span class="dd-name">' + esc(blank) + "</span>" }].concat(list) : list;
}
function onPick(act, v, el) {
  if (act.indexOf("field:") === 0 && el) {
    var dd = el.closest(".dd"), wrap = dd.parentNode;
    wrap.querySelector('input[type="hidden"]').value = v;
    dd.querySelector(".dd-cur").innerHTML = el.innerHTML;
    Array.prototype.forEach.call(dd.querySelectorAll(".dd-opt"), function (o) { o.classList.toggle("on", o === el); o.setAttribute("aria-selected", String(o === el)); });
    if (/^field:ext/.test(act)) refreshExt();
    if (act === "field:cashSeason") { S.admin.cashSeason = v; rerender(); }
    return;
  }
  if (act === "pickTeam") Nav.go("team/" + v);
  else if (act === "plTeam") { S.pl.team = v; S.pl.limit = 150; rerender(); }
  else if (act === "plSalS") { S.pl.ss = Number(v); S.pl.limit = 150; rerender(); }
  else if (act === "logTeam") { S.lg.team = v; S.lg.n = 100; rerender(); }
  else if (act === "logType") { S.lg.type = v; S.lg.n = 100; rerender(); }
  else if (act === "stTeam") { S.st.team = v; S.st.limit = 100; rerender(); }
  else if (act === "stSeason") { S.st.season = v; S.st.limit = 100; rerender(); }
  else if (act === "logSeason") { S.lg.season = v; S.lg.n = 100; rerender(); }
}
function closeMenus(except) {
  Array.prototype.forEach.call(document.querySelectorAll(".dd.open"), function (d) {
    if (d === except) return;
    d.classList.remove("open"); d.querySelector(".dd-menu").hidden = true; d.querySelector(".dd-btn").setAttribute("aria-expanded", "false");
  });
}
// Projected draft slot right now: reverse standings (worst record picks first), same order every round
function projSlot(pk) {
  if (!S.projIdx) {
    S.projIdx = {};
    LM.standings(S.L.teams).reverse().forEach(function (t, i) { S.projIdx[t.code] = i + 1; });
  }
  var n = S.projIdx[pk.from];
  return n ? { slot: n, overall: (pk.round - 1) * S.L.teams.length + n, label: pk.round + "." + (n < 10 ? "0" : "") + n } : null;
}
function projTag(pk) {
  var p = projSlot(pk);
  return p ? '<span class="proj' + (pk.round === 1 && p.slot <= 5 ? " hot" : "") + '" title="Projected pick ' + p.overall + ' overall (reverse standings right now)">' + p.label + "</span>" : "";
}
function salCell(c, i) {
  var k = LM.moneyKind(c, i);
  if (!k) return "";
  var v = c.sal[i], s = String(c.st[i] || "");
  if (k === "fa" || k === "ufa" || k === "rfa") return '<span class="fa m-' + k + '">' + esc(v) + "</span>";
  var d = k === "hold" ? null : detOf(c, i);
  return '<span class="mny m-' + k + (d ? " has-ck d-" + d[0] : "") + '"' + (d ? ' title="' + esc(d[1]) + '"' : "") + ">" + money(v) +
    (s && s !== "HOLD" ? "<em>" + esc(s) + "</em>" : "") + "</span>";
}
// Which deal season i belongs to, from the contract details ("Rookie; Ext 27-28", "OKC Restructure").
// -> [class, hover text, tag] or null
function detOf(c, i) {
  var det = String(c.det || "");
  if (!det) return null;
  var ext = /\b(SMax |Max )?Ext\s+(\d\d-\d\d)/i.exec(det), from = -1;
  if (ext) S.L.seasons.forEach(function (x, j) { if (String(x).slice(2) === ext[2]) from = j; });
  if (ext && from >= 0 && i >= from) {
    var kind = ext[1] ? (/smax/i.test(ext[1]) ? "Supermax extension" : "Max extension") : "Extension";
    return ["ext", kind + " starting " + ext[2], "EXT"];
  }
  var rs = /\b([A-Z]{2,4})?\s*Restructure/.exec(det);
  if (rs) return ["rs", "Restructured" + (rs[1] ? " by " + teamName(rs[1]) : ""), "RS"];
  if (/\brookie\b/i.test(det)) return ["rk", "Rookie-scale deal", "RK"];
  return null;
}
function moneyLegend() {
  return '<div class="legend mlegend">' + LM.MONEY_KINDS.map(function (m) {
    return m[0] === "ufa" || m[0] === "rfa" ? '<span><span class="fa m-' + m[0] + '">' + m[1] + "</span></span>" : '<span><i class="m-' + m[0] + '"></i>' + m[1] + "</span>"; }).join("") + [["rk", "RK", "Rookie deal"], ["ext", "EXT", "Extension"], ["rs", "RS", "Restructured"]].map(function (x) {
      return '<span><i class="gk gk-' + x[0] + '"></i>' + x[2] + "</span>"; }).join("") + "</div>";
}
// ESPN headshot (small, from ESPN's image resizer) for a player name, or initials
function headshot(name) {
  var k = LM.norm(plain(name)), list = (DATA.espn || {})[k] || [];
  var e = list.filter(function (x) { return x.img; })[0];
  var m = e && /headshots\/nba\/players\/full\/(\d+)\.png/.exec(e.img);
  return m ? "https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/" + m[1] + ".png&w=96&h=70" : "";
}
function initials(name) { return plain(name).split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase(); }
function avatar(name) {
  var url = headshot(name);
  return url ? '<img class="av" loading="lazy" alt="" src="' + esc(url) + '" data-ini="' + esc(initials(name)) + '">'
    : '<span class="av">' + esc(initials(name)) + "</span>";
}
// player link with a photo in front
function pwho(name, label) { return '<span class="who">' + avatar(name) + pbtn(name, label) + "</span>"; }
function book(code) { return S.books[code] || (S.books[code] = LM.teamBook(S.L, code)); }
function setLeague(L) { S.projIdx = null; S.stRows = null; S.fpIdx = null; S.stIdx = null; S.heat = null; S.L = L; S.books = {}; S.rIdx = null; S.plRows = null; LM.resetIndex(L); }
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

var PAGES = { home: pageHome, contracts: pageContracts, stats: pageStats, standings: pageStandings, team: pageTeam, trade: pageTrade, log: pageLog, rules: pageRules, admin: pageAdmin };
var ALIAS = { players: "contracts" };   // old links

function route(h, keepScroll) {
  h = String(h || "").replace(/^#/, "");
  S.hash = h;
  var i = h.indexOf("/"), page = (i < 0 ? h : h.slice(0, i)) || "home", arg = i < 0 ? "" : h.slice(i + 1);
  page = ALIAS[page] || page;
  if (!PAGES[page]) page = "home";
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
function record(t) { return t.w + "-" + t.l + (t.t ? "-" + t.t : ""); }
function rankBadge(t) { return '<span class="rk' + (t.rank == null ? " none" : t.rank <= 3 ? " top" : "") + '">' + (t.rank == null ? "" : t.rank) + "</span>"; }
function tcode(code) { return code ? '<a class="tcode tc"' + teamStyle(code) + ' href="#team/' + esc(code) + '" data-go="team/' + esc(code) + '">' + esc(code) + "</a>" : '<span class="muted">—</span>'; }
function swatch(code) { return '<span class="swatch"' + teamStyle(code) + "></span>"; }
// Payroll bar scaled to the hard cap, with a tick at each level line
var LINES = [150, 200, 250];
function meter(p, lg) {
  var max = S.L.limits.hardCap, pct = Math.max(0, Math.min(100, p / max * 100));
  return '<div class="meter' + (lg ? " lg" : "") + " t-" + LM.tierOf(p).key + '" role="img" aria-label="' + esc(money(p) + "M of $" + max + "M") + '"><i style="width:' + pct.toFixed(1) + '%"></i>' +
    LINES.map(function (v) { return '<s style="left:' + (v / max * 100).toFixed(1) + '%"></s>'; }).join("") + "</div>";
}
function meterScale() {
  var max = S.L.limits.hardCap;
  return '<div class="scale"><span style="left:0;transform:none">$0</span>' + LINES.concat([max]).map(function (v) {
    return '<span style="left:' + (v / max * 100).toFixed(1) + '%">$' + v + "</span>"; }).join("") + "</div>";
}
function tierLegend() {
  var labels = [["cap", "Under cap ≤$150"], ["first", "1st apron ≤$200"], ["second", "2nd apron ≤$250"], ["tax", "Luxury tax ≤$300"]];
  return '<div class="legend">' + labels.map(function (l) { return '<span class="t-' + l[0] + '"><i></i>' + l[1] + "</span>"; }).join("") + "</div>";
}

/* ============================ home ============================ */
function pageHome() {
  var L = S.L, n = L.teams.length;
  var pays = L.teams.map(function (t) { return { t: t, p: book(t.code).payroll[0] }; });
  var avg = pays.reduce(function (s, x) { return s + x.p; }, 0) / (n || 1);
  var low = pays.slice().sort(function (a, b) { return a.p - b.p; })[0];
  var top = L.contracts.filter(function (c) { return !c.hold && typeof c.sal[0] === "number"; }).sort(function (a, b) { return b.sal[0] - a.sal[0]; });
  var pending = L.contracts.filter(function (c) { return /pending/i.test(c.det); }).length;
  var over2 = pays.filter(function (x) { return x.p > 200; }).length;

  var hero = '<section class="hero"><div class="hero-ball"></div><div class="eyebrow">' + esc(L.season) + " season</div><h1>Salary League</h1>" +
    '<div class="sub">' + n + " teams on Sleeper under a $150M cap, two aprons, a luxury tax line and a $" + L.limits.hardCap + "M hard max.</div>" +
    '<div class="actions"><a class="btn pri" href="#contracts" data-go="contracts">Browse contracts</a><a class="btn" href="#trade" data-go="trade">Trade machine</a>' +
    '<a class="btn" href="#standings" data-go="standings">Standings</a></div></section>';

  var kpis = '<div class="kpis">' +
    '<div class="kpi"><div class="v">' + money(avg) + '</div><div class="k">Average payroll</div></div>' +
    '<div class="kpi"><div class="v">' + over2 + " / " + n + '</div><div class="k">Teams over the 1st apron</div></div>' +
    '<div class="kpi"><div class="v">' + (low ? money(low.p) : "—") + '</div><div class="k">Lowest payroll · ' + (low ? teamLink(low.t.code) : "") + "</div></div>" +
    '<div class="kpi"><div class="v">' + pending + '</div><div class="k">Contracts pending</div></div></div>';

  var ranks = LM.standings(L.teams).slice(0, 10).map(function (t, i) {
    var p = book(t.code).payroll[0];
    return '<div class="list-row"><span class="rk' + (i < 3 ? " top" : "") + '">' + (i + 1) + "</span>" + swatch(t.code) + '<div class="nm">' + teamLink(t.code) + '<span class="muted small">' + esc(t.owner) + " · " + record(t) + "</span></div>" +
      '<div class="num">' + money(p) + "</div>" + tierChip(p) + "</div>";
  }).join("");
  var left = '<div class="box"><div class="panel-head"><h3>Standings</h3><a href="#standings" data-go="standings">Full standings →</a></div>' + ranks + "</div>";

  if (!S.log) api("getLog").then(function (d) { S.log = d; var el = $("homeLog"); if (el) el.innerHTML = homeLog(); }, function () {});
  var right = '<div class="box"><div class="panel-head"><h3>Latest moves</h3><a href="#log" data-go="log">All transactions →</a></div><div id="homeLog">' + (S.log ? homeLog() : loading()) + "</div></div>" +
    '<div class="box"><div class="panel-head"><h3>Biggest contracts · ' + esc(L.season) + '</h3><a href="#contracts" data-go="contracts">All contracts →</a></div>' +
    top.slice(0, 6).map(function (c) {
      var r = rosterIdx()[LM.norm(c.n)];
      return '<div class="list-row">' + avatar(c.n) + '<div class="nm">' + pbtn(c.n) + '<span class="muted small">' + esc(c.nba) + (r ? " · " + esc(teamName(r.code)) : " · free agent") + "</span></div>" +
        '<div class="num">' + salCell(c, 0) + "</div></div>";
    }).join("") + "</div>";

  return hero + kpis + '<div class="home-grid"><div>' + left + payrollChart(pays) + "</div><div>" + right + "</div></div>";
}
function homeLog() {
  var rows = S.log.rows.slice(0, 7);
  if (!rows.length) return '<div class="empty">No transactions yet.</div>';
  return rows.map(function (r) { return logEntry(r, true); }).join("");
}
function payrollChart(pays) {
  var max = S.L.limits.hardCap;
  var top = Math.max(max, Math.max.apply(null, pays.map(function (x) { return x.p; })));
  var pos = function (v) { return (Math.max(0, v) / top * 100).toFixed(1) + "%"; };
  var rows = pays.slice().sort(function (a, b) { return b.p - a.p; }).map(function (x) {
    var tier = LM.tierOf(x.p);
    return '<div class="lbl">' + tcode(x.t.code) + "</div>" +
      '<div class="bar t-' + tier.key + '" data-tip="' + esc(x.t.name + " · " + money(x.p) + "M · " + tier.label) + '"><i style="width:' + pos(x.p) + '"></i>' +
      LINES.concat([max]).map(function (v) { return '<s style="left:' + pos(v) + '"></s>'; }).join("") + "</div>" +
      '<div class="val">' + money(x.p) + "</div>";
  }).join("");
  var axis = '<div></div><div class="axis">' + [0].concat(LINES, [max]).map(function (v) { return '<span style="left:' + pos(v) + '">$' + v + "</span>"; }).join("") + "</div><div></div>";
  return '<div class="box"><div class="panel-head"><h3>Payroll by team · ' + esc(S.L.season) + '</h3><a href="#standings" data-go="standings">Table view →</a></div>' +
    '<div class="pchart">' + rows + axis + "</div>" + tierLegend() + "</div>";
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
// Future cap space: room under the $150M cap for every season on the books
var CAP_LINE = 150;
function futureCap(order) {
  var L = S.L, k = S.fsort;   // season index to sort by (null = standings order)
  var rows = order.map(function (t, i) { return { t: t, i: i, pay: book(t.code).payroll }; });
  if (k != null) rows.sort(function (a, b) { return (CAP_LINE - b.pay[k]) - (CAP_LINE - a.pay[k]) || a.i - b.i; });
  var body = rows.map(function (r) {
    var t = r.t;
    return '<tr><td><div class="tm"><span class="rk' + (r.i < 3 ? " top" : "") + '">' + (r.i + 1) + "</span>" + swatch(t.code) + "<div>" + teamLink(t.code) +
      '<div class="muted small">' + record(t) + "</div></div></div></td>" + r.pay.map(function (p, j) {
        var space = LM.r1(CAP_LINE - p), tier = LM.tierOf(p), on = j === k ? " hl2" : "";
        if (!(p > 0)) return '<td class="capcell' + on + '"><div class="fc open"><span>Open</span><em>$' + CAP_LINE + "M</em></div></td>";
        return '<td class="capcell' + on + '"><div class="fc t-' + tier.key + '" title="' + esc(tier.label) + " · " + money(p) + 'M committed"><div class="fc-h"><b>' + money(p) + "</b>" +
          '<span class="fc-sp ' + (space >= 0 ? "pos" : "neg") + '">' + (space >= 0 ? "+" : "−") + money(Math.abs(space)) + "</span></div>" + meter(p) + "</div></td>";
      }).join("") + "</tr>";
  }).join("");
  return '<div class="tbl"><table class="ftbl"><tr><th>Team</th>' + L.seasons.map(function (x, j) {
    return '<th class="sort' + (k === j ? " on" : "") + '" data-act="fSort" data-k="' + j + '" title="Sort by cap space in ' + esc(x) + '">' + esc(x) + "</th>"; }).join("") + "</tr>" + body + "</table></div>";
}
function pageStandings() {
  var L = S.L;
  var order = LM.standings(L.teams);
  var tabs = '<div class="seg">' + [["standings", "Standings"], ["future", "Future cap space"]].map(function (x) {
    return '<button data-act="sView" data-v="' + x[0] + '" class="' + ((S.sview || "standings") === x[0] ? "on" : "") + '">' + x[1] + "</button>"; }).join("") + "</div>";
  if (S.sview === "future") {
    return '<div class="pagehead"><div><div class="eyebrow">' + esc(L.season) + "</div><h1>Standings</h1></div>" + tabs + "</div>" +
      futureCap(order) + tierLegend();
  }
  var rows = order.map(function (t, i) {
    var b = book(t.code), p = b.payroll[0], odds = LM.lotteryOdds(i, order.length);
    var line = i === LM.PLAYOFF_TEAMS ? '<tr class="lotto-line"><td colspan="10"><span>Lottery line</span></td></tr>' : "";
    return line + '<tr' + (odds != null ? ' class="lotto"' : "") + '><td><div class="tm"><span class="rk' + (i < 3 ? " top" : "") + '">' + (i + 1) + "</span>" + swatch(t.code) + "<div>" + teamLink(t.code) +
      '<div class="muted small">' + esc(t.owner) + "</div></div></div></td>" +
      "<td><b>" + record(t) + "</b></td><td>" + f1(t.pf) + "</td>" +
      (odds != null ? '<td class="odds"><span style="--w:' + (odds / 25 * 100).toFixed(0) + '%">' + odds.toFixed(1) + "%</span></td>" : '<td class="dim">—</td>') + '<td class="l"><div class="paycell"><b>' + money(p) + "</b>" + meter(p) + "</div></td><td class=l>" + tierChip(p) +
      '</td><td class="' + (b.cash ? cls(b.cash) : "dim") + '">' + (b.cash ? signed(b.cash) : "—") +
      '</td><td class="' + (t.rank == null ? "dim" : "") + '">' + (t.rank == null ? "—" : "#" + t.rank) +
      '</td><td class="l">' + maxPips(b) + "</td></tr>";
  }).join("");
  return '<div class="pagehead"><div><div class="eyebrow">' + esc(L.season) + '</div><h1>Standings</h1><div class="sub">By record, then points for · records live from Sleeper · payroll includes cap holds and cash</div></div>' +
    tabs + "</div>" +
    '<div class="tbl"><table><tr><th>Team</th><th>W-L-T</th><th>PF</th><th title="Chance at the #1 pick (old NBA lottery odds)">#1 pick odds</th><th class=l>Payroll</th><th class=l>Level</th><th>Cash</th><th title="Commissioners power ranking">Power</th><th class=l title="Max and supermax deals (allowed: 3 max, 2 max + 1 supermax, or 2 supermax)">Max deals</th></tr>' +
    rows + "</table></div>" + tierLegend();
}

// Max deals used, against the allowed combos (3 max · 2 max + 1 supermax · 2 supermax)
function maxPips(b, big) {
  var m = b.maxes, s = b.smaxes, combos = S.L.limits.maxCombos || LM.MAX_COMBOS;
  var ok = LM.maxComboOk(m, s, combos), canM = LM.maxComboOk(m + 1, s, combos), canS = LM.maxComboOk(m, s + 1, combos);
  var pips = "";
  for (var i = 0; i < s; i++) pips += '<i class="pip smax" title="Supermax"></i>';
  for (i = 0; i < m; i++) pips += '<i class="pip max" title="Max"></i>';
  if (!big) return '<span class="pips' + (ok ? "" : " bad") + '" title="' + m + " max · " + s + " supermax · allowed: " + esc(LM.maxCombosText(combos)) + '">' + (pips || '<span class="dim">—</span>') + "</span>";
  var room = !ok ? "Over the limit" : canM && canS ? "Room for a max or smax" : canM ? "Room for 1 more max" : canS ? "Room for 1 more supermax" : "Full";
  return '<b class="pipcount">' + m + "<small> max</small> · " + s + "<small> smax</small></b>" +
    '<div class="pips lg' + (ok ? "" : " bad") + '">' + pips + (canM ? '<i class="pip open" title="Open"></i>' : "") + "</div>" +
    '<span class="pl-sub' + (ok ? "" : " err") + '" title="Allowed: ' + esc(LM.maxCombosText(combos)) + '">' + room + "</span>";
}

/* ============================ team page ============================ */
function pageTeams() {
  var cards = S.L.teams.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (t) {
    var p = book(t.code).payroll[0];
    return '<a class="tcard"' + teamStyle(t.code) + ' href="#team/' + esc(t.code) + '" data-go="team/' + esc(t.code) + '">' +
      '<div class="tcard-top"><span class="badge-team sm">' + esc(t.code) + '</span><div class="grow"><b>' + esc(t.name) + '</b><span>' + esc(t.owner) + "</span></div>" +
      '<span class="rec">' + record(t) + "</span></div>" +
      '<div class="tcard-body"><div class="row" style="margin-bottom:6px"><b>' + money(p) + "</b>" + tierChip(p) + "</div>" + meter(p) + "</div></a>";
  }).join("");
  return '<div class="pagehead"><div><div class="eyebrow">' + esc(S.L.season) + '</div><h1>Teams</h1><div class="sub">Pick a team for its roster, contracts, cap room and draft picks</div></div></div>' +
    '<div class="tgrid">' + cards + "</div>";
}
function pageTeam(code) {
  var L = S.L, cur0 = statSeasons()[0];
  if (!S.stats[cur0]) loadStats(cur0).then(function () { if (/^team\//.test(S.hash)) rerender(); }, function () {});
  var t = LM.teamByCode(L, code);
  if (!t) return pageTeams();
  var b = book(t.code), p = b.payroll[0], n = L.seasons.length;
  var lim = L.limits;
  var space = function (line) { var v = line - p; return '<b class="' + cls(v) + '">' + money(v) + "</b>"; };
  var head = '<div class="pagehead team-banner"' + teamStyle(t.code) + '><div class="tm"><div class="badge-team">' + esc(t.code) + "</div><div><h1>" + esc(t.name) + '</h1><div class="sub">' + esc(t.owner) + " · " + record(t) +
    " · " + f1(t.pf) + " PF" + (t.rank != null ? " · ranked #" + t.rank : "") + "</div></div></div>" +
    dropdown("pickTeam", t.code, teamItems(), "Team", "on-banner") + "</div>";
  // room under each line: the line, then what's past it (colored like that level)
  var lines = [[150, "1st apron", "first"], [200, "2nd apron", "second"], [250, "Luxury tax", "tax"], [lim.hardCap, "Hard cap", "over"]];
  var roomCells = lines.map(function (ln) {
    var v = LM.r1(ln[0] - p), over = v < 0;
    return '<div class="pay-line t-' + ln[2] + (over ? " over" : "") + '"><span class="pl-name">' + ln[1] + "<em>$" + ln[0] + "M</em></span>" +
      '<b>' + (over ? "−" : "") + money(Math.abs(v)) + "</b><span class=\"pl-sub\">" + (over ? "over the line" : "room") + "</span></div>";
  }).join("");
  var cashPct = Math.min(100, Math.abs(b.cash) / lim.cash * 100);
  var teamCells =
    '<div class="pay-cell"><span class="pl-name">Cash balance</span><b class="' + cls(b.cash) + '">' + signed(b.cash) + "</b>" +
      '<div class="cashbar"><i class="' + (b.cash < 0 ? "neg" : "pos") + '" style="width:' + (cashPct / 2).toFixed(1) + "%;" + (b.cash < 0 ? "right:50%" : "left:50%") + '"></i></div><span class="pl-sub">±$' + lim.cash + "M allowed</span></div>" +
    '<div class="pay-cell"><span class="pl-name">Max deals</span>' + maxPips(b, true) + "</div>" +
    '<div class="pay-cell"><span class="pl-name">Active roster</span><b>' + b.active + (lim.activeRoster ? '<small> / ' + lim.activeRoster + "</small>" : "") + "</b>" +
      (lim.activeRoster ? '<div class="rosterbar"><i style="width:' + Math.min(100, b.active / lim.activeRoster * 100).toFixed(0) + '%"></i></div><span class="pl-sub">' + (lim.activeRoster - b.active > 0 ? lim.activeRoster - b.active + " open" : "full") + "</span>" : "") + "</div>";
  var statsHtml = '<div class="box paybox"><div class="team-hero"><div><div class="pay-k">Payroll ' + esc(L.season) + "</div>" +
    '<div class="big">' + money(p) + "<small>M</small></div><div style=\"margin-top:8px\">" + tierChip(p) + "</div></div>" +
    "<div>" + meter(p, true) + meterScale() + "</div></div>" +
    '<div class="pay-grid"><div class="pay-group"><h4>Room under each line</h4><div class="pay-lines">' + roomCells + "</div></div>" +
    '<div class="pay-group"><h4>Team</h4><div class="pay-team">' + teamCells + "</div></div></div></div>";
  var warn = b.missing.length ? '<div class="box"><b class="err">No contract on the Master list:</b> ' +
    b.missing.map(function (x) { return pbtn(x); }).join(", ") + ' <span class="muted small">(counted as $0)</span></div>' : "";

  var seasonsTh = L.seasons.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("");
  var cols = n + 2;
  var body = "";
  ["starters", "bench", "ir", "taxi"].forEach(function (slot) {
    var ps = b.players.filter(function (x) { return x.slot === slot; });
    if (!ps.length) return;
    body += '<tr class="grp"><td colspan="' + cols + '">' + SLOT[slot] + " · " + ps.length + "</td></tr>";
    ps.forEach(function (x) {
      body += '<tr><td class="name">' + pwho(x.name) + extFlag(x.c, t.code) + (x.c ? "" : '<span class="flag bad">No contract</span>') +
        (x.c && /pending/i.test(x.c.det) ? '<span class="flag">Pending</span>' : "") + '</td><td class="l muted">' + esc(x.c ? x.c.nba : "") + "</td>" +
        L.seasons.map(function (_, i) { return "<td>" + salCell(x.c, i) + "</td>"; }).join("") + "</tr>";
    });
  });
  if (b.holds.length) {
    body += '<tr class="grp"><td colspan="' + cols + '">Cap holds · ' + b.holds.length + "</td></tr>";
    b.holds.forEach(function (h) {
      body += '<tr><td class="name">' + pwho(h.name) + (h.c ? "" : '<span class="flag bad">Not on Master list</span>') +
        '</td><td class="l muted">' + esc(h.c ? h.c.nba : "") + "</td>" +
        L.seasons.map(function (_, i) { return "<td>" + salCell(h.c, i) + "</td>"; }).join("") + "</tr>";
    });
  }
  body += '<tr class="grp"><td colspan="' + cols + '">Totals</td></tr>' +
    '<tr><td>Cash considerations</td><td></td>' + L.seasons.map(function (_, i) {
      return '<td class="' + (i === 0 ? cls(b.cash) : "") + '">' + (i === 0 ? signed(b.cash) : "") + "</td>"; }).join("") + "</tr>" +
    '<tr class="total"><td>Total payroll</td><td></td>' + b.payroll.map(function (v) {
      return '<td class="tot t-' + LM.tierOf(v).key + '">' + money(v) + "</td>"; }).join("") + "</tr>" +
    "<tr><td>Level</td><td></td>" + b.payroll.map(function (v) { return "<td>" + tierChip(v) + "</td>"; }).join("") + "</tr>" +
    "<tr><td>Room to $" + lim.hardCap + "M max</td><td></td>" + b.payroll.map(function (v) {
      return '<td class="' + cls(lim.hardCap - v) + '">' + money(lim.hardCap - v) + "</td>"; }).join("") + "</tr>";
  var table = '<div class="tbl"><table><tr><th>Player</th><th class=l>NBA</th>' + seasonsTh + "</tr>" + body + "</table></div>";

  var picks = (L.picks[t.code] || []);
  var bySeason = {};
  picks.forEach(function (pk) { (bySeason[pk.season] = bySeason[pk.season] || []).push(pk); });
  var picksHtml = Object.keys(bySeason).length ? Object.keys(bySeason).sort().map(function (s) {
    return '<div class="row start"><b style="width:44px">' + esc(s) + '</b><div class="picks">' + bySeason[s].map(function (pk) {
      return '<span class="chip pk' + (/\(own\)/.test(pk.label) ? " own" : "") + '">' + esc(pk.label.replace(/^\d{4} /, "")) + projTag(pk) + "</span>"; }).join("") + "</div></div>";
  }).join("") + '<p class="muted small" style="margin:8px 0 0">Projected slots use the current standings in reverse (worst record picks first).</p>' : '<div class="empty">No draft picks in the next drafts.</div>';

  return head + statsHtml + warn + moneyLegend() + '<div style="height:10px"></div>' + table + '<h2 class="sec">Draft picks</h2>' + box("", picksHtml);
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
var PL_FILTERS = [["all", "All"], ["rostered", "Rostered"], ["fa", "Free agents"], ["ext", "Extension eligible"], ["holds", "Cap holds"], ["pending", "Pending"]];
function plKind(r, f) {
  if (f === "rostered") return r.rostered;
  if (f === "fa") return !(r.rostered || r.hold || r.pending);
  if (f === "holds") return r.hold;
  if (f === "pending") return r.pending;
  if (f === "ext") return !!extEligible(r.c, r.team);
  return true;
}
// Contract-type filters (second row on the Contracts page)
var PL_KINDS = [["rk", "Rookie deal"], ["ext", "Extension"], ["rs", "Restructured"], ["max", "Max"], ["smax", "Supermax"], ["po", "Player option"], ["to", "Team option"], ["exp", "Expiring"]];
function plHasKind(r, k) {
  var c = r.c;
  if (!k) return true;
  if (!c || c.hold) return false;
  var n = S.L.seasons.length, i;
  if (k === "rk" || k === "ext" || k === "rs") { for (i = 0; i < n; i++) { var d = detOf(c, i); if (d && d[0] === k && typeof c.sal[i] === "number") return true; } return false; }
  if (k === "exp") return typeof c.sal[0] === "number" && typeof c.sal[1] !== "number";
  for (i = 0; i < n; i++) if (LM.moneyKind(c, i) === k) return true;
  return false;
}
// This season's Sleeper line for a player (fppg, gp, value), or null
function stOf(name) {
  var cur = statSeasons()[0];
  if (!S.stats[cur]) return null;
  if (!S.stIdx || S.stIdx.season !== cur) {
    var idx = {};
    statRows(cur).forEach(function (r) { idx[LM.norm(r.name)] = r; });
    S.stIdx = { season: cur, idx: idx };
  }
  return S.stIdx.idx[LM.norm(name)] || null;
}
// seasons left on the deal, counting from this season
function yearsLeft(c) {
  if (!c || c.hold) return 0;
  var n = 0;
  while (n < c.sal.length && typeof c.sal[n] === "number") n++;
  return n;
}
var PL_MORE = ["smin", "smax", "yl", "fmin", "gmin"];
function plMoreCount() {
  var x = S.pl;
  return PL_MORE.filter(function (k) { return x[k] !== ""; }).length + (x.ks.length ? 1 : 0);
}
// the "More filters" panel: salary range, years left, production, contract-type stacking
function plMorePass(r) {
  var x = S.pl, num = function (v) { return Number(v); };
  if (x.ks.length) {
    var hit = x.ks.filter(function (k) { return plHasKind(r, k); }).length;
    if (x.kmode === "all" ? hit < x.ks.length : !hit) return false;
  }
  if (x.yl !== "") { var y = yearsLeft(r.c); if (x.yl === "4" ? y < 4 : y !== num(x.yl)) return false; }
  if (x.smin !== "" || x.smax !== "") {
    var v = r.c && !r.c.hold ? r.c.sal[x.ss] : null;
    if (typeof v !== "number") return false;
    if (x.smin !== "" && v < num(x.smin)) return false;
    if (x.smax !== "" && v > num(x.smax)) return false;
  }
  if (x.fmin !== "" || x.gmin !== "") {
    var st = stOf(r.n);
    if (!st) return false;
    if (x.fmin !== "" && !(st.fppg >= num(x.fmin))) return false;
    if (x.gmin !== "" && !(st.gp >= num(x.gmin))) return false;
  }
  return true;
}
function plFiltered() {
  var q = S.pl.q.trim().toLowerCase(), qn = LM.norm(q), f = S.pl.f, team = S.pl.team;
  var rows = playerRows().filter(function (r) {
    if (!plKind(r, f)) return false;
    if (!plMorePass(r)) return false;
    if (team && r.team !== team) return false;
    return !q || r.key.indexOf(q) >= 0 || (qn && r.key.indexOf(qn) >= 0) || (r.team && r.team.toLowerCase() === q);
  });
  var k = S.pl.sort, asc = S.pl.asc;
  if (k) {
    var val = function (r) {
      if (k === "n") return r.n.toLowerCase();
      if (k === "nba") return r.c ? r.c.nba : "";
      if (k === "team") return r.team || "";
      if (k === "fp") { var st = stOf(r.n); return st ? st.fppg : null; }
      if (k === "yl") return r.c && !r.c.hold ? yearsLeft(r.c) : null;
      var v = r.c ? r.c.sal[Number(k.slice(1))] : null;
      return typeof v === "number" ? v : null;
    };
    rows = rows.map(function (r, i) { return { r: r, v: val(r), i: i }; }).sort(function (a, b) {
      if (a.v === b.v) return a.i - b.i;
      if (a.v === null || a.v === "") return 1;      // blanks always last
      if (b.v === null || b.v === "") return -1;
      var d = a.v < b.v ? -1 : 1;
      return asc ? d : -d;
    }).map(function (x) { return x.r; });
  }
  return rows;
}
function sortTh(k, label, l) {
  var on = S.pl.sort === k;
  return '<th class="sort' + (l ? " l" : "") + (on ? " on" + (S.pl.asc ? " asc" : "") : "") + '" data-act="plSort" data-k="' + k + '" title="Sort">' + label + "</th>";
}
function plProdCells(r) {
  var st = stOf(r.n), y = r.c && !r.c.hold ? yearsLeft(r.c) : 0;
  return '<td class="pnum fp">' + (st ? st.fppg.toFixed(1) : '<span class="dim">·</span>') + "</td>" +
    '<td class="pnum">' + (y ? y : '<span class="dim">·</span>') + "</td>";
}
function plTable() {
  var rows = plFiltered(), L = S.L;
  var shown = rows.slice(0, S.pl.limit);
  var body = shown.map(function (r) {
    return '<tr><td class="name">' + pwho(r.n, r.hold ? plain(r.n) : "") + (r.missing ? '<span class="flag bad">No contract</span>' : "") + (r.pending ? '<span class="flag">Pending</span>' : "") +
      (r.hold ? '<span class="flag bad">Cap hold</span>' : "") + extFlag(r.c, r.team) +
      '</td><td class="l muted">' + esc(r.c ? r.c.nba : "") + '</td><td class="l">' + tcode(r.team) + "</td>" + plProdCells(r) +
      L.seasons.map(function (_, i) { var s = salCell(r.c, i); return "<td" + (s ? "" : ' class="dim"') + ">" + (s || "·") + "</td>"; }).join("") + "</tr>";
  }).join("");
  return '<div class="tbl"><table><tr>' + sortTh("n", "Player") + sortTh("nba", "NBA", 1) + sortTh("team", "Team", 1) + sortTh("fp", "FPPG") + sortTh("yl", "Yrs") +
    L.seasons.map(function (s, i) { return sortTh("s" + i, esc(s)); }).join("") + "</tr>" +
    (body || '<tr><td colspan="' + (L.seasons.length + 5) + '" class="empty">Nobody matches.</td></tr>') + "</table></div>" +
    '<div class="muted small" style="margin:8px 2px 0">Showing ' + shown.length + " of " + rows.length + "</div>" +
    (rows.length > shown.length ? '<button class="more" data-act="plMore">Show ' + Math.min(150, rows.length - shown.length) + " more</button>" : "");
}
// ---- Filter menu (one button -> popover with every filter) ----
function plActive() {
  var x = S.pl, L = S.L, out = [];
  if (x.f !== "all") out.push(["f", PL_FILTERS.filter(function (f) { return f[0] === x.f; })[0][1], ""]);
  x.ks.forEach(function (k) { out.push(["k:" + k, PL_KINDS.filter(function (y) { return y[0] === k; })[0][1], "kf-" + k]); });
  if (x.smin !== "" || x.smax !== "") out.push(["sal", L.seasons[x.ss] + " " + (x.smin !== "" ? "$" + x.smin + "M" : "any") + " – " + (x.smax !== "" ? "$" + x.smax + "M" : "any"), ""]);
  if (x.yl !== "") out.push(["yl", (x.yl === "4" ? "4+" : x.yl) + (x.yl === "1" ? " year left" : " years left"), ""]);
  if (x.fmin !== "") out.push(["fmin", "FPPG ≥ " + x.fmin, ""]);
  if (x.gmin !== "") out.push(["gmin", "Games ≥ " + x.gmin, ""]);
  return out;
}
function plChips() {
  var a = plActive();
  if (!a.length) return "";
  return a.map(function (c) {
    return '<button class="fchip ' + c[2] + '" data-act="plClear" data-k="' + esc(c[0]) + '" title="Remove filter">' + (c[2] ? "<i></i>" : "") + esc(c[1]) +
      '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
  }).join("") + (a.length > 1 ? '<button class="fchip clear" data-act="plReset">Clear all</button>' : "");
}
function plFilterMenu(all) {
  var x = S.pl, L = S.L;
  var inp = function (k, ph, step) { return '<input type="number" inputmode="decimal" min="0" step="' + (step || "any") + '" data-pf="' + k + '" value="' + esc(x[k]) + '" placeholder="' + ph + '">'; };
  var seasonItems = L.seasons.map(function (sn, i) { return { v: String(i), html: '<span class="dd-name">' + esc(sn) + "</span>" }; });
  var sec = function (title, body, extra) { return '<section class="fm-sec"><header><h4>' + title + "</h4>" + (extra || "") + "</header>" + body + "</section>"; };
  var status = '<div class="fm-opts">' + PL_FILTERS.map(function (f) {
    var n = all.filter(function (r) { return plKind(r, f[0]); }).length;
    return '<button data-act="plFilter" data-v="' + f[0] + '" class="fm-opt' + (x.f === f[0] ? " on" : "") + '">' + f[1] + '<span class="n">' + n + "</span></button>"; }).join("") + "</div>";
  var kinds = '<div class="fm-kinds">' + PL_KINDS.map(function (k) {
    var n = all.filter(function (r) { return plKind(r, x.f) && plHasKind(r, k[0]); }).length;
    return '<button data-act="plKind" data-v="' + k[0] + '" class="kf kf-' + k[0] + (x.ks.indexOf(k[0]) >= 0 ? " on" : "") + '"><i></i>' + k[1] + '<span class="n">' + n + "</span></button>"; }).join("") + "</div>";
  var mode = '<div class="kmode">' + [["any", "Any"], ["all", "All"]].map(function (m) {
    return '<button data-act="plKmode" data-v="' + m[0] + '" class="' + (x.kmode === m[0] ? "on" : "") + '"' + (x.ks.length > 1 ? "" : " disabled") + ">Match " + m[1].toLowerCase() + "</button>"; }).join("") + "</div>";
  return '<div class="fmenu" role="dialog" aria-label="Filters">' +
    '<div class="fm-head"><b>Filters</b><button class="fm-x" data-act="plMoreToggle" aria-label="Close"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>' +
    '<div class="fm-body">' +
    sec("Players", status) +
    sec("Contract type", kinds, mode) +
    '<div class="fm-2">' +
      sec("Salary", '<div class="fm-row">' + dropdown("plSalS", String(x.ss), seasonItems, "Salary season") +
        '<div class="rng"><label><span>$</span>' + inp("smin", "Min") + '</label><em>–</em><label><span>$</span>' + inp("smax", "Max") + "</label><b>M</b></div></div>") +
      sec("Years left", '<div class="fm-seg">' + [["", "Any"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4+"]].map(function (y) {
        return '<button data-act="plYl" data-v="' + y[0] + '" class="' + (x.yl === y[0] ? "on" : "") + '">' + y[1] + "</button>"; }).join("") + "</div>") +
    "</div>" +
    sec("Production · " + esc(seasonLabel(statSeasons()[0])), '<div class="fm-prod">' +
      '<label><span>FPPG at least</span>' + inp("fmin", "0", "0.5") + "</label>" +
      '<label><span>Games at least</span>' + inp("gmin", "0", "1") + "</label></div>") +
    "</div>" +
    '<div class="fm-foot"><button class="fm-reset" data-act="plReset">Reset</button><button class="fm-go" data-act="plMoreToggle">Show <span id="fmCount">' + plFiltered().length + "</span> players</button></div>" +
    "</div>";
}
function plFilterCount() { return plActive().length; }
// after typing in a number box: refresh the table, counts and chips without rebuilding the menu
function plRefresh() {
  $("plTable").innerHTML = plTable();
  var c = $("fmCount"); if (c) c.textContent = plFiltered().length;
  var ch = $("plChips"); if (ch) ch.innerHTML = plChips();
  var btn = view().querySelector(".morebtn");
  if (btn) { var old = btn.querySelector(".n"); if (old) old.remove(); var n = plFilterCount(); if (n) btn.insertAdjacentHTML("beforeend", '<span class="n">' + n + "</span>"); }
}
function pageContracts() {
  var cur = statSeasons()[0];
  if (!S.stats[cur]) loadStats(cur).then(function () { if (/^contracts/.test(S.hash)) rerender(); }, function () {});
  var all = playerRows(), n = plFilterCount();
  return '<div class="pagehead"><div><div class="eyebrow">' + esc(S.L.season) + '</div><h1>Contracts</h1><div class="sub">Every contract on the Master list, plus anyone rostered without one</div></div>' +
    "</div>" +
    '<div class="toolbar ftool"><div class="search"><input type="search" id="plq" placeholder="Search players or NBA teams" value="' + esc(S.pl.q) + '" autocomplete="off" aria-label="Search"></div>' +
    dropdown("plTeam", S.pl.team, teamItems("All league teams"), "League team") +
    '<div class="fwrap"><button class="morebtn' + (S.pl.more ? " on" : "") + '" data-act="plMoreToggle" aria-expanded="' + !!S.pl.more + '"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Filters' +
      (n ? '<span class="n">' + n + "</span>" : "") + "</button>" + (S.pl.more ? plFilterMenu(all) : "") + "</div></div>" +
    '<div class="fchips" id="plChips">' + plChips() + "</div>" +
    moneyLegend() + '<div id="plTable" style="margin-top:12px">' + plTable() + "</div>";
}

/* ============================ stats ============================ */
// Season totals for every NBA player from Sleeper (one request per season), scored with the
// league's own settings, so fantasy points match Sleeper's (threes, bonuses, technicals and all).
function statSeasons() {
  var y = Number(LIVE.league && LIVE.league.season) || new Date().getFullYear();
  return [y, y - 1, y - 2].map(String);
}
function loadStats(season) {
  if (S.stats[season]) return Promise.resolve(S.stats[season]);
  return getJson(SLEEPER + "/stats/nba/regular/" + season, "Sleeper stats").then(function (d) { S.stats[season] = d || {}; return S.stats[season]; });
}
function statRows(season) {
  if (S.stRows && S.stRows.season === season) return S.stRows.rows;
  var data = S.stats[season] || {}, sc = (LIVE.league && LIVE.league.scoring_settings) || {}, idx = rosterIdx();
  var keys = Object.keys(sc).filter(function (k) { return Number(sc[k]); });
  var cur = statSeasons()[0] === season;
  var rows = Object.keys(data).map(function (pid) {
    var x = data[pid], p = DATA.players[pid];
    if (!p || !x || !(x.gp > 0)) return null;
    var name = p[0], k = LM.norm(name), r = idx[k], c = contractByName(name);
    var fp = keys.reduce(function (t, key) { return t + Number(sc[key]) * (Number(x[key]) || 0); }, 0);
    var gp = x.gp, sal = c && typeof c.sal[0] === "number" ? c.sal[0] : null;
    return { pid: pid, name: name, nba: p[1] || "", age: ageOf(name, p[1]), team: r ? r.code : "", c: c, gp: gp, min: x.min || 0, fp: fp, fppg: fp / gp,
      pts: x.pts || 0, reb: x.reb || 0, ast: x.ast || 0, stl: x.stl || 0, blk: x.blk || 0, tpm: x.tpm || 0, to: x.to || 0,
      fgp: x.fga ? (x.fgm || 0) / x.fga : null, ftp: x.fta ? (x.ftm || 0) / x.fta : null, tpp: x.tpa ? (x.tpm || 0) / x.tpa : null,
      sal: sal, value: cur && sal ? fp / gp / sal : null, raw: x };
  }).filter(Boolean);
  S.stRows = { season: season, rows: rows };
  return rows;
}
// This season's FPPG by player (league scoring), once the current season's stats are loaded
function fppgOf(name) {
  var cur = statSeasons()[0];
  if (!S.stats[cur]) return null;
  if (!S.fpIdx || S.fpIdx.season !== cur) {
    var idx = {};
    statRows(cur).forEach(function (r) { idx[LM.norm(r.name)] = r.fppg; });
    S.fpIdx = { season: cur, idx: idx };
  }
  var v = S.fpIdx.idx[LM.norm(name)];
  return v == null ? null : v;
}
// Extension eligible (league rules): in the last year of his deal (eligibility runs from the offseason
// before his free-agency year until the playoffs), and a rookie or max eligible (22.5+ FPPG).
// Teams at the 2nd apron or in the tax can't extend, so those come back with blocked: true.
var MAX_FPPG = 22.5;
function extEligible(c, team) {
  if (!c || c.hold || typeof c.sal[0] !== "number" || typeof c.sal[1] === "number") return null;
  var rookie = /rookie/i.test(c.det || ""), fp = fppgOf(c.n), max = fp != null && fp > MAX_FPPG;
  if (!rookie && !max) return null;
  var tier = team ? LM.tierOf(book(team).payroll[0]).key : "";
  return { why: max ? "Max eligible (" + fp.toFixed(1) + " FPPG)" : "Rookie", blocked: tier === "second" || tier === "tax" || tier === "over", tier: tier };
}
function extFlag(c, team) {
  var e = extEligible(c, team);
  if (!e) return "";
  return e.blocked ? '<span class="flag ext off" title="' + esc(e.why) + " · his team is at the 2nd apron or above, so it can't extend\">Ext eligible · team can't</span>"
    : '<span class="flag ext" title="' + esc(e.why) + '">Ext eligible</span>';
}
function statQualifier(rows) { var mx = rows.reduce(function (m, r) { return Math.max(m, r.gp); }, 0); return Math.max(1, Math.round(mx * 0.25)); }
var ST_FILTERS = [["all", "All players"], ["rostered", "Rostered"], ["fa", "Free agents"]];
// Age today from the ESPN bio (dob), or null
function ageOf(name, nba) {
  var list = (DATA.espn || {})[LM.norm(plain(name))] || [];
  var e = list.filter(function (x) { return x.dob && (!nba || x.team === nba); })[0] || list.filter(function (x) { return x.dob; })[0];
  if (!e) return null;
  var d = new Date(e.dob), now = new Date();
  if (isNaN(d)) return null;
  var a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}
// Green-to-red heat for the Stats table: each column scored by percentile among qualified players
var HEAT_KEYS = ["gp", "min", "fppg", "fp", "pts", "reb", "ast", "stl", "blk", "tpm", "to", "fgp", "tpp", "ftp"];
var HEAT_LOW_GOOD = { to: true };
var HEAT_PCT = { fgp: true, tpp: true, ftp: true };
// Efficiency uses fixed basketball benchmarks: [red at, full green at]
var HEAT_FIXED = { fgp: [0.40, 0.65], tpp: [0.28, 0.45], ftp: [0.65, 0.90], ts: [0.50, 0.66], efg: [0.45, 0.60] };
function fixedAttr(k, v) {
  var f = HEAT_FIXED[k];
  return v == null ? "" : hmAttr((v - f[0]) / (f[1] - f[0]));
}   // shooting %: small samples make freak highs, so cap at the 98th percentile
function heatScales(season, per) {
  var key = season + "|" + per;
  if (S.heat && S.heat.key === key) return S.heat.sc;
  var all = statRows(season), min = statQualifier(all), q = all.filter(function (r) { return r.gp >= min; }), sc = {};
  HEAT_KEYS.forEach(function (k) {
    sc[k] = q.map(function (r) { return heatVal(r, k, per); }).filter(function (v) { return v != null && isFinite(v); }).sort(function (a, b) { return a - b; });
  });
  S.heat = { key: key, sc: sc };
  return sc;
}
function heatVal(r, k, per) {
  var x = r[k];
  if (x == null) return null;
  if (per && ["min", "fp", "pts", "reb", "ast", "stl", "blk", "tpm", "to"].indexOf(k) >= 0) x = x / r.gp;
  return x;
}
// 0 (worst) .. 1 (best) -> hue from red (4) to green (140)
function heatHue(t) { t = Math.max(0, Math.min(1, t)); return Math.round(2 + 130 * t); }
// cell attrs: hue plus strength (--k: 0 in the middle, 1 at either end) so the ends get deeper
function hmAttr(t) { t = Math.max(0, Math.min(1, t)); return ' class="hm" style="--h:' + heatHue(t) + ";--k:" + (Math.abs(t - 0.5) * 2).toFixed(2) + '"'; }
// Scaled by the value itself (not rank), so the very top stands out: 737 FP is far greener than 500.
// Range runs from the 10th percentile (red) to the league leader (green); shooting % tops out at the
// 98th percentile; turnovers are reversed.
function heatAttr(sorted, v, lowGood, pct) {
  if (v == null || !sorted || !sorted.length) return "";
  var n = sorted.length, lo, hi, t;
  var at = function (q) { return sorted[Math.max(0, Math.min(n - 1, Math.round(q * (n - 1))))]; };
  if (lowGood) { lo = at(0); hi = at(0.9); t = hi > lo ? (hi - v) / (hi - lo) : 0.5; }
  else { lo = at(0.1); hi = at(pct ? 0.98 : 1); t = hi > lo ? (v - lo) / (hi - lo) : 0.5; }
  // ease the drop: good-not-great numbers stay on the green/yellow side instead of falling off fast
  return hmAttr(Math.pow(Math.max(0, Math.min(1, t)), 0.65));
}
// Hue (0 red .. 132 green) for one per-game stat against the league that season, or null
function heatHueFor(season, k, v) {
  if (v == null) return null;
  if (HEAT_FIXED[k]) return Number(/--h:(\d+)/.exec(fixedAttr(k, v))[1]);
  if (!S.stats[season]) return null;
  var m = /--h:(\d+)/.exec(heatAttr(heatScales(season, true)[k], v, HEAT_LOW_GOOD[k], HEAT_PCT[k]));
  return m ? Number(m[1]) : null;
}
// age: 20 or younger is green, 35 or older is red
function ageAttr(a) { return a == null ? "" : hmAttr(1 - (a - 20) / 15); }
function statFiltered() {
  var o = S.st, rows = statRows(o.season), q = o.q.trim(), qn = LM.norm(q), min = o.qual ? statQualifier(rows) : 1;
  rows = rows.filter(function (r) {
    if (o.f === "rostered" && !r.team) return false;
    if (o.f === "fa" && r.team) return false;
    if (o.team && r.team !== o.team) return false;
    if (q) return LM.norm(r.name).indexOf(qn) >= 0 || r.nba === q.toUpperCase();
    return r.gp >= min;
  });
  var k = o.sort, per = o.per === "game", dir = o.asc ? 1 : -1;
  var v = function (r) {
    if (k === "name") return r.name.toLowerCase();
    if (k === "team") return r.team || "~";
    var x = r[k];
    if (per && ["min", "fp", "pts", "reb", "ast", "stl", "blk", "tpm", "to"].indexOf(k) >= 0) x = x / r.gp;
    return x == null ? null : x;
  };
  return rows.map(function (r) { return { r: r, v: v(r) }; }).sort(function (a, b) {
    if (a.v === b.v) return b.r.fppg - a.r.fppg;
    if (a.v === null) return 1; if (b.v === null) return -1;
    return (a.v < b.v ? -1 : 1) * dir;
  }).map(function (x) { return x.r; });
}
function stTh(k, label, l, title) {
  var on = S.st.sort === k;
  return '<th class="sort' + (l ? " l" : "") + (on ? " on" + (S.st.asc ? " asc" : "") : "") + '" data-act="stSort" data-k="' + k + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + label + "</th>";
}
function statTable() {
  var rows = statFiltered(), o = S.st, per = o.per === "game", shown = rows.slice(0, o.limit);
  var n = function (r, k, d) { var x = per ? r[k] / r.gp : r[k]; return per || d ? x.toFixed(d == null ? 1 : d) : String(Math.round(x)); };
  var pc = function (x) { return x == null ? '<span class="dim">—</span>' : (x * 100).toFixed(1); };
  var sc = heatScales(o.season, per);
  var h = function (r, k) { return (HEAT_FIXED[k] ? fixedAttr(k, heatVal(r, k, per)) : heatAttr(sc[k], heatVal(r, k, per), HEAT_LOW_GOOD[k], HEAT_PCT[k])); };
  var td = function (r, k, html) { return "<td" + h(r, k) + ">" + html + "</td>"; };
  var body = shown.map(function (r, i) {
    return "<tr><td class=\"name\"><span class=\"rnk\">" + (i + 1) + "</span>" + pwho(r.name) + '</td><td class="l">' + tcode(r.team) + '</td><td class="l muted">' + esc(r.nba) + "</td>" +
      "<td" + ageAttr(r.age) + ">" + (r.age == null ? '<span class="dim">—</span>' : r.age) + "</td>" +
      td(r, "gp", r.gp) + td(r, "min", n(r, "min")) + td(r, "fppg", "<b>" + r.fppg.toFixed(1) + "</b>") + td(r, "fp", per ? Math.round(r.fp) : r.fp.toFixed(1)) +
      td(r, "pts", n(r, "pts")) + td(r, "reb", n(r, "reb")) + td(r, "ast", n(r, "ast")) + td(r, "stl", n(r, "stl")) + td(r, "blk", n(r, "blk")) +
      td(r, "tpm", n(r, "tpm")) + td(r, "to", n(r, "to")) + td(r, "fgp", pc(r.fgp)) + td(r, "tpp", pc(r.tpp)) + td(r, "ftp", pc(r.ftp)) +
      "<td>" + (r.c ? salCell(r.c, 0) || '<span class="dim">—</span>' : '<span class="dim">—</span>') + "</td>" + "</tr>";
  }).join("");
  return '<div class="tbl"><table class="stbl"><tr>' + stTh("name", "Player") + stTh("team", "Team", 1) + '<th class="l">NBA</th>' + stTh("age", "Age") + stTh("gp", "GP") + stTh("min", "MIN") +
    stTh("fppg", "FPPG", 0, "Fantasy points per game, league scoring") + stTh("fp", "FP", 0, "Total fantasy points") + stTh("pts", "PTS") + stTh("reb", "REB") + stTh("ast", "AST") +
    stTh("stl", "STL") + stTh("blk", "BLK") + stTh("tpm", "3PM") + stTh("to", "TO") + stTh("fgp", "FG%") + stTh("tpp", "3P%") + stTh("ftp", "FT%") +
    stTh("sal", esc(S.L.season)) + "</tr>" +
    (body || '<tr><td colspan="19" class="empty">Nobody matches.</td></tr>') + "</table></div>" +
    '<div class="muted small" style="margin:8px 2px 0">Showing ' + shown.length + " of " + rows.length + "</div>" +
    (rows.length > shown.length ? '<button class="more" data-act="stMore">Show ' + Math.min(100, rows.length - shown.length) + " more</button>" : "");
}
function leaderBoard(title, rows, val, fmt) {
  return '<div class="box leaders"><div class="panel-head"><h3>' + esc(title) + "</h3></div>" + rows.slice(0, 5).map(function (r, i) {
    return '<div class="list-row"><span class="rk' + (i === 0 ? " top" : "") + '">' + (i + 1) + "</span>" + avatar(r.name) + '<div class="nm">' + pbtn(r.name) +
      '<span class="muted small">' + esc(r.nba) + (r.team ? " · " + esc(teamName(r.team)) : " · free agent") + '</span></div><div class="num">' + fmt(val(r)) + "</div></div>";
  }).join("") + "</div>";
}
function statTabs() {
  return '<div class="seg">' + [["stats", "Stats"], ["advanced", "Advanced analytics"]].map(function (x) {
    return '<button data-act="stView" data-v="' + x[0] + '" class="' + ((S.st.view || "stats") === x[0] ? "on" : "") + '">' + x[1] + "</button>"; }).join("") + "</div>";
}
function pageStats() {
  var o = S.st, seasons = statSeasons();
  if (o.view === "advanced") {
    return '<div class="pagehead"><div><div class="eyebrow">' + esc(seasonLabel(o.season || seasons[0])) + "</div><h1>Advanced analytics</h1></div>" + statTabs() + "</div>" +
      '<div class="box soon"><svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "<h2>Coming soon</h2></div>";
  }
  if (!o.season) o.season = seasons[0];
  if (!S.stats[o.season]) {
    loadStats(o.season).then(function () { if (/^stats/.test(S.hash)) rerender(); }, function (e) { view().innerHTML = box("", '<div class="err">' + esc(e.message) + "</div>"); });
    return '<div class="pagehead"><div><div class="eyebrow">' + esc(seasonLabel(o.season)) + "</div><h1>Stats</h1></div></div>" + loading("Loading stats from Sleeper");
  }
  var all = statRows(o.season), min = statQualifier(all), q = all.filter(function (r) { return r.gp >= min; });
  var byFp = q.slice().sort(function (a, b) { return b.fppg - a.fppg; });
  var byPts = q.slice().sort(function (a, b) { return b.pts / b.gp - a.pts / a.gp; });
  var fas = byFp.filter(function (r) { return !r.team; });
  var big = function (v) { return '<b class="fpv">' + v.toFixed(1) + "</b>"; };
  var boards = '<div class="leaders-grid">' +
    leaderBoard("Best free agents · FPPG", fas, function (r) { return r.fppg; }, big) +
    leaderBoard("Fantasy points per game", byFp, function (r) { return r.fppg; }, big) +
    leaderBoard("Points per game", byPts, function (r) { return r.pts / r.gp; }, big) + "</div>";
  return '<div class="pagehead"><div><div class="eyebrow">' + esc(seasonLabel(o.season)) + '</div><h1>Stats</h1></div>' +
    '<div class="row" style="gap:10px">' + statTabs() +
    dropdown("stSeason", o.season, seasons.map(function (x) { return { v: x, html: '<span class="dd-name">' + esc(seasonLabel(x)) + " season</span>" }; }), "Season") + "</div></div>" +
    boards +
    '<div class="toolbar"><div class="search"><input type="search" id="stq" placeholder="Search players or NBA teams" value="' + esc(o.q) + '" autocomplete="off" aria-label="Search"></div>' +
    dropdown("stTeam", o.team, teamItems("All league teams"), "League team") + "</div>" +
    '<div class="row start" style="gap:10px">' +
    '<div class="seg">' + ST_FILTERS.map(function (f) { return '<button data-act="stFilter" data-v="' + f[0] + '" class="' + (o.f === f[0] ? "on" : "") + '">' + f[1] + "</button>"; }).join("") + "</div>" +
    '<div class="seg">' + [["game", "Per game"], ["total", "Totals"]].map(function (f) { return '<button data-act="stPer" data-v="' + f[0] + '" class="' + (o.per === f[0] ? "on" : "") + '">' + f[1] + "</button>"; }).join("") + "</div>" +
    '<div class="seg"><button data-act="stQual" class="' + (o.qual ? "on" : "") + '">' + min + "+ games</button></div></div>" +
    '<div id="stTable" style="margin-top:12px">' + statTable() + "</div>";
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
// One tradeable thing (player or pick) as a tappable card. Tap to send it; with 3+ teams,
// the "To" chips under it pick the receiver. Tap again to keep it.
function assetCard(type, key, from, pic, main, side) {
  var m = moveOf(type, key, from);
  var others = S.trade.teams.filter(function (c) { return c !== from; });
  var attrs = ' data-type="' + type + '" data-key="' + esc(key) + '" data-from="' + esc(from) + '"';
  var dest = m && others.length > 1 ? '<div class="dests"><span>To</span>' + others.map(function (c) {
    return '<button class="dest tc' + (m.to === c ? " on" : "") + '"' + teamStyle(c) + ' data-act="tradeDest" data-to="' + esc(c) + '"' + attrs + ">" + esc(c) + "</button>"; }).join("") + "</div>" : "";
  return '<div class="asset' + (m ? " moving" : "") + '"' + (m ? teamStyle(m.to) : "") + '>' +
    '<button class="asset-main" data-act="tradeAsset"' + attrs + ' aria-pressed="' + !!m + '">' + (pic ? '<span class="pic">' + pic + (m ? '<b class="chk">✓</b>' : "") + "</span>" : '<span class="tick">' + (m ? "✓" : "+") + "</span>") +
    '<span class="nm">' + main + "</span>" + (side ? '<span class="sal">' + side + "</span>" : "") +
    (m && others.length < 2 ? '<span class="to">→ ' + esc(m.to) + "</span>" : "") + "</button>" +
    (type === "player" ? '<button class="info plink" data-player="' + esc(key) + '" title="Player card" aria-label="Player card"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v3.9M8 4.9v.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>' : "") + "</div>" + dest;
}
function tradeTeamBox(code) {
  var b = book(code), L = S.L;
  var players = b.players.slice().sort(function (x, y) { return (y.sal[0] || 0) - (x.sal[0] || 0); });
  var pl = players.map(function (x) {
    return assetCard("player", x.name, code, avatar(x.name), esc(x.name) + "<small>" + esc(x.c ? x.c.nba : "") + " · " + esc(SLOT[x.slot] || "") + "</small>",
      x.c ? salCell(x.c, 0) : '<span class="flag bad">No contract</span>');
  }).join("");
  var pk = (L.picks[code] || []).map(function (p) { return assetCard("pick", p.label, code, "", esc(p.label), projTag(p)); }).join("");
  var cash = S.trade.moves.filter(function (m) { return m.type === "cash" && m.from === code; }).map(function (m) {
    return '<div class="asset moving"' + teamStyle(m.to) + '><div class="asset-main"><span class="tick">$</span><span class="nm">' + money(m.amt) + "M cash</span>" +
      '<span class="to">→ ' + esc(m.to) + '</span></div><button class="info" data-act="rmCash" data-from="' + esc(code) + '" data-to="' + esc(m.to) + '" data-amt="' + m.amt + '" title="Remove" aria-label="Remove cash">×</button></div>';
  }).join("");
  var others = S.trade.teams.filter(function (c) { return c !== code; });
  var sending = S.trade.moves.filter(function (m) { return m.from === code; }).length;
  return '<div class="box tbox"' + teamStyle(code) + '><div class="tbox-head"><span class="badge-team sm">' + esc(code) + '</span><div class="grow"><b>' + esc(b.team.name) + "</b>" +
    '<span class="muted small">' + money(b.payroll[0]) + "M " + tierChip(b.payroll[0]) + (sending ? " sending " + sending : "") + "</span></div>" +
    '<button class="x sm" data-act="tradeRemove" data-code="' + esc(code) + '" title="Remove team" aria-label="Remove ' + esc(b.team.name) + '">×</button></div>' +
    '<h3 class="sec">Players</h3><div class="assets">' + pl + "</div>" +
    (pk ? '<h3 class="sec" style="margin-top:14px">Draft picks</h3><div class="assets">' + pk + "</div>" : "") +
    '<h3 class="sec" style="margin-top:14px">Cash · balance ' + signed(b.cash) + "</h3>" + (cash ? '<div class="assets">' + cash + "</div>" : "") +
    '<div class="cashrow"><input type="number" min="0.5" step="0.5" inputmode="decimal" placeholder="$M" data-role="cashAmt" data-from="' + esc(code) + '">' +
    (others.length > 1 ? '<select data-role="cashTo" data-from="' + esc(code) + '">' + others.map(function (c) { return opt(c, "→ " + c); }).join("") + "</select>"
      : '<input type="hidden" data-role="cashTo" data-from="' + esc(code) + '" value="' + esc(others[0] || "") + '"><span class="muted small">→ ' + esc(others[0] || "another team") + "</span>") +
    '<button class="btn sm" data-act="addCash" data-from="' + esc(code) + '">Add cash</button></div></div>';
}
function teamPicker() {
  var T = S.trade, full = T.teams.length >= 4;
  return '<div class="box"><div class="panel-head"><h3>Teams in the trade</h3><span class="muted small">' + T.teams.length + " of 2–4 picked</span></div>" +
    '<div class="tpicker">' + S.L.teams.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (t) {
      var on = T.teams.indexOf(t.code) >= 0;
      return '<button class="tpk' + (on ? " on" : "") + '"' + teamStyle(t.code) + ' data-act="tradeToggle" data-code="' + esc(t.code) + '"' + (!on && full ? " disabled" : "") +
        ' aria-pressed="' + on + '"><b>' + esc(t.code) + "</b><span>" + esc(t.name) + "</span></button>";
    }).join("") + "</div></div>";
}
function tradeResults() {
  var T = S.trade, L = S.L;
  if (T.teams.length < 2) return '<div class="box empty">Pick at least two teams.</div>';
  if (!T.moves.length) return '<div class="box empty">Tap the players, picks or cash each team sends.</div>';
  var r = LM.evaluateTrade(L, T);
  var head = '<div class="box ' + (r.legal ? "v-ok" : "v-no") + '"><div class="verdict ' + (r.legal ? "ok" : "no") + '">' + (r.legal ? "✓ Legal trade" : "✗ Not legal") + "</div>" +
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
  return '<div class="pagehead"><div><h1>Trade machine</h1><div class="sub">2–4 teams · players, picks and cash · checks every cap rule</div></div>' +
    '<div class="row start"><button class="btn" data-act="share">Copy share link</button><button class="btn" data-act="clearTrade">Clear</button></div></div>' +
    (S.shareUrl ? '<div class="box"><label class="f">Share link<input type="text" readonly id="shareUrl" value="' + esc(S.shareUrl) + '"></label></div>' : "") +
    teamPicker() +
    (T.teams.length ? '<div class="tm-teams">' + T.teams.map(tradeTeamBox).join("") + "</div>" : "") +
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
function logKind(type) { return /trade/i.test(type) ? "Trade" : /cap hold/i.test(type) ? "Hold" : /extension/i.test(type) ? "Ext" : /restructure/i.test(type) ? "Rest" : /add/i.test(type) ? "Add" : /drop/i.test(type) ? "Drop" : ""; }
// --- transaction entries: team-colored names, player photos, a "gets" card per side of a trade ---
function codeOf(name) { var t = S.L.teams.filter(function (x) { return x.name === name; })[0]; return t ? t.code : ""; }
function tname(name) {
  var c = codeOf(name);
  return c ? '<a class="tname tc"' + teamStyle(c) + ' href="#team/' + esc(c) + '" data-go="team/' + esc(c) + '">' + esc(name) + "</a>" : esc(name);
}
function teamsLine(text) {
  return String(text || "").split(/\s*↔\s*/).map(function (n) { return tname(n.trim()); }).join('<span class="swap">⇄</span>');
}
function logAsset(it) {
  it = String(it || "").trim();
  if (!it || it === "nothing" || it === "—") return it ? '<span class="muted">' + esc(it) + "</span>" : "";
  if (/^\d{4} \d/.test(it)) return '<span class="pickchip">' + esc(it) + "</span>";
  return '<span class="who">' + avatar(it) + pbtn(it) + "</span>";
}
function logBody(r) {
  var parts = String(r.players || "").split(/\s+\|\s+/);
  var sides = parts.map(function (part) {
    var m = part.match(/^(.*?) (gets|adds|drops):\s*(.*)$/);
    return m ? { team: m[1].trim(), verb: m[2], items: m[3].split(/,\s*(?![^()]*\))/) } : null;
  });
  if (sides.length && sides.every(Boolean)) {
    return '<div class="deal">' + sides.map(function (sd) {
      return '<div class="side v-' + sd.verb + '"' + teamStyle(codeOf(sd.team)) + '><div class="side-h">' + tname(sd.team) + '<span class="verb">' + sd.verb + "</span></div>" +
        '<div class="side-b">' + sd.items.map(logAsset).join("") + "</div></div>";
    }).join("") + "</div>";
  }
  var items = parts.map(logAsset).filter(Boolean);
  return items.length ? '<div class="side-b">' + items.join("") + "</div>" : "";
}
// "Today" / "Yesterday" / "Mon, Nov 24" (+ year when not this year), and the time
function dayLabel(d) {
  var now = new Date(), day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  var diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function timeLabel(d) { return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function logWhen(r, compact) {
  var d = new Date(r.ts);
  if (isNaN(d)) return compact ? "" : '<div class="d"></div>';
  var full = esc(d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }));
  if (compact) return '<time class="when" datetime="' + esc(r.ts) + '" title="' + full + '">' + esc(dayLabel(d)) + " · " + esc(timeLabel(d)) + "</time>";
  return '<time class="d" datetime="' + esc(r.ts) + '" title="' + full + '"><b>' + esc(dayLabel(d)) + "</b><span>" + esc(timeLabel(d)) + "</span></time>";
}
function logEntry(r, compact) {
  return '<div class="ent' + (compact ? " compact" : "") + '">' + (compact ? "" : logWhen(r)) + '<div class="body">' +
    '<div class="ent-h"><span class="badge ' + logKind(r.type) + '">' + esc(r.type) + "</span>" + teamsLine(r.teams) +
    (compact ? logWhen(r, true) : r.status ? '<span class="chip">' + esc(r.status) + "</span>" : "") + "</div>" +
    logBody(r) + (r.details && !compact ? '<div class="muted small" style="margin-top:6px">' + esc(r.details) + "</div>" : "") + "</div></div>";
}
function logList() {
  var f = S.lg, rows = S.log.rows.filter(function (r) {
    if (f.type && r.type !== f.type && !new RegExp(f.type, "i").test(r.type)) return false;   // "Adds" includes Add/Drop and commish adds
    if (f.team && r.teams.toLowerCase().indexOf(teamName(f.team).toLowerCase()) < 0) return false;
    if (f.season && String(r.season) !== f.season) return false;
    return true;
  });
  var shown = rows.slice(0, f.n), last = null;
  var ext = !f.season ? bookedExtensions().filter(function (x) {
    return (!f.team || x.code === f.team) && (!f.type || (f.type === "Extension" && x.kind === "Ext") || (f.type === "Restructure" && x.kind === "Rest"));
  }) : [];
  var nExt = ext.filter(function (x) { return x.kind === "Ext"; }).length, nRest = ext.length - nExt;
  var extBox = ext.length ? '<details class="box booked"' + (f.type === "Extension" || f.type === "Restructure" ? " open" : "") + "><summary>" +
    (nExt ? '<span class="badge Ext">Extensions</span>' : "") + (nRest ? '<span class="badge Rest">Restructures</span>' : "") + "<b>" +
    [nExt ? nExt + " extension" + (nExt === 1 ? "" : "s") : "", nRest ? nRest + " restructure" + (nRest === 1 ? "" : "s") : ""].filter(Boolean).join(" and ") +
    ' on the books</b></summary><div class="booked-list">' +
    ext.map(function (x) {
      var c = x.c, i0 = c.sal.findIndex(function (v, i) { return i > 0 && typeof v === "number"; });
      return '<div class="list-row">' + avatar(c.n) + '<div class="nm">' + pbtn(c.n) + '<span class="muted small">' + esc(c.det) + "</span></div>" + tcode(x.code) +
        '<div class="num">' + S.L.seasons.map(function (_, i) { return i ? salCell(c, i) : ""; }).filter(Boolean).slice(0, 4).join(" ") + "</div></div>";
    }).join("") + "</div></details>" : "";
  return extBox + '<div class="muted small" style="margin:0 2px 8px">' + rows.length + " transaction" + (rows.length === 1 ? "" : "s") + "</div>" +
    box("", (shown.map(function (r) {
      var sep = r.season && r.season !== last ? '<div class="log-sep"><span>' + esc(seasonLabel(r.season)) + " season</span></div>" : "";
      last = r.season || last;
      return sep + logEntry(r);
    }).join("") || '<div class="empty">No transactions match.</div>')) +
    (rows.length > shown.length ? '<button class="more" data-act="logMore">Show more</button>' : "");
}
function pageLog() {
  if (!S.log) {
    api("getLog").then(function (d) { S.log = d; if (/^log/.test(S.hash)) rerender(); }, function (e) { view().innerHTML = box("", '<div class="err">' + esc(e.message) + "</div>"); });
    return '<div class="pagehead"><h1>Transactions</h1></div>' + loading("Loading the League Log");
  }
  var types = [["", "All types"], ["Trade", "Trades"], ["Add", "Adds"], ["Drop", "Drops"], ["Cap hold", "Cap holds"], ["Extension", "Extensions"], ["Restructure", "Restructures"]];
  var seasons = []; S.log.rows.forEach(function (r) { if (r.season && seasons.indexOf(String(r.season)) < 0) seasons.push(String(r.season)); });
  seasons.sort().reverse();
  S.log.rows.forEach(function (r) { if (!logKind(r.type) && !types.some(function (t) { return t[0] === r.type; })) types.push([r.type, r.type]); });
  var first = S.log.rows.length ? new Date(S.log.rows[S.log.rows.length - 1].ts) : null;
  return '<div class="pagehead"><div><h1>Transactions</h1><div class="sub">Every move in league history' + (first && !isNaN(first) ? " since " + esc(first.toLocaleDateString(undefined, { month: "long", year: "numeric" })) : "") +
    ", newest first" + (S.log.lastSync ? " · last synced " + esc(S.log.lastSync) : "") + "</div></div></div>" +
    '<div class="row start">' + dropdown("logTeam", S.lg.team, teamItems("All teams"), "Team") +
    dropdown("logType", S.lg.type, types.map(function (t) {
      return { v: t[0], cls: "type-opt", html: t[0] ? '<span class="badge ' + logKind(t[0]) + '">' + esc(t[1]) + "</span>" : '<span class="dd-name">' + esc(t[1]) + "</span>" };
    }), "Type") +
    (seasons.length > 1 ? dropdown("logSeason", S.lg.season || "", [{ v: "", html: '<span class="dd-name">All seasons</span>' }].concat(seasons.map(function (x) {
      return { v: x, html: '<span class="dd-name">' + esc(seasonLabel(x)) + "</span>" }; })), "Season") : "") + "</div>" +
    '<div id="logList">' + logList() + "</div>";
}

/* ============================ rules ============================ */
function pageRules() {
  if (!S.rules) {
    api("getRules").then(function (d) { S.rules = d; if (/^rules/.test(S.hash)) rerender(); }, function (e) { view().innerHTML = box("", '<div class="err">' + esc(e.message) + "</div>"); });
    return '<div class="pagehead"><h1>Rules</h1></div>' + loading("Loading the rules");
  }
  var L = S.L, cur0 = statSeasons()[0];
  if (!S.stats[cur0]) loadStats(cur0).then(function () { if (/^rules/.test(S.hash)) rerender(); }, function () {});   // FPPG for the "eligible now" count
  var sections = [["cap", "Salary cap"], ["contracts", "Contracts"], ["rookies", "Rookie scale"], ["roster", "Roster"], ["fa", "Free agency"],
                  ["ext", "Extensions & restructures"], ["trades", "Trading"]];
  var jump = '<div class="rjump">' + sections.map(function (x) { return '<a href="#rules" data-jump="r-' + x[0] + '">' + esc(x[1]) + "</a>"; }).join("") + "</div>";
  var sec = function (id, title, inner, kicker) {
    return '<section class="rsec" id="r-' + id + '"><div class="rsec-h">' + (kicker ? '<div class="eyebrow">' + esc(kicker) + "</div>" : "") + "<h2>" + esc(title) + "</h2></div>" + inner + "</section>";
  };
  var li = function (items) { return '<ul class="rlist">' + items.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>"; };
  var big = function (v, label, cls) { return '<div class="rbig' + (cls ? " " + cls : "") + '"><b>' + v + "</b><span>" + esc(label) + "</span></div>"; };

  // ---- salary cap: the four levels, with who's in each right now
  var tiers = [
    { key: "cap", name: "Under the cap", range: "$0 – $150M", rules: [["Trades", "No restrictions"], ["Free agency", "No restrictions"], ["Extensions", "Allowed"], ["Restructures", "Allowed"], ["Note", "Must be at $50M by the start of the season"]] },
    { key: "first", name: "1st apron", range: "$150.1 – $200M", rules: [["Trades", "Can take back up to +$15M"], ["Free agency", "Can offer up to 75% of a max"], ["Extensions", "Allowed"], ["Restructures", "Allowed"]] },
    { key: "second", name: "2nd apron", range: "$200.1 – $250M", rules: [["Trades", "Can take back up to +$5M"], ["Free agency", "Minimum deals only"], ["Extensions", "Not allowed"], ["Restructures", "Can't add money to this season"]] },
    { key: "tax", name: "Luxury tax", range: "$250.1 – $300M", rules: [["Trades", "Can only lose cap"], ["Free agency", "Can't sign free agents"], ["Extensions", "Not allowed"], ["Restructures", "Not allowed"], ["Note", "Anything over $300M gets transferred"]] },
  ];
  var byTier = {};
  L.teams.forEach(function (t) { var k = LM.tierOf(book(t.code).payroll[0]).key; (byTier[k === "over" ? "tax" : k] = byTier[k === "over" ? "tax" : k] || []).push(t); });
  var scale = '<div class="rscale">' + tiers.map(function (t) { return '<div class="t-' + t.key + '"><span>' + esc(t.range.split(" – ")[1]) + "</span></div>"; }).join("") + "</div>";
  var cap = scale + '<div class="rtiers">' + tiers.map(function (t) {
    var teams = (byTier[t.key] || []).slice().sort(function (a, b) { return book(b.code).payroll[0] - book(a.code).payroll[0]; });
    return '<div class="rtier t-' + t.key + '"><div class="rtier-h"><span class="tier t-' + t.key + '">' + esc(t.name) + '</span><b>' + esc(t.range) + "</b></div>" +
      '<dl class="rdl">' + t.rules.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("") + "</dl>" +
      '<div class="rnow"><span>' + teams.length + " team" + (teams.length === 1 ? "" : "s") + ' here now</span><div class="rchips">' + teams.map(function (x) { return tcode(x.code); }).join("") + "</div></div></div>";
  }).join("") + "</div>" +
    '<div class="rcallouts">' + big("+2%", "Cap bonus for playoff teams", "accent") + big("Payroll", "Judged before the trade for apron limits") + big("Cash", "Counts toward the cap") + "</div>";

  // ---- contracts
  var kinds = [
    ['<span class="mny m-max">Max<em>MAX</em></span>', "Max", "Players over 22.5 FPPG"],
    ['<span class="mny m-smax">Supermax<em>SMAX</em></span>', "Supermax", "Players over 30 FPPG"],
    ['<span class="mny m-po">Option<em>PO</em></span>', "Player option", "The player decides whether to stay"],
    ['<span class="mny m-to">Option<em>TO</em></span>', "Team option", "The team decides whether to keep him"],
    ['<span class="fa m-rfa">RFA</span>', "Restricted free agent", "His team can match any offer"],
    ['<span class="fa m-ufa">UFA</span>', "Unrestricted free agent", "Free to sign anywhere"],
    ['<span class="mny m-hold">Hold</span>', "Cap hold", "Waived or dropped players still count"],
    ['<span class="chip">Two-way</span>', "Two-way", "Unsigned rookies or 2nd-year players past UDFA"],
  ];
  var maxMoney = [["0 – 14.9 FPPG", "1.5×", 25], ["15 – 22.4 FPPG", "1.75×", 50], ["22.5 – 30 FPPG", "2×", 75], ["30.1+ FPPG (supermax)", "$60M", 100]];
  var contracts = '<div class="rkinds">' + kinds.map(function (k) { return '<div class="rkind"><div class="rkind-tag">' + k[0] + "</div><b>" + esc(k[1]) + "</b><span>" + esc(k[2]) + "</span></div>"; }).join("") + "</div>" +
    '<div class="rgrid2"><div class="box"><div class="panel-head"><h3>Max money by FPPG</h3></div>' + maxMoney.map(function (m) {
      return '<div class="rbar"><span>' + esc(m[0]) + '</span><div class="rbar-t"><i style="width:' + m[2] + '%"></i></div><b>' + esc(m[1]) + "</b></div>"; }).join("") + "</div>" +
    '<div class="rcallouts col">' + big("3 · 2+1 · 2", "Max deals per team: 3 maxes, or 2 maxes + 1 supermax, or 2 supermaxes", "accent") + big("5 yrs", "Longest contract") + big("$2M", "Minimum: 1 year") + "</div></div>";

  // ---- rookie scale
  var rs = [["Picks 1–3", 11, 4, "RFA"], ["Picks 4–8", 8, 4, "RFA"], ["Picks 9–14", 6, 4, "RFA"], ["Picks 15–30", 4, 4, "RFA"], ["Picks 31–60", 2, 2, "RFA"], ["Undrafted", 1, 2, "UFA"]];
  var rookies = '<div class="tbl"><table class="rtbl"><tr><th>Pick</th><th>Year 1</th><th>Year 2</th><th>Year 3</th><th>Year 4</th><th>Then</th></tr>' + rs.map(function (r) {
    var cells = ""; for (var i = 0; i < 4; i++) cells += "<td>" + (i < r[2] ? '<span class="mny m-g">$' + r[1].toFixed(1) + "</span>" : '<span class="dim">·</span>') + "</td>";
    return "<tr><td><b>" + esc(r[0]) + "</b></td>" + cells + '<td><span class="fa m-' + r[3].toLowerCase() + '">' + r[3] + "</span></td></tr>";
  }).join("") + "</table></div>";

  // ---- roster
  var slot = function (n, cls) { return '<span class="rslot ' + cls + '">' + esc(n) + "</span>"; };
  var roster = '<div class="rroster">' +
    '<div class="rgroup"><h4>Starters</h4><div>' + ["PG", "SG", "SF", "PF", "C", "UTIL", "UTIL"].map(function (x) { return slot(x, "start"); }).join("") + "</div></div>" +
    '<div class="rgroup"><h4>Bench</h4><div>' + [1, 2, 3, 4, 5, 6, 7, 8].map(function () { return slot("BN", "bench"); }).join("") + "</div></div>" +
    '<div class="rgroup"><h4>Injured reserve</h4><div>' + slot("IR", "ir") + slot("IR", "ir") + "</div></div>" +
    '<div class="rgroup"><h4>Taxi</h4><div>' + [1, 2, 3, 4, 5].map(function () { return slot("TX", "taxi"); }).join("") + "</div></div></div>" +
    li(["Starters + bench make up the active roster.", "Roster and start at least <b>7 players</b> by the start of the season.",
        "Taxi is only for rookies and two-way players. They can only be activated if you're short of the 7-player minimum.", "Lock in at least your average; you can't go below it."]);

  // ---- free agency
  var fa = '<div class="rgrid2"><div class="box rfa"><div class="panel-head"><h3>Offseason</h3></div>' +
    '<ol class="rsteps"><li><b>Silent bids</b><span>Every bid is blind.</span></li><li><b>72 hours</b><span>Bidding closes 72 hours after the first bid.</span></li><li><b>Top 3 duke it out</b><span>The three best bids go head to head.</span></li></ol></div>' +
    '<div class="box rfa"><div class="panel-head"><h3>In season</h3></div>' +
    '<ol class="rsteps"><li><b>First come, first served</b><span>No bidding.</span></li><li><b>1 year, $2M</b><span>Every in-season signing, then back to free agency after the season.</span></li><li><b>48 hours to match</b><span>Owners get 48 hours to match offers to their restricted free agents.</span></li></ol></div></div>' +
    '<div class="rcallouts">' + big("< $10M", "RFA qualifying offer: the minimum (1 yr, $2M)") + big("$10–15M", "RFA qualifying offer: 2/1") + big("$15M+", "RFA qualifying offer: 5/1") +
    big("Wheel", "Undrafted players: send interest, then a wheel spin", "accent") + "</div>";

  // ---- extensions & restructures (with a live count)
  var eligible = playerRows().filter(function (r) { var e = extEligible(r.c, r.team); return e && !e.blocked; }).length;
  var ext = '<div class="rgrid2"><div class="box"><div class="panel-head"><h3>Extensions</h3><a href="#contracts" data-go="contracts" data-ext="1">' + eligible + " eligible now →</a></div>" +
    '<div class="rtimeline"><div><b>Offseason</b><span>before his free-agency year: eligibility opens</span></div><div><b>Playoffs</b><span>eligibility ends when they start</span></div></div>' +
    li(["Only <b>max-eligible players</b> (22.5+ FPPG) and <b>rookies</b> can be extended; everyone else hits free agency.",
        "Until a month into the season, last season's FPPG decides max eligibility.", "Commissioners vote: it takes <b>4–3</b> to pass.",
        "An extension counts as a separate contract.", "Teams at the 2nd apron or in the tax can't extend."]) + "</div>" +
    '<div class="box"><div class="panel-head"><h3>Restructures</h3></div>' +
    '<div class="rcallouts col">' + big("$10M", "Most you can move per player, into any one year", "accent") + big("2", "Restructures per team per year") + "</div>" +
    li(["Money moves; the years don't. Total money and years stay the same.", "Teams at the 2nd apron can't add money to this season.", "Player options: the commissioners set the odds he accepts, then a random number decides."]) + "</div></div>";

  // ---- trading
  var trades = '<div class="rcallouts">' + big("3–2", "Commissioner vote to pass a trade", "accent") + big("$10M", "Cash each team can use per season") + big("Auto", "Veto for anything that breaks a rule") + "</div>" +
    li(["Cash counts toward the cap.", "<b>You can't pay off parts of contracts.</b>", "Apron limits are judged on payroll before the trade."]) +
    '<div class="actions"><a class="btn pri" href="#trade" data-go="trade">Open the trade machine</a></div>';

  // ---- the original sheet, for reference
  var raw = [], cur = [];
  S.rules.rows.forEach(function (r) { if (!r.length || r.every(function (v) { return !v; })) { if (cur.length) raw.push(cur); cur = []; } else cur.push(r); });
  if (cur.length) raw.push(cur);
  var sheet = '<details class="box rsheet"><summary><b>Original rules sheet</b></summary>' + raw.map(function (rows) {
    var w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    return '<div class="tbl" style="margin-top:10px"><table class="rules">' + rows.map(function (r) {
      var cells = []; for (var i = 0; i < w; i++) cells.push("<td>" + esc(r[i] || "") + "</td>"); return "<tr>" + cells.join("") + "</tr>"; }).join("") + "</table></div>";
  }).join("") + "</details>";

  return '<div class="pagehead"><div><div class="eyebrow">League rules</div><h1>Rules</h1></div></div>' + jump +
    sec("cap", "Salary cap", cap, "Four levels") + sec("contracts", "Contracts", contracts) + sec("rookies", "Rookie scale", rookies) +
    sec("roster", "Roster", roster) + sec("fa", "Free agency", fa) + sec("ext", "Extensions & restructures", ext) + sec("trades", "Trading", trades) + sheet;
}

/* ============================ commissioner ============================ */
var ADMIN_TABS = [["pending", "Pending"], ["contracts", "Restructures"], ["extend", "Extensions"], ["holds", "Cap holds"],
                  ["waive", "Waived & re-signed"], ["cash", "Cash"], ["ranks", "Power rankings"], ["sync", "Sync & log"]];
var ICONS = {
  pending: '<circle cx="10" cy="10" r="7"/><path d="M10 6.2V10l2.6 1.8"/>',
  contracts: '<path d="M6 2.8h5.6L15 6.2v11H6z"/><path d="M11.4 2.8v3.6H15M8.4 10h4.2M8.4 13h4.2"/>',
  extend: '<path d="M3.5 10h11.5M11.5 6l4 4-4 4"/><path d="M3.5 5.5v9"/>',
  holds: '<rect x="4" y="8.4" width="12" height="8.6" rx="2"/><path d="M7 8.4V6.4a3 3 0 0 1 6 0v2"/>',
  waive: '<path d="M4.5 7.5H13a3.3 3.3 0 0 1 0 6.6H8.5"/><path d="M7.5 4.5l-3 3 3 3"/>',
  cash: '<rect x="2.8" y="5.2" width="14.4" height="9.6" rx="2"/><circle cx="10" cy="10" r="2.2"/><path d="M5.6 8v4M14.4 8v4"/>',
  ranks: '<path d="M5 16.5V10M10 16.5V4.5M15 16.5V8"/>',
  sync: '<path d="M15.5 8.5A5.8 5.8 0 0 0 5 6.2L3.6 7.6M4.5 11.5A5.8 5.8 0 0 0 15 13.8l1.4-1.4"/><path d="M3.6 3.8v3.8h3.8M16.4 16.2v-3.8h-3.8"/>',
  key: '<circle cx="7" cy="12.5" r="3.5"/><path d="M9.5 10 16 3.5M13.5 6l2 2M11.6 7.9l1.6 1.6"/>',
};
function icon(k, size) {
  return '<svg viewBox="0 0 20 20" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[k] + "</svg>";
}

function adminLogout(msg) { Admin.signOut(); if (msg) toast(msg, true); rerender(); }
// Runs mutation steps as one commit, then shows the result right away
// (the public site catches up when GitHub Pages redeploys, about a minute).
function adminCall(steps, okMsg) {
  return Admin.apply(steps).then(function (res) {
    ["contracts", "holds", "cash", "teams", "adminLog"].forEach(function (k) { DATA[k] = res.D[k]; });
    S.admin.log = null; S.log = null;
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
// A form field that's a custom dropdown (team colors etc.); the value lives in a hidden input read by val(key)
function fieldDD(key, value, items, aria) {
  return '<div class="dd-field">' + dropdown("field:" + key, value, items, aria) + '<input type="hidden" data-k="' + esc(key) + '" value="' + esc(value == null ? "" : value) + '"></div>';
}
function plainItems(list) { return list.map(function (x) { return { v: String(x[0]), html: '<span class="dd-name">' + esc(x[1]) + "</span>" }; }); }
function field(label, inner, wide) { return '<div class="f' + (wide ? " wide" : "") + '"><span>' + esc(label) + "</span>" + inner + "</div>"; }
function panel(title, inner, extra) {
  return '<section class="box apanel"><div class="panel-head"><h3>' + esc(title) + "</h3>" + (extra || "") + "</div>" + inner + "</section>";
}
/* Player picker: a text box whose suggestions show the player's photo, NBA team, league team and salary.
 * key: the field name read by val(key); picking runs ppPicked(key, contract). */
function playerPicker(key, value, placeholder) {
  return '<div class="pp"><div class="search"><input type="text" class="pp-in" id="pp-' + esc(key) + '" data-k="' + esc(key) + '" value="' + esc(value || "") +
    '" placeholder="' + esc(placeholder || "Search a player") + '" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"></div>' +
    '<div class="pp-menu" role="listbox" hidden></div></div>';
}
function ppMatches(q) {
  q = String(q || "").trim();
  var qn = LM.norm(q), up = q.toUpperCase();
  var list = S.L.contracts.filter(function (c) { return !c.hold && (!q || LM.norm(c.n).indexOf(qn) >= 0 || c.nba === up); });
  list.sort(function (a, b) {
    var sa = LM.norm(a.n).indexOf(qn) === 0 ? 0 : 1, sb = LM.norm(b.n).indexOf(qn) === 0 ? 0 : 1;
    return sa - sb || ((typeof b.sal[0] === "number" ? b.sal[0] : 0) - (typeof a.sal[0] === "number" ? a.sal[0] : 0));
  });
  return list.slice(0, 30);
}
function ppRender(input) {
  var menu = input.closest(".pp").querySelector(".pp-menu"), idx = rosterIdx();
  var list = ppMatches(input.value);
  menu.innerHTML = list.length ? list.map(function (c) {
    var r = idx[LM.norm(c.n)];
    return '<button type="button" class="pp-opt" role="option" data-act="ppPick" data-id="' + c.id + '">' + avatar(c.n) +
      '<span class="nm"><b>' + esc(c.n) + '</b><span class="muted small">' + esc(c.nba) + " · " + (r ? esc(teamName(r.code)) : "free agent") + "</span></span>" +
      (r ? '<span class="tcode tc"' + teamStyle(r.code) + ">" + esc(r.code) + "</span>" : "") + '<span class="num">' + (salCell(c, 0) || "") + "</span></button>";
  }).join("") : '<div class="empty" style="padding:12px">No player matches.</div>';
  menu.hidden = false; input.setAttribute("aria-expanded", "true");
}
function ppClose(except) {
  Array.prototype.forEach.call(document.querySelectorAll(".pp-menu"), function (m) {
    if (except && m.closest(".pp") === except) return;
    m.hidden = true; var i = m.closest(".pp").querySelector(".pp-in"); if (i) i.setAttribute("aria-expanded", "false");
  });
}
// after a pick
function ppPicked(key, c) {
  if (key === "extName") refreshExt();
  else if (key === "rsName") { S.admin.edit = editable(c, "restructure"); rerender(); var ed = $("editor"); if (ed) window.scrollTo(0, ed.offsetTop - 70); }
}
function contractByName(name) {
  var k = LM.norm(plain(name || ""));
  return k ? S.L.contracts.filter(function (c) { return !c.hold && LM.norm(c.n) === k; })[0] : null;
}

function pageAdmin() {
  var A = S.admin;
  if (!Admin.signedIn()) {
    return '<div class="login"><div class="login-card"><div class="login-icon">' + icon("key", 26) + "</div><h1>Commissioner</h1>" +
      '<p class="muted">Sign in with your GitHub token to edit contracts, extensions, cap holds, cash and rankings.</p>' +
      '<form id="loginForm"><div class="f"><span>GitHub token</span><input type="password" id="pass" autocomplete="off" placeholder="github_pat_…"></div>' +
      '<button class="btn pri wide" type="submit">Sign in</button><div class="err small" id="loginMsg"></div></form>' +
      '<details class="how"><summary>How do I get a token?</summary><ol>' +
      '<li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub › Fine-grained tokens</a>.</li>' +
      "<li>Repository access: <b>Only select repositories</b> → <b>" + esc(SITE.owner + "/" + SITE.repo) + "</b>.</li>" +
      "<li>Permissions: <b>Contents</b> and <b>Actions</b> → Read and write.</li>" +
      "<li>Generate it and paste it here. It stays in this browser until you sign out.</li></ol></details></div></div>";
  }
  var counts = {
    pending: S.L.contracts.filter(function (c) { return /pending/i.test(c.det); }).length,
    holds: S.L.holds.length,
  };
  var who = Admin.who() || "";
  var nav = '<aside class="admin-nav"><div class="who-card"><span class="who-av">' + esc(who.charAt(0).toUpperCase() || "?") + '</span><div class="grow"><b>' + esc(who) +
    '</b><span>Commissioner</span></div><button class="linkbtn small" data-act="logout">Sign out</button></div><nav>' +
    ADMIN_TABS.map(function (t) {
      var n = counts[t[0]];
      return '<button class="an' + (A.tab === t[0] ? " on" : "") + (t[0] === "pending" && n ? " alert" : "") + '" data-act="adminTab" data-v="' + t[0] + '">' + icon(t[0]) +
        "<span>" + esc(t[1]) + "</span>" + (n ? "<em>" + n + "</em>" : "") + "</button>";
    }).join("") + "</nav></aside>";
  var body = ({ pending: adminPending, contracts: adminContracts, extend: adminExtend, holds: adminHolds, waive: adminWaive, cash: adminCash,
                ranks: adminRanks, sync: adminSync })[A.tab]();
  var title = ADMIN_TABS.filter(function (t) { return t[0] === A.tab; })[0][1];
  return '<div class="admin">' + nav + '<div class="admin-main"><div class="admin-head"><div class="eyebrow">Commissioner</div><h1>' + esc(title) + "</h1></div>" +
    (A.edit ? contractEditor(A.edit) : "") + body + "</div></div>";
}

// Contract type buttons, colored like the money tags (Guaranteed / PO / TO / Max / Supermax / Cap hold)
var STAT_CHIPS = [["", "Guaranteed", "g"], ["PO", "Player option", "po"], ["TO", "Team option", "to"], ["MAX", "Max", "max"], ["SMAX", "Supermax", "smax"], ["HOLD", "Cap hold", "hold"]];
function statKind(st) { var x = STAT_CHIPS.filter(function (c) { return c[0] === (st || ""); })[0]; return x ? x[2] : "g"; }
function statChips(i, cur) {
  return '<div class="stchips" role="radiogroup" aria-label="Contract type">' + STAT_CHIPS.map(function (x) {
    return '<button type="button" class="stc m-' + x[2] + ((cur || "") === x[0] ? " on" : "") + '" data-act="setStat" data-i="' + i + '" data-v="' + x[0] + '" role="radio" aria-checked="' +
      ((cur || "") === x[0]) + '" title="' + x[1] + '">' + (x[0] || "G") + "</button>";
  }).join("") + '<input type="hidden" data-stat="' + i + '" value="' + esc(cur || "") + '"></div>';
}
// mode "restructure": only the years he already has can change, and saving is a Restructure transaction
function contractEditor(c) {
  var L = S.L, r = c.id ? rosterIdx()[LM.norm(c.n)] : null, re = c.mode === "restructure";
  var cards = L.seasons.map(function (s, i) {
    var v = c.sal[i], has = typeof c.orig[i] === "number";
    if (re && !has) return '<div class="sea locked"><span>' + esc(s) + '</span><div class="locked-v">' + (salCell(c, i) || '<span class="muted">—</span>') + "</div></div>";
    return '<div class="sea m-' + statKind(c.st[i]) + '"><span>' + esc(s) + '</span><input type="text" data-sal="' + i + '" value="' + esc(typeof v === "number" ? v : v || "") + '" placeholder="—" aria-label="Salary ' + esc(s) + '">' +
      statChips(i, c.st[i]) + "</div>";
  }).join("");
  var who = c.id ? '<div class="ed-who">' + avatar(c.n) + "<div><b>" + esc(plain(c.n)) + '</b><span class="muted small">' + esc(c.nba) + (r ? " · " + esc(teamName(r.code)) : "") + (c.det ? " · " + esc(c.det) : "") + "</span></div></div>" : "";
  if (re) {
    return '<section class="box apanel editor" id="editor"><div class="panel-head"><h3>Restructure contract</h3><button class="x sm" data-act="cancelEdit" aria-label="Close">×</button></div>' + who +
      '<div class="f"><span>New salary for each year he already has ($M)</span><div class="seasons">' + cards + "</div></div>" +
      '<p class="muted small">Only existing years can change. Saving records a <b>Restructure</b> in Transactions and tags his details' + (r ? " “" + esc(r.code) + " Restructure”" : "") + ". Extend under Extensions.</p>" +
      '<div class="actions"><button class="btn pri" data-act="saveContract">Save restructure</button><button class="btn" data-act="cancelEdit">Cancel</button>' +
      '<button class="linkbtn small" data-act="fullEdit">Fix a typo instead (not a transaction)</button></div></section>';
  }
  return '<section class="box apanel editor" id="editor"><div class="panel-head"><h3>' + (c.id ? "Edit contract" : "New contract") + "</h3>" +
    '<button class="x sm" data-act="cancelEdit" aria-label="Close">×</button></div>' + who +
    '<div class="form2">' + field("Player name", '<input type="text" data-k="n" value="' + esc(c.n) + '">') +
    field("NBA team", '<input type="text" data-k="nba" value="' + esc(c.nba) + '" placeholder="ATL (Z if unknown)" style="text-transform:uppercase">') + "</div>" +
    '<div class="f" style="margin-top:14px"><span>Salary by season ($M, or UFA / RFA)</span><div class="seasons">' + cards + "</div></div>" +
    '<div class="form2" style="margin-top:14px">' + field("Contract details", '<input type="text" data-k="det" value="' + esc(c.det) + '" placeholder="e.g. Rookie; Ext 27-28">', true) + "</div>" +
    '<p class="muted small">' + (c.id ? "Name it “Player (cap hold)” to make it a cap hold." : "A new contract goes at the end of its NBA team's group.") + "</p>" +
    '<div class="actions"><button class="btn pri" data-act="saveContract">Save contract</button><button class="btn" data-act="cancelEdit">Cancel</button>' +
    (c.id ? '<button class="btn danger" data-act="deleteContract" data-confirm="Tap again to delete">Delete</button>' : "") + "</div></section>";
}
function editable(c, mode) {
  var has = c.sal.some(function (v) { return typeof v === "number"; });
  return { id: c.id, n: c.n, nba: c.nba, sal: c.sal.slice(), st: c.st.slice(), det: c.det, orig: c.sal.slice(), mode: mode === "restructure" && has && !c.hold ? "restructure" : "full" };
}
function contractList(list, mode) {
  if (!list.length) return '<div class="empty">Nothing here.</div>';
  var idx = rosterIdx();
  return '<div class="clist">' + list.map(function (c) {
    var r = idx[LM.norm(c.n)], code = c.hold ? holdTeam(c.n) : r ? r.code : "";
    return '<div class="crow">' + avatar(c.n) + '<div class="nm">' + pbtn(c.n, c.hold ? plain(c.n) : "") + (c.hold ? '<span class="flag bad">Cap hold</span>' : "") +
      '<span class="muted small">' + esc(c.nba) + (c.det ? " · " + esc(c.det) : "") + "</span></div>" + tcode(code) +
      '<div class="num">' + (salCell(c, 0) || '<span class="muted">—</span>') + '</div><button class="btn sm" data-act="edit" data-id="' + c.id + '"' + (mode ? ' data-mode="' + mode + '"' : "") + ">" + (mode === "restructure" ? "Restructure" : "Edit") + "</button></div>";
  }).join("") + "</div>";
}
function contractSearch(q) {
  var qn = LM.norm(q);
  return S.L.contracts.filter(function (c) { return LM.norm(c.n).indexOf(qn) >= 0 || c.nba.toLowerCase() === q.trim().toLowerCase(); }).slice(0, 40);
}
function adminPending() {
  var list = S.L.contracts.filter(function (c) { return /pending/i.test(c.det); });
  return panel("Waiting for a contract · " + list.length, list.length
    ? '<p class="muted small" style="margin-top:0">The sync adds one of these when a team picks up a player without a contract. Set the salary and clear the PENDING note.</p>' + contractList(list)
    : '<div class="done">' + icon("pending", 22) + "<b>All caught up</b><span class=\"muted small\">New pickups without a contract show up here.</span></div>");
}
function adminContracts() {
  var q = S.admin.q.trim();
  return panel("Restructure a contract", '<div class="toolbar"><div class="grow">' + playerPicker("rsName", "", "Search a player to restructure") + "</div>" +
    '<button class="btn" data-act="newContract">+ New contract</button></div>');
}
// ---- extensions
function extState() {
  var E = S.admin.ext || (S.admin.ext = { name: "", start: "", years: "2", amt: "", st: "" });
  return E;
}
function extPreview() {
  var E = extState(), c = contractByName(E.name), L = S.L;
  if (!E.name.trim()) return '<div class="empty">Pick a player to see his contract.</div>';
  if (!c) return '<div class="empty">No contract for “' + esc(E.name) + '” on the Master list.</div>';
  var after = null, err = "";
  try {
    var copy = { id: c.id, n: c.n, nba: c.nba, sal: c.sal.slice(), st: c.st.slice(), det: c.det };
    Mutations.extend({ contracts: { seasons: L.seasons, rows: [copy] } }, { id: c.id, years: E.years, amt: E.amt, st: E.st });
    after = copy;
  } catch (e) { err = e.message; }
  var row = function (label, x) { return "<tr><td>" + label + "</td>" + L.seasons.map(function (_, i) { var v = salCell(x, i); return "<td" + (v ? "" : ' class="dim"') + ">" + (v || "·") + "</td>"; }).join("") + "</tr>"; };
  return '<div class="ed-who">' + avatar(c.n) + "<div><b>" + esc(c.n) + '</b><span class="muted small">' + esc(c.nba) + (c.det ? " · " + esc(c.det) : "") + "</span></div></div>" +
    '<div class="tbl"><table><tr><th></th>' + L.seasons.map(function (x) { return "<th>" + esc(x) + "</th>"; }).join("") + "</tr>" + row("Now", c) +
    (after ? row("<b>After</b>", after) : "") + "</table></div>" + (err ? '<p class="err small">' + esc(err) + "</p>" : "");
}
function adminExtend() {
  var E = extState(), L = S.L, c = contractByName(E.name);
  var fa = c ? Mutations.faYear(c) : null;
  return panel("Extend a contract",
    '<div class="form2">' + field("Player", playerPicker("extName", E.name, "Search a player"), true) +
    field("Starts", '<div class="fa-start" id="extStartShow">' + (c ? fa != null ? '<span class="fa m-ufa">' + esc(L.seasons[fa]) + "</span> his free-agency year" : '<span class="muted">No free-agency year to extend into</span>' : '<span class="muted">His free-agency year</span>') + "</div>") +
    field("Years", fieldDD("extYears", E.years, plainItems([[1, "1 year"], [2, "2 years"], [3, "3 years"], [4, "4 years"], [5, "5 years"]]), "Years")) +
    field("Salary per year ($M)", '<input type="number" min="0.5" step="0.1" inputmode="decimal" id="extAmt" data-k="extAmt" value="' + esc(E.amt) + '" placeholder="e.g. 25">') +
    field("Kind", fieldDD("extSt", E.st, [{ v: "", html: '<span class="dd-name">Regular</span>' }, { v: "MAX", html: '<span class="mny m-max">Max</span>' },
      { v: "SMAX", html: '<span class="mny m-smax">Supermax</span>' }], "Kind")) + "</div>" +
    '<div id="extPreview" style="margin-top:14px">' + extPreview() + "</div>" +
    '<div class="actions"><button class="btn pri" data-act="extend">Record extension</button></div>' +
    '<p class="muted small">Starts in his free-agency year, fills that many seasons, makes the next one UFA, tags the details (e.g. “Ext 29-30”) and adds it to Transactions.</p>');
}
function refreshExt() {
  var E = extState();
  E.name = val("extName"); E.years = val("extYears"); E.amt = val("extAmt"); E.st = val("extSt");
  var el = $("extPreview"); if (el) el.innerHTML = extPreview();
  var c = contractByName(E.name), fa = c ? Mutations.faYear(c) : null, show = $("extStartShow");
  if (show) show.innerHTML = c ? fa != null ? '<span class="fa m-ufa">' + esc(S.L.seasons[fa]) + "</span> his free-agency year" : '<span class="muted">No free-agency year to extend into</span>' : '<span class="muted">His free-agency year</span>';
}
// ---- cap holds
function adminHolds() {
  var holds = S.L.holds.slice().sort(function (a, b) { return teamName(a.code).localeCompare(teamName(b.code)) || a.name.localeCompare(b.name); });
  var groups = {}, order = [];
  holds.forEach(function (h) { if (!groups[h.code]) { groups[h.code] = []; order.push(h.code); } groups[h.code].push(h); });
  var list = order.map(function (code) {
    var total = 0;
    var rows = groups[code].map(function (h) {
      var c = S.L.contracts.filter(function (x) { return x.hold && LM.norm(x.n) === LM.norm(h.name); })[0];
      if (c && typeof c.sal[0] === "number") total += c.sal[0];
      return '<div class="crow">' + avatar(h.name) + '<div class="nm">' + pbtn(h.name, plain(h.name)) + (c ? "" : '<span class="flag bad">No contract</span>') +
        (h.note && !/^Imported/.test(h.note) ? '<span class="muted small">' + esc(h.note) + "</span>" : "") + '</div><div class="num">' + (salCell(c, 0) || "") + "</div>" +
        '<button class="btn sm danger" data-act="rmHold" data-id="' + h.id + '" data-confirm="Tap again">Remove</button></div>';
    }).join("");
    return '<div class="hgroup"' + teamStyle(code) + '><div class="hg-head">' + tname(teamName(code)) + '<span class="muted small">' + groups[code].length + " hold" +
      (groups[code].length === 1 ? "" : "s") + " · " + money(total) + "M this season</span></div>" + rows + "</div>";
  }).join("");
  return panel("Make a player a cap hold",
      '<div class="form2">' + field("Player", playerPicker("holdName", "", "Search a player"), true) +
      field("Team that carries it", fieldDD("holdCode", "", teamItems("Pick a team"), "Team that carries it")) + "</div>" +
      '<div class="actions"><button class="btn pri" data-act="addHold">Add cap hold</button></div>' +
      '<p class="muted small">Renames his contract to “(cap hold)” and puts it on that team. Removing a hold keeps the contract row; delete that under Contracts if it\'s gone for good.</p>') +
    panel("Cap holds · " + holds.length, list || '<div class="empty">No cap holds.</div>');
}
function adminWaive() {
  var w = S.admin.waive || {};
  return panel("Waived & re-signed",
    '<p class="muted small" style="margin-top:0">His old contract becomes a cap hold on the team that waived him, and he gets a new $2.0M / 1-year minimum (then UFA) in his NBA team\'s group.</p>' +
    '<div class="form2">' + field("Player", playerPicker("waiveName", w.name || "", "Search a player"), true) +
    field("Team that waived him", fieldDD("waiveCode", w.code || "", teamItems("Pick a team"), "Team that waived him")) + "</div>" +
    '<div class="actions"><button class="btn pri" data-act="waive">Convert</button></div>' + (w.msg ? '<p class="ok">' + esc(w.msg) + "</p>" : ""));
}
// ---- cash
function adminCash() {
  var L = S.L, A = S.admin, season = A.cashSeason || L.season;
  var bal = {};
  L.cash.forEach(function (x) { if (x.season === season) bal[x.code] = LM.r1((bal[x.code] || 0) + x.amt); });
  var any = Object.keys(bal).some(function (k) { return bal[k]; });
  var teams = L.teams.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (t) {
    var v = bal[t.code] || 0, over = Math.abs(v) > L.limits.cash;
    var state = v > 0 ? '<span class="cb sent">Sent ' + money(v) + "</span>" : v < 0 ? '<span class="cb got">Received ' + money(-v) + "</span>" : '<span class="cb even">$0.0</span>';
    return '<div class="cashrow2' + (over ? " over" : "") + '"' + teamStyle(t.code) + ">" + swatch(t.code) + '<div class="nm"><b>' + esc(t.name) + "</b>" + state + "</div>" +
      '<input type="number" min="0.5" step="0.5" inputmode="decimal" placeholder="$M" data-cash-amt="' + esc(t.code) + '" aria-label="Amount for ' + esc(t.name) + '">' +
      '<button class="btn sm cash-add" data-act="cashAdj" data-dir="add" data-code="' + esc(t.code) + '" title="Team gets cash (payroll goes down)">+ Add</button>' +
      '<button class="btn sm cash-take" data-act="cashAdj" data-dir="take" data-code="' + esc(t.code) + '" title="Team pays cash (payroll goes up)">− Take</button></div>';
  }).join("");
  var rows = L.cash.slice().reverse().map(function (x) {
    return "<tr><td>" + tcode(x.code) + '</td><td class="l muted">' + esc(String(x.date || "").slice(0, 10)) + '</td><td class="l">' + esc(x.season) + '</td><td class="' + cls(x.amt) + '"><b>' + signed(x.amt) +
      '</b></td><td class="l small">' + esc(x.note) + (x.ref ? ' <span class="muted">' + esc(x.ref) + "</span>" : "") + "</td><td>" +
      '<button class="btn sm danger" data-act="rmCashRow" data-id="' + x.id + '" data-confirm="Tap again">Delete</button></td></tr>';
  }).join("");
  var head = '<div class="cash-tools">' + fieldDD("cashSeason", season, plainItems(L.seasons.map(function (x) { return [x, x]; })), "Season") +
    '<label class="check"><input type="checkbox" data-k="cashOverride"> Override ±$' + L.limits.cash + "M</label>" +
    (any ? '<button class="btn danger" data-act="resetCash" data-confirm="Tap again to reset all">Reset cash</button>' : "") + "</div>";
  return panel("Team cash · " + season, head + '<div class="cashlist">' + teams + "</div>") +
    '<details class="box ledger"><summary><b>Cash ledger</b><span class="muted small">' + L.cash.length + " rows</span></summary>" +
    '<div class="tbl"><table><tr><th>Team</th><th class=l>Date</th><th class=l>Season</th><th>Amount</th><th class=l>Note</th><th></th></tr>' + rows + "</table></div></details>";
}
function adminRanks() {
  var pos = {}; LM.standings(S.L.teams).forEach(function (t, i) { pos[t.code] = i + 1; });
  return panel("Power rankings", '<p class="muted small" style="margin-top:0">The commissioners\' order, shown in the Power column on Standings. Leave blank to unrank a team.</p>' +
    '<div class="clist">' + S.L.teams.map(function (t) {
      return '<div class="crow">' + swatch(t.code) + '<div class="nm"><b>' + esc(t.name) + '</b><span class="muted small">' + record(t) + " · " + f1(t.pf) + " PF · " + ordinalNum(pos[t.code]) + " in standings</span></div>" +
        '<input type="number" min="1" max="30" class="rank-in" data-rank="' + esc(t.code) + '" value="' + (t.rank == null ? "" : t.rank) + '" aria-label="Rank for ' + esc(t.name) + '" placeholder="—"></div>'; }).join("") +
    '</div><div class="actions"><button class="btn pri" data-act="saveRanks">Save rankings</button></div>');
}
function ordinalNum(n) { if (!n) return ""; var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function adminSync() {
  var log = S.admin.log;
  if (!log) Admin.adminLog().then(function (r) { S.admin.log = r; if (S.admin.tab === "sync" && /^admin/.test(S.hash)) rerender(); },
    function (e) { S.admin.log = []; toast(e.message, true); });
  return panel("Sleeper sync", '<div class="sync-card"><div class="sync-ic">' + icon("sync", 22) + '</div><div class="grow"><b>Runs every 5 minutes on GitHub</b>' +
      '<span class="muted small">Last change it made: ' + esc(S.L.lastSync ? when(S.L.lastSync) : "—") + "</span></div>" +
      '<button class="btn pri" data-act="runSync">Run sync now</button></div>' +
      '<p class="muted small">GitHub sometimes runs it a few minutes late. <a href="https://github.com/' + esc(SITE.owner + "/" + SITE.repo) + '/actions" target="_blank" rel="noopener">See runs on GitHub</a></p>') +
    panel("Admin log", !log ? loading() : log.length ? '<div class="alog">' + log.slice(0, 200).map(function (r) {
      var d = new Date(r.ts);
      return '<div class="al"><time class="d" title="' + esc(when(r.ts)) + '"><b>' + esc(isNaN(d) ? "" : dayLabel(d)) + "</b><span>" + esc(isNaN(d) ? "" : timeLabel(d)) + "</span></time>" +
        '<div class="body"><div class="ent-h"><span class="badge">' + esc(r.action) + '</span><span class="muted small">by ' + esc(r.who || "—") + '</span></div><div class="small">' + esc(r.details) + "</div></div></div>"; }).join("") + "</div>"
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
  var jm = t.closest && t.closest("[data-jump]");
  if (jm) { ev.preventDefault(); var tgt = $(jm.getAttribute("data-jump")); if (tgt) window.scrollTo({ top: tgt.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" }); return; }
  var ge = t.closest && t.closest("[data-ext]");
  if (ge) S.pl.f = "ext";
  var g = t.closest && t.closest("[data-go]");
  if (g) { ev.preventDefault(); if ($("modal").classList.contains("open")) closePlayer(); Nav.go(g.getAttribute("data-go")); return; }
  if (t.id === "modal" || t.id === "modalClose") { closePlayer(); return; }
  var ddb = t.closest && t.closest("[data-act=ddToggle],[data-act=ddPick]");
  if (ddb) {
    var dd = ddb.closest(".dd");
    if (ddb.getAttribute("data-act") === "ddPick") { closeMenus(); onPick(ddb.getAttribute("data-dd"), ddb.getAttribute("data-v"), ddb); return; }
    var open = !dd.classList.contains("open");
    closeMenus(dd);
    dd.classList.toggle("open", open); dd.querySelector(".dd-menu").hidden = !open; ddb.setAttribute("aria-expanded", String(open));
    if (open) {
      var menu = dd.querySelector(".dd-menu");
      menu.classList.remove("right");
      if (window.innerWidth > 640 && menu.getBoundingClientRect().right > window.innerWidth - 8) menu.classList.add("right");
      var on = dd.querySelector(".dd-opt.on") || dd.querySelector(".dd-opt"); if (on) on.focus({ preventScroll: true });
    }
    return;
  }
  if (!(t.closest && t.closest(".dd"))) closeMenus();
  var pick = t.closest && t.closest("[data-act=ppPick]");
  if (pick) {
    var pp = pick.closest(".pp"), inp = pp.querySelector(".pp-in"), pc = S.L.contracts.filter(function (x) { return x.id === Number(pick.getAttribute("data-id")); })[0];
    if (pc) { inp.value = pc.n; ppClose(); ppPicked(inp.getAttribute("data-k"), pc); }
    return;
  }
  ppClose(t.closest && t.closest(".pp"));
  var fth = t.closest && t.closest("th[data-act=fSort]");
  if (fth) { var fk = Number(fth.getAttribute("data-k")); S.fsort = S.fsort === fk ? null : fk; rerender(); return; }
  var sth = t.closest && t.closest("th[data-act=stSort]");
  if (sth) {
    var sk = sth.getAttribute("data-k");
    if (S.st.sort === sk) S.st.asc = !S.st.asc; else { S.st.sort = sk; S.st.asc = sk === "name" || sk === "team"; }
    $("stTable").innerHTML = statTable(); return;
  }
  var th = t.closest && t.closest("th[data-act=plSort]");
  if (th) {
    var k = th.getAttribute("data-k");
    if (S.pl.sort === k) S.pl.asc = !S.pl.asc; else { S.pl.sort = k; S.pl.asc = k === "n" || k === "nba" || k === "team"; }
    $("plTable").innerHTML = plTable(); return;
  }
  var b = t.closest && t.closest("button[data-act]");
  if (b && b.getAttribute("data-act") === "download") {
    busy(b, Export.download(S.L, LOCAL.getLog, LOCAL.getRules).then(function () { toast("Spreadsheet downloaded"); }, function (e) { toast(e.message, true); }));
    return;
  }
  if (!b || !view().contains(b)) return;
  var act = b.getAttribute("data-act"), A = S.admin;
  if (!armed(b)) return;

  switch (act) {
    case "plFilter": S.pl.f = b.getAttribute("data-v"); S.pl.limit = 150; rerender(); break;
    case "plKind": var kv = b.getAttribute("data-v"), ki = S.pl.ks.indexOf(kv);
      if (ki >= 0) S.pl.ks.splice(ki, 1); else S.pl.ks.push(kv);
      S.pl.limit = 150; rerender(); break;
    case "plKmode": S.pl.kmode = b.getAttribute("data-v"); S.pl.limit = 150; rerender(); break;
    case "plMoreToggle": S.pl.more = !S.pl.more; rerender(); break;
    case "plClear":
      var ck = b.getAttribute("data-k");
      if (ck === "f") S.pl.f = "all";
      else if (ck.indexOf("k:") === 0) S.pl.ks.splice(S.pl.ks.indexOf(ck.slice(2)), 1);
      else if (ck === "sal") { S.pl.smin = ""; S.pl.smax = ""; }
      else S.pl[ck] = "";
      S.pl.limit = 150; rerender(); break;
    case "plYl": S.pl.yl = b.getAttribute("data-v"); S.pl.limit = 150; rerender(); break;
    case "plReset":
      S.pl.ks = []; S.pl.kmode = "any"; S.pl.f = "all"; S.pl.team = ""; S.pl.q = "";
      PL_MORE.forEach(function (k) { S.pl[k] = ""; }); S.pl.ss = 0; S.pl.limit = 150; rerender(); break;
    case "sView": S.sview = b.getAttribute("data-v"); rerender(); break;
    case "stView": S.st.view = b.getAttribute("data-v"); rerender(); break;
    case "stFilter": S.st.f = b.getAttribute("data-v"); S.st.limit = 100; rerender(); break;
    case "stPer": S.st.per = b.getAttribute("data-v"); rerender(); break;
    case "stQual": S.st.qual = !S.st.qual; S.st.limit = 100; rerender(); break;
    case "stMore": S.st.limit += 100; $("stTable").innerHTML = statTable(); break;
    case "plMore": S.pl.limit += 150; $("plTable").innerHTML = plTable(); break;
    case "logMore": S.lg.n += 100; $("logList").innerHTML = logList(); break;

    case "toResult": window.scrollTo(0, $("tradeResult").getBoundingClientRect().top + window.scrollY - 70); break;
    case "tradeToggle":
      var code = b.getAttribute("data-code"), at = S.trade.teams.indexOf(code);
      if (at >= 0) S.trade.teams.splice(at, 1); else if (S.trade.teams.length < 4) S.trade.teams.push(code);
      tradeChanged(); break;
    case "tradeRemove": S.trade.teams = S.trade.teams.filter(function (c) { return c !== b.getAttribute("data-code"); }); tradeChanged(); break;
    case "tradeAsset": case "tradeDest":
      var ty = b.getAttribute("data-type"), ky = b.getAttribute("data-key"), fr = b.getAttribute("data-from"), cur = moveOf(ty, ky, fr);
      if (act === "tradeDest") { if (cur) cur.to = b.getAttribute("data-to"); }
      else if (cur) S.trade.moves.splice(S.trade.moves.indexOf(cur), 1);
      else {
        var dest = S.trade.teams.filter(function (c) { return c !== fr; })[0];
        if (!dest) { toast("Add another team to the trade first", true); break; }
        var mv = { type: ty, from: fr, to: dest }; mv[ty === "player" ? "name" : "label"] = ky; S.trade.moves.push(mv);
      }
      tradeChanged(); break;
    case "clearTrade": S.trade = { teams: [], moves: [] }; tradeChanged(); break;
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
    case "adminTab": A.tab = b.getAttribute("data-v"); A.edit = null; rerender(); window.scrollTo(0, 0); break;
    case "edit":
      var id = Number(b.getAttribute("data-id"));
      A.edit = editable(S.L.contracts.filter(function (c) { return c.id === id; })[0], b.getAttribute("data-mode")); rerender(); window.scrollTo(0, $("editor").offsetTop - 70); break;
    case "fullEdit": A.edit.mode = "full"; rerender(); break;
    case "setStat":
      var box2 = b.closest(".stchips"), sea = b.closest(".sea");
      box2.querySelector("input").value = b.getAttribute("data-v");
      Array.prototype.forEach.call(box2.querySelectorAll(".stc"), function (x) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
      if (sea) sea.className = "sea m-" + statKind(b.getAttribute("data-v"));
      break;
    case "newContract": A.edit = { id: null, n: "", nba: "", sal: [], st: [], det: "", orig: [], mode: "full" }; rerender(); break;
    case "cancelEdit": A.edit = null; rerender(); break;
    case "saveContract":
      if (A.edit.mode === "restructure") {
        var ed2 = $("editor"), rr = rosterIdx()[LM.norm(A.edit.n)];
        var rs = { id: A.edit.id, team: rr ? rr.code : "",
          sal: S.L.seasons.map(function (_, i) { var el = ed2.querySelector('[data-sal="' + i + '"]'); return el ? el.value.trim() : undefined; }),
          st: S.L.seasons.map(function (_, i) { var el = ed2.querySelector('[data-stat="' + i + '"]'); return el ? el.value : undefined; }) };
        busy(b, adminCall([["restructure", rs]], function (r) { return r.logs[0]; }).then(function () { A.edit = null; rerender(); }));
        break;
      }
      var ed = $("editor"), c = {
        id: A.edit.id, n: val("n").trim(), nba: val("nba").trim().toUpperCase(), det: val("det"),
        sal: S.L.seasons.map(function (_, i) { var el = ed.querySelector('[data-sal="' + i + '"]'); return el ? el.value.trim() : A.edit.sal[i]; }),
        st: S.L.seasons.map(function (_, i) { var el = ed.querySelector('[data-stat="' + i + '"]'); return el ? el.value : A.edit.st[i]; }),
      };
      busy(b, adminCall([["saveContract", c]], "Contract saved").then(function () { A.edit = null; rerender(); }));
      break;
    case "deleteContract":
      busy(b, adminCall([["deleteContract", { id: A.edit.id }]], "Contract deleted").then(function () { A.edit = null; rerender(); }));
      break;
    case "extend":
      var ec = contractByName(val("extName"));
      if (!ec) { toast("Pick a player who's on the contracts list", true); break; }
      busy(b, adminCall([["extend", { id: ec.id, years: Number(val("extYears")), amt: val("extAmt"), st: val("extSt") }]],
        function (r) { return r.logs[0]; }).then(function () { S.admin.ext = null; rerender(); }));
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
    case "cashAdj":
      var cc = b.getAttribute("data-code"), camt = Number((view().querySelector('[data-cash-amt="' + cc + '"]') || {}).value);
      if (!(camt > 0)) { toast("Enter an amount in $M first", true); break; }
      busy(b, adminCall([["adjustCash", { code: cc, season: A.cashSeason || S.L.season, amt: camt, dir: b.getAttribute("data-dir"), override: val("cashOverride") }]],
        function (r) { return r.logs[0]; }).then(rerender));
      break;
    case "resetCash":
      busy(b, adminCall([["resetCash", { season: A.cashSeason || S.L.season }]], function (r) { return r.logs[0]; }).then(rerender));
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
  else if (act === "plTeam") { S.pl.team = t.value; S.pl.limit = 150; $("plTable").innerHTML = plTable(); }
  else if (act === "logTeam") { S.lg.team = t.value; S.lg.n = 100; $("logList").innerHTML = logList(); }
  else if (act === "logType") { S.lg.type = t.value; S.lg.n = 100; $("logList").innerHTML = logList(); }
});

// the Contracts filter menu closes on a click outside it or Escape
document.addEventListener("click", function (ev) {
  if (!S.pl.more || !document.querySelector(".fmenu")) return;
  var t = ev.target;
  if (t.closest && (t.closest(".fmenu") || t.closest(".morebtn") || t.closest(".dd-menu"))) return;
  if (!document.body.contains(t)) return;   // a button inside the menu that just re-rendered
  S.pl.more = false; rerender();
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape" && S.pl.more && document.querySelector(".fmenu")) { S.pl.more = false; rerender(); }
});
var inputTimer = null;
document.addEventListener("focusin", function (ev) { if (ev.target.classList && ev.target.classList.contains("pp-in")) ppRender(ev.target); });
document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t.classList && t.classList.contains("pp-in")) ppRender(t);
  if (t.id === "stq") { clearTimeout(inputTimer); inputTimer = setTimeout(function () { S.st.q = t.value; S.st.limit = 100; $("stTable").innerHTML = statTable(); }, 120); }
  else if (t.getAttribute && t.getAttribute("data-pf")) { clearTimeout(inputTimer); inputTimer = setTimeout(function () {
    S.pl[t.getAttribute("data-pf")] = t.value.trim(); S.pl.limit = 150; plRefresh(); }, 200); }
  else if (t.id === "plq") { clearTimeout(inputTimer); inputTimer = setTimeout(function () { S.pl.q = t.value; S.pl.limit = 150; $("plTable").innerHTML = plTable(); }, 120); }
  else if (t.id === "extName" || t.id === "extAmt") { clearTimeout(inputTimer); inputTimer = setTimeout(function () {
    refreshExt(); }, 150); }
  else if (t.id === "cq") { clearTimeout(inputTimer); inputTimer = setTimeout(function () {
    S.admin.q = t.value; $("cList").innerHTML = S.admin.q.trim() ? contractList(contractSearch(S.admin.q), "restructure") : '<div class="empty">Search to edit or delete a contract.</div>'; }, 120); }
});

document.addEventListener("submit", function (ev) {
  if (ev.target.id !== "loginForm") return;
  ev.preventDefault();
  var btn = ev.target.querySelector("button");
  busy(btn, Admin.signIn($("pass").value).then(function (who) { toast("Signed in as " + who); rerender(); },
    function (e) { $("loginMsg").textContent = e.message; }));
});

// A headshot that fails to load becomes initials
document.addEventListener("error", function (ev) {
  var t = ev.target;
  if (t && t.tagName === "IMG" && t.classList.contains("av")) {
    var sp = document.createElement("span"); sp.className = "av"; sp.textContent = t.getAttribute("data-ini") || ""; t.replaceWith(sp);
  }
}, true);

// Hover tooltips for chart marks (data-tip)
(function () {
  var tip = null;
  document.addEventListener("mousemove", function (ev) {
    var el = ev.target.closest && ev.target.closest("[data-tip]");
    if (!el) { if (tip) tip.style.display = "none"; return; }
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip); }
    tip.textContent = el.getAttribute("data-tip");
    tip.style.display = "";
    var x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + "px"; tip.style.top = (ev.clientY + 16) + "px";
  });
})();

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape" && document.querySelector(".dd.open")) { var d = document.querySelector(".dd.open"); closeMenus(); d.querySelector(".dd-btn").focus(); return; }
  if (ev.key === "Escape" && $("modal").classList.contains("open")) closePlayer();
  // player picker: arrows move into / through the suggestions, Escape closes them
  var ppIn = document.activeElement && document.activeElement.closest && document.activeElement.closest(".pp");
  if (ppIn) {
    var pm = ppIn.querySelector(".pp-menu");
    if (ev.key === "Escape") { ppClose(); ppIn.querySelector(".pp-in").focus(); return; }
    if (!pm.hidden && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      var po = Array.prototype.slice.call(pm.querySelectorAll(".pp-opt")), pi = po.indexOf(document.activeElement);
      var nx = ev.key === "ArrowDown" ? po[Math.min(po.length - 1, pi + 1)] : pi <= 0 ? ppIn.querySelector(".pp-in") : po[pi - 1];
      if (nx) { nx.focus(); ev.preventDefault(); }
      return;
    }
    if (ev.key === "Enter" && document.activeElement.classList.contains("pp-in") && !pm.hidden) {
      var first = pm.querySelector(".pp-opt"); if (first) { first.click(); ev.preventDefault(); }
      return;
    }
  }
  // arrow keys move through an open menu
  var menu = document.querySelector(".dd.open .dd-menu");
  if (menu && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
    var opts = Array.prototype.slice.call(menu.querySelectorAll(".dd-opt")), i = opts.indexOf(document.activeElement);
    var n = opts[Math.max(0, Math.min(opts.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))];
    if (n) { n.focus(); ev.preventDefault(); }
  }
});

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
