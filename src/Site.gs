/******************************************************************
 * League website: routing + the data the site reads.
 *
 * This file owns the project's only doGet. Pages are HtmlService
 * templates (Site.html) that pull in partials with include_().
 *
 *   /exec              site home (standings)
 *   /exec?n=Name       site with that player's card open (old sheet links)
 *   /exec#team/ATL     any page, via the hash
 *
 * getLeague() is the one big read; it's cached ~60s and cleared on any
 * write (admin or sync). The League Log and Rules load lazily.
 ******************************************************************/

const SITE_SHEETS = {
  holds: "Cap Holds",
  cash: "Cash Ledger",
  admin: "Admin Log",
};
const SITE_CACHE_KEYS = ["site_league", "site_log", "site_rules", "plyrs", "rosters", "sl_rosters"];
const LIMITS = { hardCap: 300, cash: 10, maxes: 2, supermaxes: 1 };

/* ============================ Web app ============================ */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const t = HtmlService.createTemplateFromFile("Site");
  let url = "";
  try { url = ScriptApp.getService().getUrl() || ""; } catch (err) { /* not deployed (editor test) */ }
  t.bootJson = JSON.stringify({ n: String(p.n || ""), url }).replace(/</g, "\\u003c");
  return t.evaluate()
    .setTitle("Salary League")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// <?!= include_("SiteCss") ?> inside a template
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function clearSiteCache_() {
  const c = CacheService.getScriptCache();
  c.removeAll(SITE_CACHE_KEYS);
}

/* ============================ getLeague ========================== */

function getLeague() {
  return cached_("site_league", 60, () => buildLeague_(openSs_()));
}

function buildLeague_(ss) {
  const master = readMaster_(ss);
  const lg = sleeperLeague_();
  const raw = sleeperRosters_();
  const plyrs = playersTable_(ss);
  const map = readTeamMap_(ss);
  const ranks = readRanks_(ss);

  const teams = [], rosters = {};
  raw.forEach(r => {
    const rid = String(r.rid);
    const tm = map[rid] || {};
    const nm = pid => (plyrs.byId[pid] && plyrs.byId[pid].name) || String(pid);
    const ent = pid => ({ pid: String(pid), name: nm(pid) });
    const st = r.starters.filter(p => p && p !== "0");
    const ir = r.reserve.filter(Boolean), tx = r.taxi.filter(Boolean);
    const bench = r.players.filter(p => st.indexOf(p) < 0 && ir.indexOf(p) < 0 && tx.indexOf(p) < 0);
    rosters[rid] = { starters: st.map(ent), bench: bench.map(ent), ir: ir.map(ent), taxi: tx.map(ent) };
    if (!tm.code) return; // "Unknown" rosters have no team
    const rk = ranks[String(tm.team).toLowerCase()] || {};
    teams.push({
      rid, code: tm.code, name: tm.team, owner: tm.owner || rk.owner || "",
      rank: rk.rank != null ? rk.rank : null,
      pf: r.pf, w: r.w, l: r.l, t: r.t,
    });
  });
  teams.sort((a, b) => (a.rank == null ? 99 : a.rank) - (b.rank == null ? 99 : b.rank) || a.name.localeCompare(b.name));

  return {
    season: master.seasons[0],
    seasons: master.seasons,
    teams,
    contracts: master.contracts,
    rosters,
    holds: readHolds_(ss),
    cash: readCash_(ss, master.seasons[0]),
    picks: computePicks_(raw, map, lg, readTradedPicks_()),
    limits: Object.assign({ activeRoster: (lg.roster_positions || []).length || null }, LIMITS),
    lastSync: lastSync_(ss),
  };
}

/* ---------------------------- Master list ------------------------ */

// "$32.0" -> 32, "UFA"/"RFA" stay strings, blank -> null
function parseSal_(s) {
  s = String(s == null ? "" : s).trim();
  if (!s) return null;
  if (/^(UFA|RFA)$/i.test(s)) return s.toUpperCase();
  const t = s.replace(/[$,\s]/g, "");
  const neg = /^-|^\(.*\)$/.test(t);
  const core = t.replace(/^-|^\(|\)$/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(core)) return null;
  return neg ? -Number(core) : Number(core);
}

function masterLayout_(hdr) {
  const yearCols = [];
  hdr.forEach((h, i) => { if (/^\d{4}-\d{2}$/.test(String(h).trim())) yearCols.push(i); });
  const n = Math.floor(yearCols.length / 2);
  return {
    salCols: yearCols.slice(0, n),
    statCols: yearCols.slice(n, 2 * n),
    seasons: yearCols.slice(0, n).map(i => String(hdr[i]).trim()),
    detCol: hdr.findIndex(h => /contract details/i.test(h)),
    cntCol: hdr.findIndex(h => /on a roster/i.test(h)),
  };
}

function readMaster_(ss) {
  const sh = ss.getSheetByName(SHEETS.master);
  const vals = sh.getRange(1, 1, sh.getLastRow(), MASTER_LAST_COL + 1).getDisplayValues();
  const lay = masterLayout_(vals[0]);
  const contracts = [];
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    const n = String(v[0] || "").trim();
    if (!n) continue;
    contracts.push({
      r: i + 1,
      n,
      hold: HOLD_RE.test(n),
      nba: String(v[1] || "").trim(),
      sal: lay.salCols.map(c => parseSal_(v[c])),
      st: lay.statCols.map(c => String(v[c] || "").trim().toUpperCase()),
      det: lay.detCol >= 0 ? String(v[lay.detCol] || "") : "",
      cnt: lay.cntCol >= 0 && v[lay.cntCol] !== "" ? Number(v[lay.cntCol]) : null,
    });
  }
  return { seasons: lay.seasons, contracts };
}

/* ---------------------------- Rankings --------------------------- */

function readRanks_(ss) {
  const sh = ss.getSheetByName(SHEETS.power);
  const out = {};
  if (!sh) return out;
  const vals = sh.getDataRange().getDisplayValues();
  const hdr = vals[0].map(h => String(h).trim().toLowerCase());
  const cR = hdr.indexOf("ranking"), cN = hdr.indexOf("team name"), cO = hdr.indexOf("owner/gm");
  vals.slice(1).forEach(r => {
    const name = String(r[cN] || "").trim();
    if (!name) return;
    const rank = Number(r[cR]);
    out[name.toLowerCase()] = { rank: r[cR] !== "" && isFinite(rank) ? rank : null, owner: cO >= 0 ? String(r[cO]) : "" };
  });
  return out;
}

/* --------------------------- Cap holds --------------------------- */

// Cap Holds table if it exists; before setupSiteTables, read the team tabs.
function readHolds_(ss) {
  const sh = ss.getSheetByName(SITE_SHEETS.holds);
  if (sh) {
    if (sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues()
      .map((r, i) => ({ row: i + 2, code: String(r[0]).trim(), name: String(r[1]).trim(), added: r[2], note: r[3] }))
      .filter(h => h.code && h.name);
  }
  return holdsFromTeamTabs_(ss).map(h => ({ code: h[0], name: h[1], added: "", note: h[3] }));
}

// [code, "Name (cap hold)", added, note] for every named Cap Hold row on the team tabs
function holdsFromTeamTabs_(ss) {
  const out = [];
  Object.values(TEAM_CODES).forEach(code => {
    const sh = ss.getSheetByName(code);
    if (!sh || sh.getLastRow() < 1) return;
    sh.getRange(1, 1, sh.getLastRow(), 2).getDisplayValues().forEach(r => {
      const name = String(r[1] || "").trim();
      if (String(r[0]).trim().toLowerCase() === "cap hold" && name) {
        out.push([code, HOLD_RE.test(name) ? name : name + " (cap hold)", "", "Migrated from " + code + " tab"]);
      }
    });
  });
  return out;
}

// Called by the sync when a drop creates a hold. Skips if the table isn't set up yet.
function appendCapHold_(ss, code, holdName, note) {
  const sh = ss.getSheetByName(SITE_SHEETS.holds);
  if (!sh || !code) return false;
  const key = norm_(holdName.replace(HOLD_RE, ""));
  const last = sh.getLastRow();
  if (last >= 2 && sh.getRange(2, 1, last - 1, 2).getDisplayValues()
      .some(r => String(r[0]).trim() === code && norm_(String(r[1]).replace(HOLD_RE, "")) === key)) return false;
  sh.appendRow([code, holdName, new Date(), note || ""]);
  return true;
}

/* ----------------------------- Cash ------------------------------ */

// Cash Ledger if it exists; otherwise each team tab's Cash Considerations value
function readCash_(ss, season) {
  const sh = ss.getSheetByName(SITE_SHEETS.cash);
  if (sh) {
    if (sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getDisplayValues()
      .map((r, i) => ({ row: i + 2, date: r[0], season: String(r[1]).trim(), code: String(r[2]).trim(),
                        amt: parseSal_(r[3]), note: r[4], ref: r[5] }))
      .filter(x => x.code && typeof x.amt === "number");
  }
  return cashFromTeamTabs_(ss).map(c => ({ date: "", season, code: c.code, amt: c.amt, note: "Opening balance", ref: "" }));
}

function cashFromTeamTabs_(ss) {
  const out = [];
  Object.values(TEAM_CODES).forEach(code => {
    const sh = ss.getSheetByName(code);
    if (!sh || sh.getLastRow() < 1) return;
    const w = Math.min(4, sh.getLastColumn());
    const row = sh.getRange(1, 1, sh.getLastRow(), w).getDisplayValues()
      .find(r => r.some(v => /cash considerations/i.test(v)));
    if (!row) return;
    const i = row.findIndex(v => /cash considerations/i.test(v));
    const amt = parseSal_(row[i + 1]);
    if (typeof amt === "number" && amt !== 0) out.push({ code, amt });
  });
  return out;
}

/* ----------------------------- Picks ----------------------------- */

// Next 3 drafts plus any later season that shows up in traded picks.
// Labels match the League Log: "2029 1st (Dallas's)" / "2028 2nd (own)".
function computePicks_(raw, map, lg, traded) {
  const rounds = Number(lg.settings && lg.settings.draft_rounds) || 2;
  const first = Number(lg.season) + 1; // Sleeper "2026" = the 2026-27 season, so next draft is 2027
  const seasons = [first, first + 1, first + 2];
  traded.forEach(p => { const s = Number(p.season); if (s > first + 2 && seasons.indexOf(s) < 0) seasons.push(s); });
  seasons.sort();

  const owner = {};
  traded.forEach(p => { owner[`${p.season}|${p.round}|${p.roster_id}`] = String(p.owner_id); });
  const name = rid => (map[rid] && map[rid].team) || `Roster ${rid}`;
  const out = {};
  Object.keys(map).forEach(rid => { if (map[rid].code) out[map[rid].code] = []; });

  seasons.forEach(s => {
    for (let rd = 1; rd <= rounds; rd++) {
      raw.forEach(r => {
        const orig = String(r.rid);
        const own = owner[`${s}|${rd}|${orig}`] || orig;
        const code = map[own] && map[own].code;
        if (!code) return;
        out[code].push({
          season: s, round: rd, from: (map[orig] && map[orig].code) || "",
          label: `${s} ${ordinal_(rd)} (${own === orig ? "own" : name(orig) + "'s"})`,
        });
      });
    }
  });
  return out;
}

/* ---------------------------- Sleeper ---------------------------- */

function sleeperLeague_() {
  return cached_("sl_league", 6 * 3600, () => {
    const lg = fetchJson_(`/league/${LEAGUE_ID}`);
    return { season: lg.season, settings: lg.settings || {}, roster_positions: lg.roster_positions || [],
             scoring_settings: lg.scoring_settings || {}, previous_league_id: lg.previous_league_id };
  });
}

// Compact live rosters, shared by the site and the player card.
function sleeperRosters_() {
  return cached_("sl_rosters", 60, () => fetchJson_(`/league/${LEAGUE_ID}/rosters`).map(r => {
    const s = r.settings || {};
    return {
      rid: String(r.roster_id),
      players: (r.players || []).map(String).filter(p => p && p !== "0"),
      starters: (r.starters || []).map(String),
      reserve: (r.reserve || []).map(String),
      taxi: (r.taxi || []).map(String),
      w: s.wins || 0, l: s.losses || 0, t: s.ties || 0,
      pf: Math.round(((s.fpts || 0) + (s.fpts_decimal || 0) / 100) * 100) / 100,
    };
  }));
}

function readTradedPicks_() {
  return cached_("sl_picks", 10 * 60, () => fetchJson_(`/league/${LEAGUE_ID}/traded_picks`) || []);
}

function lastSync_(ss) {
  const sh = ss.getSheetByName(SHEETS.log);
  return sh ? String(sh.getRange("I1").getDisplayValue() || "") : "";
}

/* ======================= Lazy page data ========================== */

function getLog() {
  return cached_("site_log", 60, () => {
    const sh = openSs_().getSheetByName(SHEETS.log);
    if (!sh || sh.getLastRow() < 2) return { rows: [], lastSync: "" };
    const n = Math.min(sh.getLastRow() - 1, 1500);
    const vals = sh.getRange(2, 1, n, 6).getValues();
    const shown = sh.getRange(2, 1, n, 1).getDisplayValues();
    const rows = vals.map((r, i) => ({
      ts: r[0] instanceof Date ? r[0].getTime() : null,
      when: shown[i][0],
      type: String(r[1]), teams: String(r[2]), players: String(r[3]), details: String(r[4]), status: String(r[5]),
    })).filter(r => r.type || r.players);
    return { rows, lastSync: String(sh.getRange("I1").getDisplayValue() || "") };
  });
}

function getRules() {
  return cached_("site_rules", 10 * 60, () => {
    const sh = openSs_().getSheetByName("Rules");
    if (!sh) return { rows: [] };
    const rows = sh.getDataRange().getDisplayValues().map(r => {
      let n = r.length; while (n && String(r[n - 1]).trim() === "") n--;
      return r.slice(0, n).map(v => String(v).trim());
    });
    return { rows };
  });
}
