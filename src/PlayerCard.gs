/******************************************************************
 * Player Cards
 *
 * A web app (this project's doGet) that shows a full player card:
 *   Game log · Transactions · Contract · Stats / advanced / bio
 * plus the code that turns player names in the workbook into links
 * to that card.
 *
 * Data:
 *   - Contract ......... Master list (this workbook)
 *   - Fantasy team ..... Sleeper rosters (live) + Team Map
 *   - Transactions ..... Sleeper transactions, this season + 2 before
 *   - Game log/stats ... ESPN (unofficial endpoints; may change)
 *   - Bio .............. ESPN team rosters
 *   - Fantasy points ... computed from the Sleeper league's scoring settings
 *
 * Setup (once):
 *   1. Deploy > New deployment > Web app.
 *      Execute as: Me.  Who has access: Anyone (or "Anyone with a Google account").
 *   2. Copy the /exec URL, then in the sheet: Sync League > Set player card link…
 *   3. Sync League > Refresh player links now.
 *   After that the sync keeps links up to date (Rosters every sync,
 *   team tabs + Master list hourly, and any name you type right away).
 ******************************************************************/

const SPREADSHEET_ID = "1I6FEq2JzPKhADk_THPyYe5SX0PkPH-MCniz9-AmDgV4";
const SALARY_CAP = 150;           // normal cap in $M (Rules sheet)
// site.api.espn.com returns 403 to Google's servers; the site.web host works
const ESPN_SITE = "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba";
const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";
const ESPN_FIX_SHEET = "ESPN ID Fixes"; // optional: Name | ESPN id, for names that don't match
const LINK_EVERY_MIN = 60;        // full link pass on team tabs + Master list
const TEAM_TAB_SLOTS = ["pg", "sg", "sf", "pf", "c", "g", "f", "util", "bench", "ir", "taxi", "cap hold"];

/* ============================ Web app ============================ */

function doGet(e) {
  const t = HtmlService.createTemplateFromFile("CardPage");
  const q = (e && e.parameter && e.parameter.n) || "";
  t.startJson = JSON.stringify(String(q)).replace(/</g, "\\u003c");
  t.modeJson = JSON.stringify("page");
  return t.evaluate()
    .setTitle("Player card")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/* ------------------------ Popup in the sheet -------------------- */

// Opens a floating card window over the sheet (computer only; the Sheets
// phone app can't show popups). While it's open, clicking a player name
// on Rosters, Master list or a team tab loads that player.
function showPlayerPopup() {
  const t = HtmlService.createTemplateFromFile("CardPage");
  t.startJson = JSON.stringify(getSelectedPlayer().name || "").replace(/</g, "\\u003c");
  t.modeJson = JSON.stringify("popup");
  const html = t.evaluate().setWidth(480).setHeight(680);
  SpreadsheetApp.getUi().showModelessDialog(html, "Player card");
}

// Called by the "on open" trigger. Wrapped so a phone open (no popups) can't error.
function autoOpenPopup() {
  try { showPlayerPopup(); } catch (e) { console.log("Popup on open skipped: " + e); }
}

// Google's built-in onOpen isn't allowed to show popups, but an installable
// on-open trigger is. These turn that trigger on/off.
function turnOnPopupOnOpen() {
  turnOffPopupOnOpen_(true);
  ScriptApp.newTrigger("autoOpenPopup").forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onOpen().create();
  SpreadsheetApp.getActiveSpreadsheet().toast("The player popup will open whenever you open this sheet.", "Player cards", 6);
}

function turnOffPopupOnOpen() { turnOffPopupOnOpen_(false); }

function turnOffPopupOnOpen_(quiet) {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "autoOpenPopup") ScriptApp.deleteTrigger(t);
  });
  if (!quiet) SpreadsheetApp.getActiveSpreadsheet().toast("Popup on open turned off.", "Player cards", 5);
}

// The popup asks this about once a second: which player is selected?
function getSelectedPlayer() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const cell = sh.getCurrentCell();
  if (!cell) return { name: "" };
  const tab = sh.getName(), r = cell.getRow(), c = cell.getColumn();
  const key = `${tab}!${r}!${c}`;
  if (r < 2) return { key, name: "" };
  const text = String(cell.getDisplayValue() || "").trim();
  if (!text) return { key, name: "" };
  let ok = false;
  if (tab === SHEETS.rosters) ok = true;
  else if (tab === SHEETS.master) ok = c === 1 && !/pending/i.test(text);
  else if (Object.values(TEAM_CODES).indexOf(tab) >= 0 && c === 2) {
    const slot = String(sh.getRange(r, 1).getDisplayValue()).trim().toLowerCase();
    ok = TEAM_TAB_SLOTS.indexOf(slot) >= 0;
  }
  return { key, name: ok ? cleanName_(text) : "" };
}

function openSs_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/* ------------------------- Called by page ------------------------ */

// Header + contract (all from the workbook / cached lookups, so it's fast).
function getCard(raw) {
  const ss = openSs_();
  const clean = cleanName_(raw);
  const key = norm_(clean);
  if (!key) return { found: false, query: String(raw || "") };

  const plyrs = playersTable_(ss);
  const rostered = liveRosters_();
  const master = masterRows_(ss, key);

  // Sleeper id: prefer someone on a league roster, then someone on an NBA team
  const cands = plyrs.byKey[key] || [];
  const pick = cands.find(c => rostered.byPid[c.id]) || cands.find(c => c.team) || cands[0] || null;
  const sleeperId = pick ? pick.id : null;
  const nbaTeamGuess = (pick && fixAbbr_(pick.team)) || (master.rows[0] && master.rows[0].team) || "";

  const espn = findEspn_(ss, key, nbaTeamGuess);

  let fantasy = null;
  if (sleeperId && rostered.byPid[sleeperId]) {
    const r = rostered.byPid[sleeperId];
    const tm = readTeamMap_(ss)[r.rid] || {};
    fantasy = { team: tm.team || `Roster ${r.rid}`, owner: tm.owner || "", code: tm.code || "", slot: r.slot };
  }

  const name = (pick && pick.name) || (espn && espn.name) ||
               (master.rows[0] && master.rows[0].name.replace(HOLD_RE, " ").trim()) || clean;

  return {
    found: !!(pick || espn || master.rows.length),
    query: clean,
    name,
    sleeperId,
    nbaTeam: (espn && espn.team) || nbaTeamGuess,
    espn,
    fantasy,
    contracts: master.rows,
    seasons: master.seasons,
    cap: SALARY_CAP,
  };
}

// Game log + season summary + advanced, with fantasy points.
// season: "" for current, or ESPN's season year (2026 = 2025-26).
function getGameLog(espnId, season) {
  if (!espnId) return { ok: false, msg: "No ESPN match for this player. Add him to the \"" + ESPN_FIX_SHEET + "\" sheet (Name | ESPN id)." };
  const key = `gl_${espnId}_${season || "cur"}`;
  const out = cached_(key, 30 * 60, () => {
    const url = `${ESPN_WEB}/athletes/${encodeURIComponent(espnId)}/gamelog` + (season ? `?season=${encodeURIComponent(season)}` : "");
    const j = fetchExternalJson_(url);
    if (!j) return { ok: false, msg: "ESPN didn't return a game log." };
    const gl = parseGamelog_(j);
    const sc = leagueScoring_();
    const fp = makeFantasyScorer_(sc);
    gl.rows.forEach(g => { g.fp = fp.score(g); });
    return {
      ok: true,
      season: gl.season,
      rows: gl.rows,
      summary: summarize_(gl.rows.filter(g => g.type === "RS")),
      playoffs: gl.rows.some(g => g.type !== "RS") ? summarize_(gl.rows.filter(g => g.type !== "RS")) : null,
      unscored: fp.unscored,
    };
  });
  return out;
}

// Every Sleeper transaction involving this player, newest first.
function getTxns(sleeperId) {
  if (!sleeperId) return { ok: false, msg: "No Sleeper match for this player, so no league transactions." };
  const ss = openSs_();
  const teamMap = readTeamMap_(ss);
  const plyrs = playersTable_(ss);
  const team = rid => (teamMap[String(rid)] && teamMap[String(rid)].team) || `Roster ${rid}`;
  const nm = pid => (plyrs.byId[pid] && plyrs.byId[pid].name) || String(pid);
  const pid = String(sleeperId);

  const out = [];
  leagueTxns_().forEach(t => {
    const a = t.a || {}, d = t.d || {};
    if (a[pid] == null && d[pid] == null) return;
    const base = { ts: t.ts, season: t.s };

    if (t.ty === "trade") {
      const parts = (t.r || []).map(rid => {
        rid = String(rid);
        const items = Object.keys(a).filter(p => String(a[p]) === rid).map(p => ({ player: nm(p) }));
        (t.p || []).forEach(pk => {
          // [season, round, original roster, new owner, previous owner]
          if (String(pk[3]) === rid && String(pk[4]) !== rid) {
            const orig = String(pk[2]) === rid ? "own" : team(pk[2]) + "'s";
            items.push({ pick: `${pk[0]} ${ordinal_(pk[1])} (${orig})` });
          }
        });
        return { team: team(rid), items };
      });
      const from = d[pid] != null ? team(d[pid]) : "";
      const to = a[pid] != null ? team(a[pid]) : "";
      out.push(Object.assign(base, {
        type: "Trade",
        text: a[pid] != null ? `${from} → ${to}` : `Dropped by ${from} as part of a trade`,
        parts,
      }));
      return;
    }

    const pre = t.ty === "commissioner" ? "Commissioner " : t.ty === "waiver" ? "Waiver " : "";
    if (a[pid] != null && d[pid] != null) {
      out.push(Object.assign(base, { type: pre + "Move", text: `${team(d[pid])} → ${team(a[pid])}` }));
    } else if (a[pid] != null) {
      const bid = t.b != null ? ` · $${t.b} bid` : "";
      const dropped = Object.keys(d).filter(p => String(d[p]) === String(a[pid])).map(nm);
      out.push(Object.assign(base, {
        type: pre + "Add",
        text: `Added by ${team(a[pid])}${bid}` + (dropped.length ? ` (dropped ${dropped.join(", ")})` : ""),
      }));
    } else {
      const added = Object.keys(a).filter(p => String(a[p]) === String(d[pid])).map(nm);
      out.push(Object.assign(base, {
        type: pre + "Drop",
        text: `Dropped by ${team(d[pid])}` + (added.length ? ` (added ${added.join(", ")})` : ""),
      }));
    }
  });
  out.sort((x, y) => y.ts - x.ts);
  return { ok: true, rows: out };
}

// Names for the search box: Master list + everyone on a league roster.
function getPlayerIndex() {
  return cached_("pindex", 10 * 60, () => {
    const ss = openSs_();
    const set = {};
    const sh = ss.getSheetByName(SHEETS.master);
    sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getDisplayValues().forEach(r => {
      const n = cleanName_(r[0]);
      if (n && !/pending/i.test(n)) set[norm_(n)] = n;
    });
    const plyrs = playersTable_(ss);
    Object.keys(liveRosters_().byPid).forEach(pid => {
      const p = plyrs.byId[pid];
      if (p && !set[norm_(p.name)]) set[norm_(p.name)] = p.name;
    });
    return Object.values(set).sort((a, b) => a.localeCompare(b));
  });
}

/* ============================ Lookups ============================ */

function cleanName_(s) {
  return String(s || "").replace(HOLD_RE, " ").replace(/\bDUPLICATE\b/g, " ").replace(/\s+/g, " ").trim();
}

function fixAbbr_(a) {
  a = String(a || "").toUpperCase();
  return NBA_ABBR_FIX[a] || a;
}

// _Players (hidden sheet the sync keeps): id | name | NBA team
function playersTable_(ss) {
  return cached_("plyrs", 60 * 60, () => {
    const sh = ss.getSheetByName(SHEETS.players);
    const byKey = {}, byId = {};
    if (sh && sh.getLastRow() > 0) {
      sh.getRange(1, 1, sh.getLastRow(), 3).getDisplayValues().forEach(r => {
        const id = String(r[0]); if (!id) return;
        const rec = { id, name: String(r[1]), team: String(r[2]) };
        byId[id] = { name: rec.name, team: rec.team };
        const k = norm_(rec.name);
        (byKey[k] = byKey[k] || []).push(rec);
      });
    }
    return { byKey, byId };
  });
}

// Sleeper rosters: pid -> { rid, slot }
function liveRosters_() {
  return cached_("rosters", 5 * 60, () => {
    const byPid = {};
    fetchJson_(`/league/${LEAGUE_ID}/rosters`).forEach(r => {
      const st = new Set((r.starters || []).map(String));
      const ir = new Set((r.reserve || []).map(String));
      const tx = new Set((r.taxi || []).map(String));
      allPlayerIds_(r).forEach(pid => {
        byPid[pid] = {
          rid: String(r.roster_id),
          slot: st.has(pid) ? "Starter" : ir.has(pid) ? "IR" : tx.has(pid) ? "Taxi" : "Bench",
        };
      });
    });
    return { byPid };
  });
}

// Team Map sheet, read-only (the sync owns writing it)
function readTeamMap_(ss) {
  const sh = ss.getSheetByName(SHEETS.map);
  const map = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues().forEach(r => {
      if (r[0] !== "") map[String(r[0])] = { owner: r[1], team: String(r[2]).trim(), code: String(r[3]).trim() };
    });
  }
  return map;
}

// Master list rows for this player (active contract, cap holds, extensions).
function masterRows_(ss, key) {
  const sh = ss.getSheetByName(SHEETS.master);
  const vals = sh.getRange(1, 1, sh.getLastRow(), MASTER_LAST_COL + 1).getDisplayValues();
  return parseMasterRows_(vals, key);
}

function parseMasterRows_(vals, key) {
  const hdr = vals[0].map(h => String(h).trim());
  const yearCols = [];
  hdr.forEach((h, i) => { if (/^\d{4}-\d{2}$/.test(h)) yearCols.push(i); });
  const n = Math.floor(yearCols.length / 2);
  const salCols = yearCols.slice(0, n), statCols = yearCols.slice(n, 2 * n);
  const seasons = salCols.map(i => hdr[i]);
  const detCol = hdr.findIndex(h => /contract details/i.test(h));
  const cntCol = hdr.findIndex(h => /on a roster/i.test(h));

  const rows = [];
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    const nm = String(v[0] || "");
    if (!nm || norm_(nm.replace(HOLD_RE, " ")) !== key) continue;
    rows.push({
      row: i + 1,
      name: nm,
      hold: HOLD_RE.test(nm),
      team: String(v[1] || ""),
      years: salCols.map((c, j) => ({
        season: seasons[j],
        salary: String(v[c] || ""),
        status: statCols[j] != null ? String(v[statCols[j]] || "") : "",
      })),
      details: detCol >= 0 ? String(v[detCol] || "") : "",
      onRoster: cntCol >= 0 ? String(v[cntCol] || "") : "",
    });
  }
  return { seasons, rows };
}

/* ------------------------------ ESPN ----------------------------- */

// norm name -> [athlete], from all 30 ESPN rosters (one parallel fetch, cached 6h)
function espnIndex_() {
  const hit = cacheGet_("espnIdx");
  if (hit !== null && Object.keys(hit).length >= 300) return hit;
  const idx = buildEspnIndex_();
  // Only keep it if most rosters came back; a failed fetch shouldn't stick for 6h
  if (Object.keys(idx).length >= 300) cachePut_("espnIdx", idx, 6 * 3600);
  return idx;
}

function buildEspnIndex_() {
  return (() => {
    const urls = [];
    for (let i = 1; i <= 30; i++) urls.push(`${ESPN_SITE}/teams/${i}/roster`);
    const idx = {};
    fetchAllExternalJson_(urls).forEach(r => {
      if (!r || !r.athletes) return;
      const team = fixAbbr_(r.team && r.team.abbreviation);
      r.athletes.forEach(a => {
        const rec = espnRecord_(a, team);
        const k = norm_(rec.name);
        (idx[k] = idx[k] || []).push(rec);
      });
    });
    return idx;
  })();
}

function espnRecord_(a, team) {
  const inj = (a.injuries || [])[0];
  const bp = a.birthPlace || {};
  return {
    id: String(a.id),
    name: a.fullName || a.displayName || "",
    team,
    pos: (a.position && a.position.abbreviation) || "",
    jersey: a.jersey || "",
    ht: a.displayHeight || "",
    wt: a.displayWeight || "",
    age: a.age != null ? a.age : "",
    dob: a.dateOfBirth || "",
    born: [bp.city, bp.state || bp.country].filter(Boolean).join(", "),
    college: (a.college && (a.college.name || a.college.shortName)) || "",
    exp: a.experience && a.experience.years != null ? a.experience.years : "",
    img: (a.headshot && a.headshot.href) || "",
    inj: inj ? { status: inj.status || (inj.type && inj.type.description) || "Injured", date: inj.date || "" } : null,
  };
}

function findEspn_(ss, key, team) {
  const fix = espnFixes_(ss)[key];
  const idx = espnIndex_();
  if (fix) {
    for (const k in idx) {
      const hit = idx[k].find(r => r.id === fix);
      if (hit) return hit;
    }
    return { id: fix, name: "", team: "", pos: "", jersey: "", ht: "", wt: "", age: "", dob: "", born: "", college: "", exp: "", img: "", inj: null };
  }
  const c = idx[key] || [];
  return c.find(r => r.team === team) || c[0] || null;
}

function espnFixes_(ss) {
  const sh = ss.getSheetByName(ESPN_FIX_SHEET);
  const out = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(r => {
      if (r[0] && r[1]) out[norm_(cleanName_(r[0]))] = String(r[1]).trim();
    });
  }
  return out;
}

function parseGamelog_(j) {
  const names = j.names || [];
  const col = n => names.indexOf(n);
  const events = j.events || {};
  const rows = [], seen = {};
  let season = "";

  (j.seasonTypes || []).forEach(st => {
    const dn = String(st.displayName || "");
    if (/preseason/i.test(dn)) return;
    if (!season) season = (dn.match(/\d{4}-\d{2}/) || [""])[0];
    const type = /post/i.test(dn) ? "PO" : /play-?in/i.test(dn) ? "PI" : "RS";
    (st.categories || []).forEach(cat => (cat.events || []).forEach(ev => {
      if (!ev || seen[ev.eventId]) return;
      seen[ev.eventId] = true;
      const s = ev.stats || [];
      const get = n => (col(n) >= 0 ? s[col(n)] : "");
      const num = n => Number(get(n)) || 0;
      const pair = n => { const m = String(get(n) || "").split("-"); return [Number(m[0]) || 0, Number(m[1]) || 0]; };
      const [fgm, fga] = pair("fieldGoalsMade-fieldGoalsAttempted");
      const [fg3m, fg3a] = pair("threePointFieldGoalsMade-threePointFieldGoalsAttempted");
      const [ftm, fta] = pair("freeThrowsMade-freeThrowsAttempted");
      const m = events[ev.eventId] || {};
      rows.push({
        id: String(ev.eventId),
        date: m.gameDate || "",
        opp: (m.opponent && m.opponent.abbreviation) || "",
        at: m.atVs || "",
        res: m.gameResult || "",
        score: m.score || "",
        type,
        min: num("minutes"),
        pts: num("points"), reb: num("totalRebounds"), ast: num("assists"),
        stl: num("steals"), blk: num("blocks"), to: num("turnovers"), pf: num("fouls"),
        fgm, fga, fg3m, fg3a, ftm, fta,
      });
    }));
  });
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { season, rows };
}

/* ------------------------- Fantasy scoring ----------------------- */

function leagueScoring_() {
  return cached_("scoring", 6 * 3600, () => (fetchJson_(`/league/${LEAGUE_ID}`).scoring_settings || {}));
}

// Sleeper scoring keys this can compute from an ESPN box score.
function makeFantasyScorer_(settings) {
  const cats = g => [g.pts, g.reb, g.ast, g.stl, g.blk].filter(v => v >= 10).length;
  const F = {
    pts: g => g.pts, reb: g => g.reb, ast: g => g.ast, stl: g => g.stl, blk: g => g.blk,
    to: g => g.to, pf: g => g.pf,
    fgm: g => g.fgm, fga: g => g.fga, fgmi: g => g.fga - g.fgm,
    ftm: g => g.ftm, fta: g => g.fta, ftmi: g => g.fta - g.ftm,
    fg3m: g => g.fg3m, fg3a: g => g.fg3a, fg3mi: g => g.fg3a - g.fg3m,
    dd: g => (cats(g) >= 2 ? 1 : 0), td: g => (cats(g) >= 3 ? 1 : 0), qd: g => (cats(g) >= 4 ? 1 : 0),
    bonus_pt_40p: g => (g.pts >= 40 ? 1 : 0), bonus_pt_50p: g => (g.pts >= 50 ? 1 : 0),
    bonus_reb_20p: g => (g.reb >= 20 ? 1 : 0), bonus_ast_15p: g => (g.ast >= 15 ? 1 : 0),
  };
  const used = Object.keys(settings).filter(k => Number(settings[k]) !== 0);
  const unscored = used.filter(k => !F[k]);
  const scoredKeys = used.filter(k => F[k]);
  return {
    unscored,
    score: g => Math.round(scoredKeys.reduce((s, k) => s + Number(settings[k]) * F[k](g), 0) * 100) / 100,
  };
}

function summarize_(games) {
  const g = games.filter(x => x.min > 0);
  const n = g.length;
  if (!n) return null;
  const sum = k => g.reduce((s, x) => s + (x[k] || 0), 0);
  const T = {};
  ["min", "pts", "reb", "ast", "stl", "blk", "to", "pf", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "fp"].forEach(k => { T[k] = sum(k); });
  const per = k => T[k] / n;
  const div = (a, b) => (b ? a / b : null);
  const fps = g.map(x => x.fp || 0);              // newest first
  const mean = per("fp");
  const sd = Math.sqrt(fps.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n);
  const lastN = k => { const s = fps.slice(0, k); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
  const cats = x => [x.pts, x.reb, x.ast, x.stl, x.blk].filter(v => v >= 10).length;

  return {
    g: n,
    avg: { min: per("min"), pts: per("pts"), reb: per("reb"), ast: per("ast"), stl: per("stl"), blk: per("blk"), to: per("to"), fp: mean,
           fg3m: per("fg3m") },
    pct: { fg: div(T.fgm, T.fga), fg3: div(T.fg3m, T.fg3a), ft: div(T.ftm, T.fta) },
    adv: {
      ts: div(T.pts, 2 * (T.fga + 0.44 * T.fta)),
      efg: div(T.fgm + 0.5 * T.fg3m, T.fga),
      par3: div(T.fg3a, T.fga),
      ftr: div(T.fta, T.fga),
      astTo: div(T.ast, T.to),
      fpMin: div(T.fp, T.min),
      fpSd: sd,
      last5: lastN(5),
      last10: lastN(10),
      high: Math.max.apply(null, fps),
      low: Math.min.apply(null, fps),
      dd: g.filter(x => cats(x) >= 2).length,
      td: g.filter(x => cats(x) >= 3).length,
    },
    per36: { pts: div(T.pts * 36, T.min), reb: div(T.reb * 36, T.min), ast: div(T.ast * 36, T.min),
             stl: div(T.stl * 36, T.min), blk: div(T.blk * 36, T.min), fp: div(T.fp * 36, T.min) },
    eligibility: mean > 30 ? "Supermax eligible (30+ FPPG)" : mean > 22.5 ? "Max eligible (22.5+ FPPG)" : "",
  };
}

/* ------------------------ Sleeper transactions ------------------- */

// This league plus up to 2 previous seasons (via previous_league_id).
function leagueChain_() {
  return cached_("chain", 6 * 3600, () => {
    const out = [];
    let id = LEAGUE_ID;
    for (let i = 0; i < 3 && id && id !== "0"; i++) {
      const lg = fetchJson_(`/league/${id}`);
      out.push({ id, season: String(lg.season || "") });
      id = lg.previous_league_id;
    }
    return out;
  });
}

// Compact list of completed transactions across the chain.
// Past seasons cache 6h (they don't change); this season 10 min.
function leagueTxns_() {
  let all = [];
  leagueChain_().forEach((lg, i) => {
    const ttl = i === 0 ? 10 * 60 : 6 * 3600;
    all = all.concat(cached_(`txns_${lg.id}`, ttl, () => fetchLeagueTxns_(lg)));
  });
  return all;
}

function fetchLeagueTxns_(lg) {
  const urls = [];
  for (let leg = 0; leg <= 30; leg++) urls.push(`${BASE}/league/${lg.id}/transactions/${leg}`);
  const seen = {}, out = [];
  fetchAllExternalJson_(urls).forEach(list => {
    (list || []).forEach(t => {
      if (t.status !== "complete" || seen[t.transaction_id]) return;
      seen[t.transaction_id] = true;
      out.push({
        ts: t.status_updated || t.created,
        s: lg.season,
        ty: t.type,
        a: t.adds || null,
        d: t.drops || null,
        r: t.roster_ids || [],
        p: (t.draft_picks || []).map(pk => [pk.season, pk.round, pk.roster_id, pk.owner_id, pk.previous_owner_id]),
        b: t.settings && t.settings.waiver_bid != null ? t.settings.waiver_bid : null,
      });
    });
  });
  return out;
}

/* ============================ Fetch + cache ===================== */

function fetchExternalJson_(url) {
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  try { return JSON.parse(resp.getContentText()); } catch (e) { return null; }
}

function fetchAllExternalJson_(urls) {
  return UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true }))).map(r => {
    if (r.getResponseCode() !== 200) return null;
    try { return JSON.parse(r.getContentText()); } catch (e) { return null; }
  });
}

// CacheService values max out at 100KB, so big objects are split into chunks.
const CACHE_CHUNK = 40000; // characters (accents can be 2+ bytes)

function cached_(key, seconds, fn) {
  const hit = cacheGet_(key);
  if (hit !== null) return hit;
  const val = fn();
  cachePut_(key, val, seconds);
  return val;
}

function cacheGet_(key) {
  const c = CacheService.getScriptCache();
  const head = c.get(key);
  if (head == null) return null;
  try {
    if (head.indexOf("chunks:") !== 0) return JSON.parse(head);
    const n = Number(head.slice(7));
    const keys = Array.from({ length: n }, (_, i) => `${key}_${i}`);
    const parts = c.getAll(keys);
    let s = "";
    for (const k of keys) { if (parts[k] == null) return null; s += parts[k]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}

function cachePut_(key, obj, seconds) {
  const c = CacheService.getScriptCache();
  const s = JSON.stringify(obj);
  try {
    if (s.length <= CACHE_CHUNK) { c.put(key, s, seconds); return; }
    const parts = {}; let n = 0;
    for (let i = 0; i < s.length; i += CACHE_CHUNK) parts[`${key}_${n++}`] = s.slice(i, i + CACHE_CHUNK);
    c.putAll(parts, seconds);
    c.put(key, "chunks:" + n, seconds);
  } catch (e) {
    Logger.log(`Cache put failed for ${key}: ${e}`);
  }
}

/* ============================ Maintenance ======================= */

function clearCardCache() {
  const c = CacheService.getScriptCache();
  ["espnIdx", "plyrs", "rosters", "scoring", "chain", "pindex"].forEach(k => c.remove(k));
  leagueChainIds_().forEach(id => c.remove("txns_" + id));
  SpreadsheetApp.getActiveSpreadsheet().toast("Player card cache cleared.", "Player cards", 5);
}

function leagueChainIds_() {
  const hit = cacheGet_("chain");
  return hit ? hit.map(l => l.id) : [LEAGUE_ID];
}

// Run from the editor (select testPlayerCard, click Run), then check the log.
function testPlayerCard() {
  const r = UrlFetchApp.fetch(`${ESPN_SITE}/teams/1/roster`, { muteHttpExceptions: true });
  Logger.log("ESPN roster (ATL): HTTP " + r.getResponseCode() + ", " + r.getContentText().length + " chars");
  const idx = buildEspnIndex_();
  Logger.log("ESPN players indexed from 30 rosters: " + Object.keys(idx).length + " (should be ~500)");
  ["Jalen Johnson", "Luka Dončić", "Nikola Jokić", "Shai Gilgeous-Alexander"].forEach(n => {
    const hit = idx[norm_(n)];
    Logger.log(`${n}: ${hit ? "ESPN id " + hit[0].id + " (" + hit[0].team + ")" : "NO MATCH"}`);
  });
  const g = UrlFetchApp.fetch(`${ESPN_WEB}/athletes/4277905/gamelog`, { muteHttpExceptions: true });
  Logger.log("ESPN game log: HTTP " + g.getResponseCode());
}

/* ============================ Name links ======================== */

function getCardUrl_() {
  return PropertiesService.getScriptProperties().getProperty("cardUrl") || "";
}

function setCardUrl() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt("Player card link", "Paste the web app URL (ends in /exec):", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const url = res.getResponseText().trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    ui.alert("That doesn't look like a web app /exec URL. Nothing saved.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty("cardUrl", url);
  ui.alert("Saved. Now run Sync League > Refresh player links now.");
}

function cardLink_(base, text) {
  return base + "?n=" + encodeURIComponent(cleanName_(text));
}

// Adds/updates card links in a block of cells without touching formulas,
// numbers, or text styling. isPlayer(rowIdx, colIdx, text) picks the cells.
// Writes only runs of plain-text cells that actually changed.
function linkRange_(sh, row, col, numRows, numCols, isPlayer, base) {
  if (numRows < 1 || numCols < 1) return 0;
  const rng = sh.getRange(row, col, numRows, numCols);
  const rich = rng.getRichTextValues();
  const formulas = rng.getFormulas();
  let writes = 0;

  for (let c = 0; c < numCols; c++) {
    let start = -1, buf = [], dirty = false;
    const flush = () => {
      if (start >= 0 && dirty) {
        sh.getRange(row + start, col + c, buf.length, 1).setRichTextValues(buf.map(v => [v]));
        writes++;
      }
      start = -1; buf = []; dirty = false;
    };
    for (let r = 0; r < numRows; r++) {
      const rt = rich[r][c];
      const safe = rt && !formulas[r][c];
      if (!safe) { flush(); continue; }
      if (start < 0) start = r;
      const text = rt.getText();
      let out = rt;
      if (text && isPlayer(r, c, text)) {
        const url = cardLink_(base, text);
        if (rt.getLinkUrl() !== url) { out = rt.copy().setLinkUrl(url).build(); dirty = true; }
      }
      buf.push(out);
    }
    flush();
  }
  return writes;
}

// Rosters is rewritten every sync, so it's linked every sync.
function linkRosters_(ss) {
  const base = getCardUrl_();
  if (!base) return;
  const sh = ss.getSheetByName(SHEETS.rosters);
  const lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return;
  linkRange_(sh, 2, 1, lr - 1, lc, () => true, base);
}

function linkTeamTab_(sh, base) {
  const lr = sh.getLastRow();
  if (lr < 2) return;
  const slots = sh.getRange(2, 1, lr - 1, 1).getDisplayValues();
  linkRange_(sh, 2, 2, lr - 1, 1, (r, c, text) =>
    TEAM_TAB_SLOTS.indexOf(String(slots[r][0]).trim().toLowerCase()) >= 0 && !!cleanName_(text), base);
}

function linkMaster_(ss, base) {
  const sh = ss.getSheetByName(SHEETS.master);
  const lr = sh.getLastRow();
  if (lr < 2) return;
  linkRange_(sh, 2, 1, lr - 1, 1, (r, c, text) => !/pending/i.test(text), base);
}

function linkAllPlayers_(ss) {
  const base = getCardUrl_();
  if (!base) return;
  linkRosters_(ss);
  linkMaster_(ss, base);
  Object.values(TEAM_CODES).forEach(code => {
    const sh = ss.getSheetByName(code);
    if (sh) linkTeamTab_(sh, base);
  });
  PropertiesService.getScriptProperties().setProperty("linksAt", String(Date.now()));
}

// Called at the end of each sync: full pass at most once an hour.
function maybeLinkAllPlayers_(ss) {
  const at = Number(PropertiesService.getScriptProperties().getProperty("linksAt") || 0);
  if (Date.now() - at >= LINK_EVERY_MIN * 60 * 1000) linkAllPlayers_(ss);
}

function refreshPlayerLinks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!getCardUrl_()) {
    SpreadsheetApp.getUi().alert("Set the player card link first (Sync League > Set player card link…).");
    return;
  }
  linkAllPlayers_(ss);
  ss.toast("Player links updated.", "Player cards", 5);
}

// Link a name as soon as you type it on a team tab or Master list.
// (Simple trigger. If another file in this project already has an
// onEdit, merge the body of this one into it instead.)
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const base = getCardUrl_();
    if (!base) return;
    const sh = e.range.getSheet();
    const name = sh.getName();
    const r0 = e.range.getRow(), c0 = e.range.getColumn();
    const nr = Math.min(e.range.getNumRows(), 200), nc = e.range.getNumColumns();
    const start = Math.max(r0, 2), rows = r0 + nr - start;
    if (rows < 1) return;

    if (name === SHEETS.master && c0 === 1) {
      linkRange_(sh, start, 1, rows, 1, (r, c, t) => !/pending/i.test(t), base);
    } else if (Object.values(TEAM_CODES).indexOf(name) >= 0 && c0 <= 2 && c0 + nc - 1 >= 2) {
      const slots = sh.getRange(start, 1, rows, 1).getDisplayValues();
      linkRange_(sh, start, 2, rows, 1, (r, c, t) =>
        TEAM_TAB_SLOTS.indexOf(String(slots[r][0]).trim().toLowerCase()) >= 0 && !!cleanName_(t), base);
    }
  } catch (err) {
    console.log("onEdit link: " + err);
  }
}
