/* ============================ salary planner ============================ */
// "What if" payroll for one team, season by season: decline team or player options, re-sign
// players whose deals run out, trade players away, add players (with their real contracts) or
// make up a signing. Nothing here changes league data; the plan lives in the URL (#plan/CODE/...)
// so it can be shared like a trade.
//
// Plan state (all keyed by contract id):
//   o: { id: i }        option at season index i declined (that season and later come off)
//   r: { id: [sal, yrs] } re-signed from his first free-agent season (or the declined one)
//   x: [id]             traded away (all his money leaves)
//   a: [id]             added with his real contract
//   s: [[name, sal, yrs, start]]  made-up signings
PAGES.plan = pagePlan;
var PLAN_FA = { cap: "Any offer", first: "Up to 75% of a max", second: "Minimums only", tax: "Can't sign free agents", over: "Over the hard cap" };

function planEmpty(code) { return { code: code, o: {}, r: {}, x: [], a: [], s: [] }; }
function planEncode(P) {
  var o = { o: P.o, r: P.r, x: P.x, a: P.a, s: P.s }, empty = !Object.keys(P.o).length && !Object.keys(P.r).length && !P.x.length && !P.a.length && !P.s.length;
  return "plan/" + P.code + (empty ? "" : "/" + encodeURIComponent(JSON.stringify(o)));
}
function planDecode(code, s) {
  var P = planEmpty(code);
  if (!s) return P;
  try {
    var o = JSON.parse(decodeURIComponent(s));
    ["o", "r"].forEach(function (k) { if (o[k] && typeof o[k] === "object") P[k] = o[k]; });
    ["x", "a"].forEach(function (k) { if (Array.isArray(o[k])) P[k] = o[k].map(Number).filter(isFinite); });
    if (Array.isArray(o.s)) P.s = o.s.filter(function (x) { return Array.isArray(x) && x.length === 4; });
  } catch (e) { /* bad link: start clean */ }
  return P;
}
function planSave() { Nav.quiet(planEncode(S.plan)); S.planShare = null; }
function planContract(id) { return S.L.contracts.filter(function (c) { return c.id === Number(id); })[0] || null; }
function planN() { return S.L.seasons.length; }
function seasonOf(i) { return S.L.seasons[i] || ""; }

// The season he becomes a free agent in the plan: the declined option, else his first RFA/UFA season
function planFaIdx(c, P) {
  if (P.o[c.id] != null) return Number(P.o[c.id]);
  for (var i = 0; i < c.sal.length; i++) if (typeof c.sal[i] === "string" && c.sal[i]) return i;
  return -1;
}
function isOpt(c, i) { var s = String(c.st[i] || "").toUpperCase(); return (s === "TO" || s === "PO") && typeof c.sal[i] === "number"; }
// Planned money for one contract, season by season (numbers), plus what to show in each cell
function planLine(c, P) {
  var n = planN(), sal = [], cells = [], fa = planFaIdx(c, P), re = P.r[c.id], dec = P.o[c.id] != null ? Number(P.o[c.id]) : -1;
  for (var i = 0; i < n; i++) {
    var orig = typeof c.sal[i] === "number" ? c.sal[i] : 0, v = orig, html = salCell(c, i), chg = false;
    var inRe = re && fa >= 0 && i >= fa && i < fa + Number(re[1]);
    if (inRe) {
      v = Number(re[0]); chg = true;
      html = '<span class="mny m-g">' + money(v) + "<em>RE</em></span>" + (i === fa ? '<button class="plx" data-act="planUnRe" data-id="' + c.id + '" title="Undo the re-signing">undo</button>' : "");
    } else if (dec >= 0 && i >= dec) {
      v = 0; chg = orig !== 0;
      html = i === dec ? '<span class="fa m-ufa">Declined</span><button class="plx" data-act="planOpt" data-id="' + c.id + '" data-i="' + i + '" title="Pick the option back up">undo</button>' +
        '<button class="plx go" data-act="planRe" data-id="' + c.id + '">re-sign</button>' : "";
    } else if (isOpt(c, i)) {
      html += '<button class="plx" data-act="planOpt" data-id="' + c.id + '" data-i="' + i + '">decline</button>';
    } else if (i === fa && !re) {
      html += '<button class="plx go" data-act="planRe" data-id="' + c.id + '">re-sign</button>';
    } else if (re && i >= fa) { v = 0; html = ""; chg = typeof c.sal[i] === "number"; }
    sal.push(v); cells.push({ html: html, chg: chg });
  }
  return { sal: sal, cells: cells };
}
function madeUpLine(s) {
  var n = planN(), sal = [], cells = [];
  for (var i = 0; i < n; i++) {
    var on = i >= Number(s[3]) && i < Number(s[3]) + Number(s[2]);
    sal.push(on ? Number(s[1]) : 0);
    cells.push({ html: on ? '<span class="mny m-g">' + money(Number(s[1])) + "<em>NEW</em></span>" : "", chg: on });
  }
  return { sal: sal, cells: cells };
}

// Everything the page needs: rows by group, payroll by season (now and planned), maxes by season
function planBook(P) {
  var b = book(P.code), n = planN(), now = b.payroll.slice(), pay = new Array(n).fill(0), rows = { keep: [], out: [], add: [], holds: [] };
  var maxes = new Array(n).fill(0), smaxes = new Array(n).fill(0), count = new Array(n).fill(0);
  var tally = function (line, c) {
    line.sal.forEach(function (v, i) {
      pay[i] += v;
      if (v > 0) count[i]++;
      var s = c ? String(c.st[i] || "").toUpperCase() : "";
      if (v > 0 && s === "MAX" && !line.cells[i].chg) maxes[i]++;
      if (v > 0 && s === "SMAX" && !line.cells[i].chg) smaxes[i]++;
    });
  };
  b.players.forEach(function (p) {
    if (!p.c) { rows.keep.push({ name: p.name, slot: p.slot, line: { sal: new Array(n).fill(0), cells: new Array(n).fill({ html: "", chg: false }) }, noc: true }); return; }
    if (P.x.indexOf(p.c.id) >= 0) { rows.out.push({ name: p.name, c: p.c, slot: p.slot }); return; }
    var line = planLine(p.c, P);
    tally(line, p.c);
    rows.keep.push({ name: p.name, c: p.c, slot: p.slot, line: line });
  });
  P.a.forEach(function (id) {
    var c = planContract(id);
    if (!c) return;
    var line = planLine(c, P);
    tally(line, c);
    rows.add.push({ name: c.n, c: c, line: line });
  });
  P.s.forEach(function (s, k) { var line = madeUpLine(s); tally(line, null); rows.add.push({ name: s[0], made: k, line: line }); });
  b.holds.forEach(function (h) {
    var sal = h.c ? h.c.sal.map(function (v) { return typeof v === "number" ? v : 0; }) : new Array(n).fill(0);
    sal.forEach(function (v, i) { pay[i] += v; });
    rows.holds.push({ name: h.name, c: h.c });
  });
  pay[0] += b.cash;
  return { b: b, rows: rows, now: now, pay: pay.map(LM.r1), maxes: maxes, smaxes: smaxes, count: count };
}

// Plain-English list of the moves, each with an undo
function planMoves(P) {
  var out = [];
  Object.keys(P.o).forEach(function (id) {
    var c = planContract(id), i = Number(P.o[id]);
    if (c) out.push(["planOpt", 'data-id="' + c.id + '" data-i="' + i + '"', "Decline " + esc(plain(c.n)) + "'s " + (String(c.st[i]).toUpperCase() === "PO" ? "player" : "team") + " option (" + esc(seasonOf(i)) + ")"]);
  });
  Object.keys(P.r).forEach(function (id) {
    var c = planContract(id), r = P.r[id];
    if (c) out.push(["planUnRe", 'data-id="' + c.id + '"', "Re-sign " + esc(plain(c.n)) + ": " + money(Number(r[0])) + "M × " + r[1] + (Number(r[1]) === 1 ? " year" : " years") + " from " + esc(seasonOf(planFaIdx(c, P)))]);
  });
  P.x.forEach(function (id) { var c = planContract(id); if (c) out.push(["planX", 'data-id="' + c.id + '"', "Trade away " + esc(plain(c.n))]); });
  P.a.forEach(function (id) { var c = planContract(id); if (c) out.push(["planUnAdd", 'data-id="' + c.id + '"', "Add " + esc(plain(c.n)) + " (his current contract)"]); });
  P.s.forEach(function (s, k) {
    out.push(["planUnSign", 'data-k="' + k + '"', "Sign " + esc(s[0]) + ": " + money(Number(s[1])) + "M × " + s[2] + (Number(s[2]) === 1 ? " year" : " years") + " from " + esc(seasonOf(Number(s[3])))]);
  });
  return out;
}

function planRow(r, P, kind) {
  var c = r.c, act = "";
  if (kind === "keep" && c) act = '<button class="plx" data-act="planX" data-id="' + c.id + '" title="Take him and his salary off the books">trade away</button>';
  if (kind === "add") act = r.made != null ? '<button class="plx" data-act="planUnSign" data-k="' + r.made + '">remove</button>' : '<button class="plx" data-act="planUnAdd" data-id="' + c.id + '">remove</button>';
  var tds = r.line.cells.map(function (x) { return '<td class="' + (x.chg ? "pchg" : "") + '">' + x.html + "</td>"; }).join("");
  var html = '<tr><td class="name">' + pwho(r.name) + (r.noc ? '<span class="flag bad">No contract</span>' : "") + '</td><td class="l muted">' + esc(c ? c.nba : "") + "</td>" + tds + '<td class="l">' + act + "</td></tr>";
  if (c && S.planEdit === c.id) html += planEditor(c, P);
  return html;
}
function planEditor(c, P) {
  var fa = planFaIdx(c, P), n = planN(), left = Math.min(5, n - fa), last = 0;
  for (var i = fa - 1; i >= 0; i--) if (typeof c.sal[i] === "number") { last = c.sal[i]; break; }
  var yrs = ""; for (var y = 1; y <= left; y++) yrs += '<option value="' + y + '"' + (y === Math.min(3, left) ? " selected" : "") + ">" + y + (y === 1 ? " year" : " years") + "</option>";
  return '<tr class="pedit"><td colspan="' + (n + 3) + '"><div class="row start" style="gap:8px;flex-wrap:wrap">' +
    "<b>Re-sign " + esc(plain(c.n)) + " from " + esc(seasonOf(fa)) + "</b>" +
    '<label class="pin">$<input type="number" id="planReSal" min="0" step="0.5" value="' + (last || 2) + '">M a year</label>' +
    '<select id="planReYrs" aria-label="Years">' + yrs + "</select>" +
    '<button class="btn pri" data-act="planReSave" data-id="' + c.id + '">Save</button><button class="btn" data-act="planReCancel">Cancel</button></div></td></tr>';
}
function planSearchHits(q) {
  var P = S.plan, qn = LM.norm(q);
  if (qn.length < 2) return "";
  var mine = {};
  book(P.code).players.forEach(function (p) { if (p.c) mine[p.c.id] = 1; });
  P.a.forEach(function (id) { mine[id] = 1; });
  var idx = rosterIdx();
  var hits = S.L.contracts.filter(function (c) { return !c.hold && !mine[c.id] && LM.norm(c.n).indexOf(qn) >= 0; }).slice(0, 8);
  if (!hits.length) return '<div class="muted small" style="padding:8px 2px">No contract matches. Use "Made-up signing" for anyone else.</div>';
  return hits.map(function (c) {
    var r = idx[LM.norm(c.n)];
    return '<button class="phit" data-act="planAdd" data-id="' + c.id + '">' + avatar(c.n) + '<span class="nm"><b>' + esc(plain(c.n)) + '</b><span class="muted small">' + esc(c.nba || "") +
      " · " + (r ? esc(teamName(r.code)) : "free agent") + "</span></span>" + salCell(c, 0) + "</button>";
  }).join("");
}

function pagePlan(arg) {
  var L = S.L, i = arg.indexOf("/"), code = (i < 0 ? arg : arg.slice(0, i)).toUpperCase(), rest = i < 0 ? "" : arg.slice(i + 1);
  var t = LM.teamByCode(L, code) || L.teams[0];
  if (!S.plan || S.plan.code !== t.code || rest) S.plan = planDecode(t.code, rest);
  var P = S.plan, B = planBook(P), n = planN(), lim = L.limits;
  var head = '<div class="pagehead team-banner"' + teamStyle(t.code) + '><div class="tm"><div class="badge-team">' + esc(t.code) + "</div><div><h1>Salary planner</h1>" +
    '<div class="sub">' + esc(t.name) + " · try moves and see payroll by season. Nothing here changes the league.</div></div></div>" +
    dropdown("planTeam", t.code, teamItems(), "Team", "on-banner") + "</div>";

  // headline: next season (the offseason this is mostly for), now vs planned
  var k = n > 1 ? 1 : 0, d = LM.r1(B.pay[k] - B.now[k]);
  var hero = '<div class="box paybox"><div class="team-hero"><div><div class="pay-k">Planned payroll ' + esc(seasonOf(k)) + "</div>" +
    '<div class="big">' + money(B.pay[k]) + "<small>M</small></div>" +
    '<div style="margin-top:8px" class="row start">' + tierChip(B.pay[k]) +
    (d ? '<span class="pdelta ' + (d < 0 ? "save" : "add") + '">' + (d < 0 ? "saves " : "adds ") + money(Math.abs(d)) + "M</span>" : '<span class="muted small">no change yet</span>') +
    '<span class="muted small">now ' + money(B.now[k]) + "M</span></div></div>" +
    "<div>" + meter(B.pay[k], true) + meterScale() + "</div></div></div>";

  var moves = planMoves(P);
  var movesBox = '<div class="box"><div class="panel-head"><h3>Moves</h3>' +
    (moves.length ? '<div class="row start" style="gap:8px"><button class="btn" data-act="planShare">Copy share link</button><button class="btn" data-act="planClear">Start over</button></div>' : "") + "</div>" +
    (moves.length ? '<ul class="pmoves">' + moves.map(function (m) { return "<li><span>" + m[2] + '</span><button class="plx" data-act="' + m[0] + '" ' + m[1] + ">undo</button></li>"; }).join("") + "</ul>"
      : '<p class="muted small" style="margin:0">Use the buttons in the table: <b>decline</b> on a team or player option, <b>re-sign</b> on a player whose deal runs out, <b>trade away</b> to take a salary off. Add players below.</p>') +
    (S.planShare ? '<label class="f" style="margin-top:10px">Share link<input type="text" readonly id="planShareUrl" value="' + esc(S.planShare) + '"></label>' : "") + "</div>";

  var seasonsTh = L.seasons.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("");
  var cols = n + 3, grp = function (label, len) { return '<tr class="grp"><td colspan="' + cols + '"><span class="gl">' + label + " · " + len + "</span></td></tr>"; };
  var body = "";
  ["starters", "bench", "ir", "taxi"].forEach(function (slot) {
    var ps = B.rows.keep.filter(function (r) { return r.slot === slot; });
    if (ps.length) body += grp(SLOT[slot], ps.length) + ps.map(function (r) { return planRow(r, P, "keep"); }).join("");
  });
  if (B.rows.add.length) body += grp("Added", B.rows.add.length) + B.rows.add.map(function (r) { return planRow(r, P, "add"); }).join("");
  if (B.rows.holds.length) body += grp("Cap holds", B.rows.holds.length) + B.rows.holds.map(function (h) {
    return '<tr><td class="name">' + pwho(h.name) + '</td><td class="l muted">' + esc(h.c ? h.c.nba : "") + "</td>" + L.seasons.map(function (_, i) { return "<td>" + salCell(h.c, i) + "</td>"; }).join("") + "<td></td></tr>";
  }).join("");
  if (B.rows.out.length) body += grp("Traded away", B.rows.out.length) + B.rows.out.map(function (r) {
    return '<tr class="pout"><td class="name">' + pwho(r.name) + '</td><td class="l muted">' + esc(r.c.nba) + "</td>" + L.seasons.map(function (_, i) { return "<td>" + salCell(r.c, i) + "</td>"; }).join("") +
      '<td class="l"><button class="plx" data-act="planX" data-id="' + r.c.id + '">bring back</button></td></tr>';
  }).join("");
  var row = function (label, f, cl) { return "<tr" + (cl ? ' class="' + cl + '"' : "") + "><td>" + label + "</td><td></td>" + B.pay.map(f).join("") + "<td></td></tr>"; };
  body += '<tr class="grp"><td colspan="' + cols + '"><span class="gl">Totals</span></td></tr>' +
    (B.b.cash ? row("Cash considerations", function (_, i) { return '<td class="' + (i === 0 ? cls(B.b.cash) : "") + '">' + (i === 0 ? signed(B.b.cash) : "") + "</td>"; }) : "") +
    row("Planned payroll", function (v) { return '<td class="tot t-' + LM.tierOf(v).key + '">' + money(v) + "</td>"; }, "total") +
    row("Change", function (v, i) { var x = LM.r1(v - B.now[i]); return '<td class="' + (x < 0 ? "psave" : x > 0 ? "padd" : "dim") + '">' + (x ? signed(x) : "—") + "</td>"; }) +
    row("Level", function (v) { return "<td>" + tierChip(v) + "</td>"; }) +
    row("Free agents", function (v) { return '<td class="small">' + esc(PLAN_FA[LM.tierOf(v).key]) + "</td>"; }) +
    row("Room to $150M", function (v) { return '<td class="' + cls(150 - v) + '">' + money(150 - v) + "</td>"; }) +
    row("Room to $" + lim.hardCap + "M max", function (v) { return '<td class="' + cls(lim.hardCap - v) + '">' + money(lim.hardCap - v) + "</td>"; }) +
    row("Players under contract", function (_, i) { return "<td>" + B.count[i] + "</td>"; }) +
    row("Max deals", function (_, i) {
      var ok = LM.maxComboOk(B.maxes[i], B.smaxes[i], lim.maxCombos);
      return '<td class="' + (ok ? "" : "neg") + '" title="Allowed: ' + esc(LM.maxCombosText(lim.maxCombos)) + '">' + B.maxes[i] + " / " + B.smaxes[i] + (ok ? "" : " ⚠") + "</td>";
    });
  var table = '<div class="tbl"><table class="teamtbl plantbl"><tr><th>Player</th><th class=l>NBA</th>' + seasonsTh + '<th class="l"></th></tr>' + body + "</table></div>" +
    '<p class="muted small" style="margin:8px 2px 0">Max deals: max / supermax under contract. Re-signings and made-up signings count as regular deals.</p>';

  var yrs = "", starts = "";
  for (var y = 1; y <= 5; y++) yrs += '<option value="' + y + '"' + (y === 1 ? " selected" : "") + ">" + y + (y === 1 ? " year" : " years") + "</option>";
  L.seasons.forEach(function (s, i) { starts += '<option value="' + i + '"' + (i === k ? " selected" : "") + ">from " + esc(s) + "</option>"; });
  var addBox = '<div class="pgrid"><div class="box"><h3>Add a player</h3><p class="muted small" style="margin:0 0 8px">Anyone with a contract, from any team or free agency. He comes with his current deal.</p>' +
    '<div class="search"><input type="search" id="planq" placeholder="Search players" autocomplete="off" aria-label="Search players"></div><div id="planHits" class="phits"></div></div>' +
    '<div class="box"><h3>Made-up signing</h3><p class="muted small" style="margin:0 0 8px">A free agent or a draft pick, at any salary. The minimum is $2M for 1 year.</p>' +
    '<div class="row start" style="gap:8px;flex-wrap:wrap"><input type="text" id="planSignName" placeholder="Name" style="flex:1 1 140px">' +
    '<label class="pin">$<input type="number" id="planSignSal" min="0" step="0.5" value="2">M</label>' +
    '<select id="planSignYrs" aria-label="Years">' + yrs + '</select><select id="planSignFrom" aria-label="Starting season">' + starts + "</select>" +
    '<button class="btn pri" data-act="planSign">Add</button></div></div></div>';

  return head + hero + movesBox + addBox + '<div style="height:10px"></div>' + moneyLegend() + '<div style="height:10px"></div>' + table;
}

function planRerender() { planSave(); rerender(); }
document.addEventListener("click", function (ev) {
  var b = ev.target.closest && ev.target.closest("button[data-act^=plan]");
  if (!b || !S.plan) return;
  var P = S.plan, act = b.getAttribute("data-act"), id = Number(b.getAttribute("data-id")), c;
  var drop = function (arr, v) { var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
  if (act === "planOpt") {
    var i = Number(b.getAttribute("data-i"));
    if (P.o[id] != null && Number(P.o[id]) === i) delete P.o[id]; else P.o[id] = i;
    delete P.r[id];   // the free-agent season moved, so any re-signing starts over
    S.planEdit = null; planRerender();
  } else if (act === "planRe") { S.planEdit = id; rerender(); }
  else if (act === "planReCancel") { S.planEdit = null; rerender(); }
  else if (act === "planReSave") {
    var sal = Number(document.getElementById("planReSal").value), yrs = Number(document.getElementById("planReYrs").value);
    if (!(sal > 0) || !(yrs > 0)) { toast("Enter a salary above $0", true); return; }
    P.r[id] = [LM.r1(sal), yrs]; S.planEdit = null; planRerender();
  } else if (act === "planUnRe") { delete P.r[id]; planRerender(); }
  else if (act === "planX") { if (P.x.indexOf(id) >= 0) drop(P.x, id); else { P.x.push(id); delete P.o[id]; delete P.r[id]; } planRerender(); }
  else if (act === "planAdd") { if (P.a.indexOf(id) < 0) P.a.push(id); planRerender(); }
  else if (act === "planUnAdd") { drop(P.a, id); delete P.o[id]; delete P.r[id]; planRerender(); }
  else if (act === "planSign") {
    var nm = document.getElementById("planSignName").value.trim(), s = Number(document.getElementById("planSignSal").value);
    var y = Number(document.getElementById("planSignYrs").value), from = Number(document.getElementById("planSignFrom").value);
    if (!nm) { toast("Give the signing a name", true); return; }
    if (!(s > 0)) { toast("Enter a salary above $0", true); return; }
    P.s.push([nm.slice(0, 40), LM.r1(s), Math.min(y, planN() - from), from]); planRerender();
  } else if (act === "planUnSign") { P.s.splice(Number(b.getAttribute("data-k")), 1); planRerender(); }
  else if (act === "planClear") { S.plan = planEmpty(P.code); S.planEdit = null; planRerender(); }
  else if (act === "planShare") {
    S.planShare = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(S.planShare).then(function () { toast("Link copied"); }, function () {});
    rerender();
  }
});
var planTimer;
document.addEventListener("input", function (ev) {
  if (ev.target.id !== "planq") return;
  var q = ev.target.value;
  clearTimeout(planTimer);
  planTimer = setTimeout(function () { var h = document.getElementById("planHits"); if (h) h.innerHTML = planSearchHits(q); }, 120);
});
