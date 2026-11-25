/******************************************************************
 * Sleeper League Sync + Change Log
 *
 * Every sync:
 *   1. Rewrites the Rosters sheet (same layout/column order as before,
 *      so team tabs and Master list column S keep working).
 *   2. Reads Sleeper's transaction list (this week + last week) and logs
 *      every new Trade / Add / Drop / Commissioner move to "League Log"
 *      using team names, with the time it went through in Sleeper.
 *      Trades list draft picks; 3-team trades are one entry.
 *      If the transaction list can't be read, it falls back to comparing
 *      rosters with the last sync.
 *   3. Drop  -> renames the player's Master list row to "Name (cap hold)"
 *              and adds "Name (cap hold)" to the CAP HOLDS section of the
 *              team that actually dropped him (even right after a trade),
 *              and to the site's Cap Holds table.
 *      Add   -> creates a new Master list row (if he isn't already there)
 *              marked "PENDING — needs contract" and waits for your input.
 *      Trade -> logged only (contracts follow the player automatically).
 *   4. Writes PF / W / L / T into Team Power Rankings.
 *   5. Keeps player names linked to the league site's player card
 *      (see PlayerCard.gs for setup), then clears the site's cache.
 *
 * Setup:
 *   - Run syncSleeperLeague once. The FIRST run only saves a baseline
 *     (no changes logged), so nothing gets mass-created.
 *   - Check the "Team Map" sheet: every Sleeper roster should have a team
 *     name + tab code. Fix any blank / wrong rows by hand; the script
 *     never overwrites a row you filled in.
 *   - Run createFiveMinuteTrigger once to turn on auto-sync.
 ******************************************************************/

const LEAGUE_ID = "1341793858815557632";
const BASE = "https://api.sleeper.app/v1";

const SHEETS = {
  rosters: "Rosters",
  master: "Master list",
  log: "League Log",
  power: "Team Power Rankings",
  map: "Team Map",
  state: "_Sync State",   // hidden: last-seen rosters
  txns: "_Txn Seen",      // hidden: Sleeper transaction ids already processed
  players: "_Players",    // hidden: daily cache of Sleeper player names
};

// Power Rankings team name (lowercase) -> team tab code
const TEAM_CODES = {
  "atlanta": "ATL", "boston": "BOS", "brooklyn": "BKN", "charlotte": "CHA",
  "chicago": "CHI", "cleveland": "CLE", "dallas": "DAL", "denver": "DEN",
  "detroit": "DET", "golden state": "GSW", "houston": "HOU", "indiana": "IND",
  "los angeles (c)": "LAC", "los angeles (l)": "LAL", "memphis": "MEM",
  "miami": "MIA", "milwaukee": "MIL", "minnesota": "MIN", "new orleans": "NOP",
  "new york": "NYK", "oklahoma city": "OKC", "orlando": "ORL",
  "philadelphia": "PHI", "phoenix": "PHX", "portland": "POR",
  "sacramento": "SAC", "san antonio": "SAS", "toronto": "TOR", "utah": "UTA",
  "washington": "WAS",
};

// Sleeper NBA abbreviations that differ from the Master list's
const NBA_ABBR_FIX = {
  GS: "GSW", NY: "NYK", SA: "SAS", NO: "NOP", NOR: "NOP", PHO: "PHX",
  UTAH: "UTA", WSH: "WAS", BRK: "BKN", CHO: "CHA",
};

const MASTER_LAST_COL = 18; // A:R — never write column S (ARRAYFORMULA)
const PLAYER_CACHE_HOURS = 24;

/* ----------------------------- Menu ----------------------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sync League")
    .addItem("Sync now", "syncWithConfirm")
    .addSeparator()
    .addItem("Rebuild Team Map", "rebuildTeamMap")
    .addItem("Reset change baseline", "resetBaseline")
    .addItem("Turn on 5-minute auto sync", "createFiveMinuteTrigger")
    .addSeparator()
    .addItem("Set site link…", "setCardUrl")
    .addItem("Refresh player links now", "refreshPlayerLinks")
    .addItem("Clear site + player card cache", "clearCardCache")
    .addSeparator()
    .addItem("Set commissioner passcode…", "setCommissionerPasscode")
    .addItem("Set up site tables", "setupSiteTables")
    .addToUi();
}

function syncWithConfirm() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert("Sync League", "Pull latest rosters from Sleeper and apply changes?", ui.ButtonSet.YES_NO);
  if (res === ui.Button.YES) syncSleeperLeague();
}

/* ----------------------------- Main ----------------------------- */

function syncSleeperLeague() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another sync is still running
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const rosters = fetchJson_(`/league/${LEAGUE_ID}/rosters`);
    const users = fetchJson_(`/league/${LEAGUE_ID}/users`);
    const players = getPlayers_(ss);

    const owners = {};
    users.forEach(u => { owners[u.user_id] = u.display_name || u.username || u.user_id; });

    const teamMap = getTeamMap_(ss, rosters, owners, players, false);

    writeRosters_(ss, rosters, owners, players);
    detectAndApplyChanges_(ss, rosters, players, teamMap);
    updatePowerRankings_(ss, rosters, teamMap);
    stampLastSync_(ss);

    // Player card links: never let these break the sync
    try { linkRosters_(ss); } catch (e) { Logger.log("Roster links: " + e); }
    try { maybeLinkAllPlayers_(ss); } catch (e) { Logger.log("Player links: " + e); }

    clearSiteCache_(); // the site shows the new rosters/log right away

    Logger.log("Sync complete.");
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------- Sleeper data ------------------------- */

function fetchJson_(path) {
  const resp = UrlFetchApp.fetch(BASE + path, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error(`Sleeper ${path} returned ${resp.getResponseCode()}`);
  }
  return JSON.parse(resp.getContentText());
}

// /players/nba is several MB, and Sleeper asks for at most ~1 call/day,
// so cache a slim id -> name/team table in a hidden sheet.
function getPlayers_(ss) {
  const props = PropertiesService.getScriptProperties();
  const fetchedAt = Number(props.getProperty("playersFetchedAt") || 0);
  let sh = ss.getSheetByName(SHEETS.players);

  if (!sh || sh.getLastRow() === 0 || Date.now() - fetchedAt > PLAYER_CACHE_HOURS * 3600 * 1000) {
    const raw = fetchJson_("/players/nba");
    const rows = Object.keys(raw).map(id => {
      const p = raw[id] || {};
      const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      return [id, name, p.team || ""];
    });
    if (!sh) { sh = ss.insertSheet(SHEETS.players); sh.hideSheet(); }
    sh.clearContents();
    if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
    sh.getRange(1, 1, rows.length, 1).setNumberFormat("@"); // keep ids as text
    sh.getRange(1, 1, rows.length, 3).setValues(rows);
    props.setProperty("playersFetchedAt", String(Date.now()));
  }

  const map = {};
  sh.getRange(1, 1, sh.getLastRow(), 3).getValues().forEach(r => {
    map[String(r[0])] = { name: String(r[1]), team: String(r[2]) };
  });
  return map;
}

function nameOf_(players, pid) {
  return players[pid] ? players[pid].name : String(pid);
}

/* --------------------------- Team map --------------------------- */

function rebuildTeamMap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosters = fetchJson_(`/league/${LEAGUE_ID}/rosters`);
  const users = fetchJson_(`/league/${LEAGUE_ID}/users`);
  const owners = {};
  users.forEach(u => { owners[u.user_id] = u.display_name || u.username || u.user_id; });
  getTeamMap_(ss, rosters, owners, getPlayers_(ss), true);
}

// roster_id -> { owner, team, code }. Kept in a visible "Team Map" sheet so
// you can fix it. Auto-fill: owner name on Power Rankings, else the team tab
// whose player list overlaps most with that roster.
function getTeamMap_(ss, rosters, owners, players, forceRebuild) {
  let sh = ss.getSheetByName(SHEETS.map);
  const map = {};
  if (sh && !forceRebuild && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(r => {
      if (r[0] !== "") map[String(r[0])] = { owner: String(r[1]), team: String(r[2]).trim(), code: String(r[3]).trim() };
    });
  }

  // Owner -> team name, and code -> team name, from Power Rankings
  const pr = ss.getSheetByName(SHEETS.power).getDataRange().getValues();
  const hdr = pr[0].map(h => String(h).trim().toLowerCase());
  const nameCol = hdr.indexOf("team name");
  const ownerCol = hdr.indexOf("owner/gm");
  const byOwner = {}, codeToName = {};
  pr.slice(1).forEach(r => {
    const team = String(r[nameCol]).trim();
    if (!team) return;
    const code = TEAM_CODES[team.toLowerCase()];
    if (code) codeToName[code] = team;
    const o = String(r[ownerCol]).trim().toLowerCase();
    if (o && o !== "unknown") byOwner[o] = team;
  });

  const taken = new Set(Object.values(map).map(t => t.code).filter(Boolean));
  let tabPlayers = null; // loaded only if needed

  rosters.forEach(r => {
    const id = String(r.roster_id);
    const owner = owners[r.owner_id] || "Unknown";
    if (map[id] && map[id].team) { map[id].owner = owner; return; }

    let team = byOwner[owner.toLowerCase()] || "";
    if (team && taken.has(TEAM_CODES[team.toLowerCase()])) team = "";

    if (!team) {
      // Fallback: match by roster contents against team tabs
      if (!tabPlayers) tabPlayers = loadTabPlayers_(ss, Object.keys(codeToName));
      const names = allPlayerIds_(r).map(pid => norm_(nameOf_(players, pid)));
      let best = null, bestScore = 0;
      Object.keys(tabPlayers).forEach(code => {
        if (taken.has(code)) return;
        const score = names.filter(n => tabPlayers[code].has(n)).length;
        if (score > bestScore) { bestScore = score; best = code; }
      });
      if (best && bestScore >= 3) team = codeToName[best];
    }

    const code = team ? (TEAM_CODES[team.toLowerCase()] || "") : "";
    if (code) taken.add(code);
    map[id] = { owner, team, code };
  });

  // Write the map back
  if (!sh) sh = ss.insertSheet(SHEETS.map);
  const ids = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  const out = [["Sleeper roster_id", "Sleeper owner", "Team name (as on Power Rankings)", "Team tab"]]
    .concat(ids.map(id => [id, map[id].owner, map[id].team, map[id].code]));
  sh.clearContents();
  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.getRange(1, 1, 1, 4).setFontWeight("bold");
  sh.setFrozenRows(1);
  return map;
}

function loadTabPlayers_(ss, codes) {
  const out = {};
  codes.forEach(code => {
    const tab = ss.getSheetByName(code);
    if (!tab) return;
    const vals = tab.getRange(1, 2, Math.min(40, tab.getMaxRows()), 1).getDisplayValues();
    out[code] = new Set(vals.map(v => norm_(v[0])).filter(Boolean));
  });
  return out;
}

function teamLabel_(teamMap, rosterId) {
  const t = teamMap[String(rosterId)];
  if (!t) return `Roster ${rosterId} (unmapped)`;
  return t.team || `${t.owner} (unmapped)`;
}

/* ---------------------------- Rosters --------------------------- */

// Same layout as the original script: one column per Sleeper roster,
// starters / blank / 8 bench / blank / 2 IR / blank / 5 taxi.
function writeRosters_(ss, rosters, owners, players) {
  const sheet = ss.getSheetByName(SHEETS.rosters);
  const toName = pid => (pid === "0" || !pid) ? "" : nameOf_(players, pid);
  const slots = (arr, n) => Array.from({ length: n }, (_, i) => (i < arr.length ? toName(arr[i]) : ""));

  const cols = rosters.map(r => {
    const starters = r.starters || [];
    const taxi = r.taxi || [];
    const reserve = r.reserve || [];
    const bench = (r.players || []).filter(pid =>
      !starters.includes(pid) && !taxi.includes(pid) && !reserve.includes(pid));
    return [owners[r.owner_id] || "Unknown"]
      .concat(starters.map(toName), [""], slots(bench, 8), [""], slots(reserve, 2), [""], slots(taxi, 5));
  });

  const maxRows = Math.max(...cols.map(c => c.length));
  cols.forEach(c => { while (c.length < maxRows) c.push(""); });
  const output = [];
  for (let i = 0; i < maxRows; i++) output.push(cols.map(c => c[i]));

  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearContent();
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

function allPlayerIds_(r) {
  const s = new Set([].concat(r.players || [], r.reserve || [], r.taxi || []));
  s.delete("0");
  return Array.from(s).filter(Boolean).map(String);
}

/* ------------------------ Change detection ---------------------- */

// Clears the roster snapshot AND the list of processed transactions.
// The next sync just records the current state and logs nothing.
function resetBaseline() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEETS.state, SHEETS.txns].forEach(n => {
    const sh = ss.getSheetByName(n);
    if (sh) sh.clearContents();
  });
  PropertiesService.getScriptProperties().deleteProperty("txnTrackingStarted");
}

// Main change step. Uses Sleeper's transaction list (exact team for every
// add/drop, draft picks, commissioner moves). Falls back to comparing
// roster snapshots if the transaction list can't be read.
function detectAndApplyChanges_(ss, rosters, players, teamMap) {
  let stateSh = ss.getSheetByName(SHEETS.state);
  if (!stateSh) { stateSh = ss.insertSheet(SHEETS.state); stateSh.hideSheet(); }

  const prev = {};
  if (stateSh.getLastRow() > 0) {
    stateSh.getRange(1, 1, stateSh.getLastRow(), 2).getValues().forEach(r => {
      if (r[0] !== "") prev[String(r[0])] = JSON.parse(r[1] || "[]");
    });
  }
  const curr = {};
  rosters.forEach(r => { curr[String(r.roster_id)] = allPlayerIds_(r); });

  const saveState = () => {
    const rows = Object.keys(curr).map(id => [id, JSON.stringify(curr[id])]);
    stateSh.clearContents();
    stateSh.getRange(1, 1, rows.length, 1).setNumberFormat("@");
    stateSh.getRange(1, 1, rows.length, 2).setValues(rows);
  };

  const hasBaseline = Object.keys(prev).length > 0;

  // Try the transaction list first
  let txns = null;
  try {
    txns = fetchRecentTransactions_();
  } catch (e) {
    Logger.log("Transaction list unavailable, using roster comparison: " + e);
  }

  const seen = loadSeenTxns_(ss);

  if (txns && seen.started) {
    applyTransactions_(ss, txns, seen, players, teamMap);
  } else if (!hasBaseline) {
    writeLog_(ss, [["Info", "—", "—", "Baseline saved. Changes will be logged from the next sync on.", ""]]);
  } else {
    // Roster comparison: used on the first sync of transaction tracking
    // (to catch anything since the last sync) and whenever Sleeper's
    // transaction list can't be fetched.
    applyRosterDiff_(ss, prev, curr, players, teamMap);
  }

  // Start tracking transactions: everything already in Sleeper's list
  // counts as handled, so nothing old gets re-applied.
  if (txns && !seen.started) {
    saveSeenTxns_(ss, txns.filter(t => t.status === "complete" || t.status === "failed").map(t => t.transaction_id), true);
    writeLog_(ss, [["Info", "—", "—", "Transaction tracking started. Moves from here on are read from Sleeper's transaction list.", ""]]);
  }

  saveState();
}

/* ---------------------- Sleeper transactions -------------------- */

// This leg's and last leg's transactions (covers the week rollover).
function fetchRecentTransactions_() {
  const state = fetchJson_("/state/nba");
  const leg = Number(state.leg || state.week || 1);
  const legs = [leg, leg - 1].filter(l => l >= 1);
  let all = [];
  legs.forEach(l => { all = all.concat(fetchJson_(`/league/${LEAGUE_ID}/transactions/${l}`) || []); });
  return all;
}

function loadSeenTxns_(ss) {
  const sh = ss.getSheetByName(SHEETS.txns);
  const ids = new Set();
  if (sh && sh.getLastRow() > 0) {
    sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues().forEach(r => { if (r[0]) ids.add(String(r[0])); });
  }
  const flag = PropertiesService.getScriptProperties().getProperty("txnTrackingStarted") === "1";
  return { ids, started: !!sh && flag };
}

function saveSeenTxns_(ss, newIds, replace) {
  let sh = ss.getSheetByName(SHEETS.txns);
  if (!sh) { sh = ss.insertSheet(SHEETS.txns); sh.hideSheet(); }
  const existing = replace ? [] : (sh.getLastRow() > 0
    ? sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues().map(r => String(r[0])).filter(Boolean) : []);
  const all = Array.from(new Set(existing.concat(newIds.map(String)))).slice(-3000); // keep it small
  sh.clearContents();
  if (all.length) {
    if (sh.getMaxRows() < all.length) sh.insertRowsAfter(sh.getMaxRows(), all.length - sh.getMaxRows());
    sh.getRange(1, 1, all.length, 1).setNumberFormat("@");
    sh.getRange(1, 1, all.length, 1).setValues(all.map(id => [id]));
  }
  PropertiesService.getScriptProperties().setProperty("txnTrackingStarted", "1");
}

function ordinal_(n) {
  return n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");
}

function applyTransactions_(ss, txns, seen, players, teamMap) {
  // New, finished transactions, oldest first (by when they went through)
  const fresh = txns
    .filter(t => !seen.ids.has(String(t.transaction_id)))
    .filter(t => t.status === "complete" || t.status === "failed")
    .sort((a, b) => (a.status_updated || a.created) - (b.status_updated || b.created));
  if (!fresh.length) return;

  const team = rid => teamLabel_(teamMap, rid);
  const entries = [];      // [type, teams, players, details, status, when]
  const history = {};      // pid -> [{from, to, entry}] in time order

  const track = (pid, from, to, entry) => {
    (history[pid] = history[pid] || []).push({ from: from != null ? String(from) : null, to: to != null ? String(to) : null, entry });
  };

  fresh.forEach(t => {
    if (t.status !== "complete") return; // failed waiver claims etc.: skip
    const when = new Date(t.status_updated || t.created);
    const adds = t.adds || {}, drops = t.drops || {};
    const pids = Array.from(new Set(Object.keys(adds).concat(Object.keys(drops))));
    const prefix = t.type === "commissioner" ? "Commissioner " : t.type === "waiver" ? "Waiver " : "";
    const label = word => prefix ? prefix + word : word.charAt(0).toUpperCase() + word.slice(1);

    if (t.type === "trade") {
      const rids = (t.roster_ids || []).map(String);
      const parts = rids.map(rid => {
        const got = pids.filter(p => String(adds[p]) === rid).map(p => nameOf_(players, p));
        const picks = (t.draft_picks || [])
          .filter(pk => String(pk.owner_id) === rid && String(pk.previous_owner_id) !== rid)
          .map(pk => {
            const orig = String(pk.roster_id) === rid ? "own" : team(pk.roster_id) + "'s";
            return `${pk.season} ${ordinal_(pk.round)} (${orig})`;
          });
        const items = got.concat(picks);
        return items.length ? `${team(rid)} gets: ${items.join(", ")}` : `${team(rid)} gets: nothing`;
      });
      const entry = ["Trade", rids.map(team).join(" ↔ "), parts.join("  |  "), "", "Logged", when];
      entries.push(entry);
      pids.forEach(p => {
        if (adds[p] != null) track(p, drops[p], adds[p], null);
        else { // dropped as part of the trade to make room
          const e = ["Drop", team(drops[p]), nameOf_(players, p), "Dropped as part of a trade", "", when];
          entries.push(e);
          track(p, drops[p], null, e);
        }
      });
      return;
    }

    // Commissioner moves of a player between two teams: one entry per transaction
    const moved = pids.filter(p => adds[p] != null && drops[p] != null);
    if (moved.length) {
      entries.push([label("move"), (t.roster_ids || []).map(team).join(" ↔ "),
        moved.map(p => `${nameOf_(players, p)}: ${team(drops[p])} → ${team(adds[p])}`).join(", "),
        "", "Logged", when]);
      moved.forEach(p => track(p, drops[p], adds[p], null));
    }
    pids.filter(p => adds[p] != null && drops[p] == null).forEach(p => {
      const e = [label("add"), team(adds[p]), nameOf_(players, p), "", "", when];
      entries.push(e);
      track(p, null, adds[p], e);
    });
    pids.filter(p => drops[p] != null && adds[p] == null).forEach(p => {
      const e = [label("drop"), team(drops[p]), nameOf_(players, p), "", "", when];
      entries.push(e);
      track(p, drops[p], null, e);
    });
  });

  // Net effect per player over this batch decides the sheet changes, so an
  // add that was undone within the same sync doesn't create anything.
  Object.keys(history).forEach(pid => {
    const h = history[pid];
    const startedOnRoster = h[0].from != null;
    const endsOnRoster = h[h.length - 1].to != null;
    const last = h.filter(x => x.entry).pop(); // the add/drop row to report on
    const name = nameOf_(players, pid);

    if (startedOnRoster && !endsOnRoster) {
      // Drop: cap hold goes to the team that actually dropped him last
      const dropper = h[h.length - 1].from;
      const t = teamMap[dropper] || {};
      const master = makeCapHoldOnMaster_(ss, name);
      const holdName = (master.masterName || name) + " (cap hold)";
      const tab = t.code ? addCapHoldToTeamTab_(ss, t.code, holdName)
                         : "⚠ Team not mapped; add the cap hold to the team tab by hand";
      if (t.code) appendCapHold_(ss, t.code, holdName, "Dropped (sync)");
      if (last) { last.entry[3] = `${master.msg}; ${tab}`; last.entry[4] = master.ok ? "Cap hold created" : "⚠ Review"; }
    } else if (!startedOnRoster && endsOnRoster) {
      const nba = players[pid] ? players[pid].team : "";
      const res = addPendingToMaster_(ss, name, nba);
      if (last) { last.entry[3] = res.msg; last.entry[4] = res.created ? "⏳ Needs contract" : "OK"; }
    }
    // Any add/drop rows left without a result were cancelled out in this batch
    h.forEach(x => {
      if (x.entry && !x.entry[4]) {
        x.entry[3] = x.entry[3] || "Reversed within the same sync; no sheet changes";
        x.entry[4] = "No change";
      }
    });
  });

  writeLog_(ss, entries.slice().reverse()); // newest on top
  saveSeenTxns_(ss, fresh.map(t => t.transaction_id), false);
}

/* ------------------- Roster comparison (backup) ----------------- */

function applyRosterDiff_(ss, prev, curr, players, teamMap) {
  const prevOwner = {}, currOwner = {};
  Object.keys(prev).forEach(id => prev[id].forEach(p => { prevOwner[p] = id; }));
  Object.keys(curr).forEach(id => curr[id].forEach(p => { currOwner[p] = id; }));

  const moves = [], drops = [], adds = [];
  new Set(Object.keys(prevOwner).concat(Object.keys(currOwner))).forEach(p => {
    const from = prevOwner[p], to = currOwner[p];
    if (from && to && from !== to) moves.push({ p, from, to });
    else if (from && !to) drops.push({ p, from });
    else if (!from && to) adds.push({ p, to });
  });

  const entries = [];
  const note = "(from roster comparison)";

  const groups = {};
  moves.forEach(m => {
    const [a, b] = [m.from, m.to].sort((x, y) => Number(x) - Number(y));
    const key = a + "|" + b;
    if (!groups[key]) groups[key] = { a, b, toA: [], toB: [] };
    (m.to === a ? groups[key].toA : groups[key].toB).push(nameOf_(players, m.p));
  });
  Object.values(groups).forEach(g => {
    const A = teamLabel_(teamMap, g.a), B = teamLabel_(teamMap, g.b);
    const parts = [];
    if (g.toA.length) parts.push(`${A} gets: ${g.toA.join(", ")}`);
    if (g.toB.length) parts.push(`${B} gets: ${g.toB.join(", ")}`);
    entries.push(["Trade", `${A} ↔ ${B}`, parts.join("  |  "), note, "Logged"]);
  });

  drops.forEach(d => {
    const name = nameOf_(players, d.p);
    const t = teamMap[d.from] || {};
    const master = makeCapHoldOnMaster_(ss, name);
    const holdName = (master.masterName || name) + " (cap hold)";
    const tab = t.code ? addCapHoldToTeamTab_(ss, t.code, holdName)
                       : "⚠ Team not mapped; add the cap hold to the team tab by hand";
    if (t.code) appendCapHold_(ss, t.code, holdName, "Dropped (sync, roster comparison)");
    entries.push(["Drop", teamLabel_(teamMap, d.from), name, `${master.msg}; ${tab} ${note}`,
      master.ok ? "Cap hold created" : "⚠ Review"]);
  });

  adds.forEach(a => {
    const name = nameOf_(players, a.p);
    const nba = players[a.p] ? players[a.p].team : "";
    const res = addPendingToMaster_(ss, name, nba);
    entries.push(["Add", teamLabel_(teamMap, a.to), name, `${res.msg} ${note}`,
      res.created ? "⏳ Needs contract" : "OK"]);
  });

  writeLog_(ss, entries);
}

/* --------------------------- League Log ------------------------- */

// entries: [type, team(s), player(s), details, status, optional Date]
// The timestamp is when the move went through in Sleeper when known,
// otherwise the time of this sync.
function writeLog_(ss, entries) {
  let sh = ss.getSheetByName(SHEETS.log);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.log);
    sh.getRange(1, 1, 1, 6).setValues([["Timestamp", "Type", "Team(s)", "Player(s)", "Details", "Status"]])
      .setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.setColumnWidth(4, 320);
    sh.setColumnWidth(5, 420);
  }
  if (!entries.length) return;
  const now = new Date();
  sh.insertRowsAfter(1, entries.length); // newest on top
  const rng = sh.getRange(2, 1, entries.length, 6);
  rng.setValues(entries.map(e => [e[5] instanceof Date ? e[5] : now].concat(e.slice(0, 5))));
  rng.setFontWeight("normal");
  sh.getRange(2, 1, entries.length, 1).setNumberFormat("m/d/yyyy h:mm am/pm");
}

// Every sync stamps H1:I1 on League Log, so you can see it ran even when
// there were no roster changes (no extra rows added).
function stampLastSync_(ss) {
  writeLog_(ss, []); // makes sure the sheet exists
  const sh = ss.getSheetByName(SHEETS.log);
  sh.getRange("H1:I1").setValues([["Last synced:", new Date()]]);
  sh.getRange("H1").setFontWeight("bold");
  sh.getRange("I1").setNumberFormat("m/d/yyyy h:mm:ss am/pm");
}

/* --------------------------- Master list ------------------------ */

function norm_(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
}

const HOLD_RE = /\s*\(cap hold\)\s*/i;

// Finds rows in Master list column A whose name matches. Returns
// { active: [rowNumbers], holds: [rowNumbers], names: {row: text} }
function findOnMaster_(sh, name) {
  const key = norm_(name);
  const last = sh.getLastRow();
  const vals = sh.getRange(1, 1, last, 1).getDisplayValues();
  const out = { active: [], holds: [], names: {} };
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i][0];
    if (!v) continue;
    if (norm_(v.replace(HOLD_RE, "")) !== key) continue;
    out.names[i + 1] = v;
    (HOLD_RE.test(v) ? out.holds : out.active).push(i + 1);
  }
  return out;
}

// Drop: rename the existing contract row to "Name (cap hold)".
// Team, salaries and status codes stay as they are.
function makeCapHoldOnMaster_(ss, name) {
  const sh = ss.getSheetByName(SHEETS.master);
  const f = findOnMaster_(sh, name);
  if (f.active.length) {
    const row = f.active[0];
    const masterName = f.names[row];
    sh.getRange(row, 1).setValue(masterName + " (cap hold)");
    const extra = f.active.length > 1 ? ` (he has ${f.active.length} rows; only the first was converted)` : "";
    return { ok: true, masterName, msg: `Master list row ${row} → cap hold${extra}` };
  }
  if (f.holds.length) {
    return { ok: true, masterName: f.names[f.holds[0]].replace(HOLD_RE, ""), msg: "Already a cap hold on Master list" };
  }
  return { ok: false, masterName: name, msg: "⚠ Not found on Master list" };
}

// Add: new row at the end of his NBA team's block, marked PENDING.
// An existing cap hold does NOT count as "already there" (re-signed waived player).
function addPendingToMaster_(ss, name, nbaTeam) {
  const sh = ss.getSheetByName(SHEETS.master);
  const f = findOnMaster_(sh, name);
  if (f.active.length) {
    return { created: false, msg: `Already on Master list (row ${f.active[0]}); no new entry` };
  }

  const ins = insertMasterRowForTeam_(sh, nbaTeam);
  const newRow = ins.row, code = ins.code;
  sh.getRange(newRow, 1, 1, 2).setValues([[name, code]]);
  sh.getRange(newRow, 10).setValue("PENDING — needs contract");

  const holdNote = f.holds.length ? " (his old cap hold row is still there)" : "";
  const where = ins.inBlock ? `${code} block` : `end of list (no ${code} block found)`;
  return { created: true, msg: `New Master list row ${newRow}, ${where}${holdNote}. Waiting on your contract input` };
}

// Inserts an empty row at the end of an NBA team's block (column B), with the
// format of the row above and A:R cleared. Never touches column S.
// Returns { row, code, inBlock }.
function insertMasterRowForTeam_(sh, nbaTeam) {
  let code = String(nbaTeam || "").trim().toUpperCase();
  code = NBA_ABBR_FIX[code] || code || "Z";

  const last = sh.getLastRow();
  const colB = sh.getRange(1, 2, last, 1).getDisplayValues();
  let teamEnd = -1;
  for (let i = 1; i < colB.length; i++) if (String(colB[i][0]).trim() === code) teamEnd = i + 1;

  const anchor = teamEnd > 0 ? teamEnd : last;
  sh.insertRowAfter(anchor);
  const row = anchor + 1;
  sh.getRange(anchor, 1, 1, MASTER_LAST_COL)
    .copyTo(sh.getRange(row, 1, 1, MASTER_LAST_COL), { formatOnly: true });
  sh.getRange(row, 1, 1, MASTER_LAST_COL).clearContent();
  sh.getRange(row, 3, 1, 7).setBackground(null); // salary cols: let conditional formatting colour them
  return { row, code, inBlock: teamEnd > 0 };
}

/* -------------------------- Team tab holds ---------------------- */

// Adds "Name (cap hold)" under the tab's CAP HOLDS header. Uses an empty
// "Cap Hold" row if there is one; otherwise inserts a row INSIDE the existing
// block (so Total Payroll sums expand) with the same formulas/format.
function addCapHoldToTeamTab_(ss, code, holdName) {
  const sh = ss.getSheetByName(code);
  if (!sh) return `⚠ No tab named ${code}`;

  const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getDisplayValues();
  let header = -1;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][1]).trim().toUpperCase() === "CAP HOLDS") { header = i + 1; break; }
  }
  if (header < 0) return `⚠ No CAP HOLDS section on ${code}`;

  const rows = [];
  for (let r = header + 1; r <= vals.length; r++) {
    if (String(vals[r - 1][0]).trim().toLowerCase() === "cap hold") rows.push(r);
    else break;
  }

  const target = norm_(holdName.replace(HOLD_RE, ""));
  if (rows.some(r => norm_(String(vals[r - 1][1]).replace(HOLD_RE, "")) === target)) {
    return `already in ${code} cap holds`;
  }

  const empty = rows.find(r => !String(vals[r - 1][1]).trim());
  if (empty) {
    sh.getRange(empty, 2).setValue(holdName);
    return `added to ${code} cap holds (row ${empty})`;
  }

  const width = sh.getLastColumn();
  if (!rows.length) {
    sh.insertRowAfter(header);
    sh.getRange(header + 1, 1, 1, 2).setValues([["Cap Hold", holdName]]);
    return `added to ${code} cap holds (row ${header + 1}). ⚠ This was the first hold, so check that Total Payroll includes it`;
  }

  const last = rows[rows.length - 1];
  sh.insertRowBefore(last); // new row lands at `last`, old last moves to last+1
  sh.getRange(last + 1, 1, 1, width).copyTo(sh.getRange(last, 1, 1, width)); // old last's row copied up
  sh.getRange(last + 1, 2).setValue(holdName); // old row's slot becomes the new hold
  return `added to ${code} cap holds (row ${last + 1})`;
}

/* ------------------------- Power Rankings ----------------------- */

function updatePowerRankings_(ss, rosters, teamMap) {
  const sh = ss.getSheetByName(SHEETS.power);
  const vals = sh.getDataRange().getValues();
  const hdr = vals[0].map(h => String(h).trim().toLowerCase());
  const cName = hdr.indexOf("team name");
  const cols = { pf: hdr.indexOf("team pf"), w: hdr.indexOf("w"), l: hdr.indexOf("l"), t: hdr.indexOf("t") };
  if (cName < 0 || Object.values(cols).some(c => c < 0)) {
    Logger.log("Power Rankings headers not found; skipped.");
    return;
  }

  const stats = {};
  rosters.forEach(r => {
    const t = teamMap[String(r.roster_id)];
    if (!t || !t.team) return;
    const s = r.settings || {};
    stats[t.team.toLowerCase()] = {
      pf: Math.round(((s.fpts || 0) + (s.fpts_decimal || 0) / 100) * 100) / 100,
      w: s.wins || 0, l: s.losses || 0, t: s.ties || 0,
    };
  });

  const n = vals.length - 1;
  if (n < 1) return;
  Object.keys(cols).forEach(k => {
    const col = cols[k];
    const out = vals.slice(1).map(row => {
      const st = stats[String(row[cName]).trim().toLowerCase()];
      return [st ? st[k] : row[col]];
    });
    sh.getRange(2, col + 1, n, 1).setValues(out);
  });
}

/* ---------------------------- Trigger --------------------------- */

function createFiveMinuteTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "syncSleeperLeague") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncSleeperLeague").timeBased().everyMinutes(5).create();
}