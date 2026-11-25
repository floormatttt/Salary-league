/******************************************************************
 * Commissioner tools for the league site.
 *
 * Login: a passcode whose salted SHA-256 hash lives in Script Properties
 * (Sync League > Set commissioner passcode…). 10 wrong tries lock the
 * login for 10 minutes. A good login gets a session token (6 hours).
 *
 * Every write goes through adminWrite_(): it checks the token, takes the
 * script lock, clears the site cache and adds a row to "Admin Log".
 * Master list writes stay inside A:R; column S is an ARRAYFORMULA.
 ******************************************************************/

const ADMIN = {
  maxFails: 10,
  lockMinutes: 10,
  sessionSeconds: 6 * 3600,
  minFill: "#4a86e8", // blue UFA cell on a new minimum contract
};

/* ============================ Passcode =========================== */

function setCommissionerPasscode() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt("Commissioner passcode", "New passcode for the site's admin page (at least 6 characters):", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pass = res.getResponseText();
  if (pass.length < 6) { ui.alert("Too short. Nothing saved."); return; }
  setPasscode_(pass);
  ui.alert("Saved. Anyone signed in to the admin page with the old passcode keeps their session until it expires.");
}

function setPasscode_(pass) {
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    adminSalt: salt, adminHash: sha256Hex_(salt + pass), adminFails: "0", adminLockUntil: "0",
  });
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0")).join("");
}

function adminLogin(pass) {
  const props = PropertiesService.getScriptProperties();
  const p = props.getProperties();
  if (!p.adminHash) return { ok: false, msg: "No passcode is set yet. Set one from the sheet: Sync League > Set commissioner passcode…" };
  const until = Number(p.adminLockUntil || 0);
  if (until > Date.now()) {
    return { ok: false, msg: `Too many wrong tries. Try again in ${Math.ceil((until - Date.now()) / 60000)} min.` };
  }
  if (sha256Hex_((p.adminSalt || "") + String(pass || "")) !== p.adminHash) {
    const fails = Number(p.adminFails || 0) + 1;
    if (fails >= ADMIN.maxFails) {
      props.setProperties({ adminFails: "0", adminLockUntil: String(Date.now() + ADMIN.lockMinutes * 60000) });
      return { ok: false, msg: `Wrong passcode. Login is locked for ${ADMIN.lockMinutes} minutes.` };
    }
    props.setProperty("adminFails", String(fails));
    return { ok: false, msg: `Wrong passcode (${ADMIN.maxFails - fails} tries left).` };
  }
  props.setProperties({ adminFails: "0", adminLockUntil: "0" });
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("adm_" + token, "1", ADMIN.sessionSeconds);
  return { ok: true, token };
}

function adminCheck(token) {
  return { ok: !!(token && CacheService.getScriptCache().get("adm_" + token)) };
}

function requireAdmin_(token) {
  if (!adminCheck(token).ok) throw new Error("Your admin session expired. Sign in again.");
}

// The one path for every commissioner write.
function adminWrite_(token, action, fn) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("The sheet is busy (a sync may be running). Try again in a moment.");
  try {
    const ss = openSs_();
    const res = fn(ss) || {};
    logAdmin_(ss, action, res.log || "");
    SpreadsheetApp.flush();
    clearSiteCache_();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function logAdmin_(ss, action, details) {
  let sh = ss.getSheetByName(SITE_SHEETS.admin);
  if (!sh) {
    sh = ss.insertSheet(SITE_SHEETS.admin);
    sh.getRange(1, 1, 1, 3).setValues([["Time", "Action", "Details"]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date(), action, details]);
}

/* ========================= Master list =========================== */

// Throws unless row still holds the name the page was looking at.
function checkMasterRow_(sh, row, expect) {
  row = Number(row);
  if (!(row >= 2) || row > sh.getLastRow()) throw new Error(`Master list row ${row} doesn't exist anymore. Reload and try again.`);
  const now = String(sh.getRange(row, 1).getDisplayValue()).trim();
  if (now !== String(expect || "").trim()) {
    throw new Error(`Master list row ${row} is now "${now}", not "${expect}". The list changed; reload and try again.`);
  }
  return row;
}

function salCell_(v) {
  if (v == null || v === "") return "";
  if (/^(UFA|RFA)$/i.test(String(v))) return String(v).toUpperCase();
  const n = parseSal_(v);
  if (n == null) throw new Error(`"${v}" isn't a salary. Use a number, UFA or RFA.`);
  return n;
}

// c = { row?, expect?, n, nba, sal[7], st[7], det }. No row -> new row in the NBA team's block.
function adminSaveContract(token, c) {
  return adminWrite_(token, c.row ? "Edit contract" : "Add contract", ss => {
    const sh = ss.getSheetByName(SHEETS.master);
    const name = String(c.n || "").trim();
    if (!name) throw new Error("A contract needs a player name.");
    const sal = (c.sal || []).slice(0, 7).map(salCell_);
    const st = (c.st || []).slice(0, 7).map(s => String(s || "").trim().toUpperCase());
    while (sal.length < 7) sal.push("");
    while (st.length < 7) st.push("");
    st.forEach(s => { if (s && !/^(PO|TO|MAX|SMAX|HOLD)$/.test(s)) throw new Error(`Unknown status "${s}".`); });

    let row, nba = String(c.nba || "").trim().toUpperCase() || "Z";
    if (c.row) {
      row = checkMasterRow_(sh, c.row, c.expect);
    } else {
      const ins = insertMasterRowForTeam_(sh, nba);
      row = ins.row; nba = ins.code;
    }
    const keepK = sh.getRange(row, 11).getValue(); // label column: leave whatever is there
    const out = [name, nba].concat(sal, [String(c.det || ""), keepK], st);
    sh.getRange(row, 1, 1, MASTER_LAST_COL).setValues([out]); // A:R only
    return { row, log: `Row ${row}: ${name} (${nba}) ${sal.filter(v => v !== "").join(" / ")}${c.det ? " · " + c.det : ""}` };
  });
}

function adminDeleteContract(token, d) {
  return adminWrite_(token, "Delete contract", ss => {
    const sh = ss.getSheetByName(SHEETS.master);
    const row = checkMasterRow_(sh, d.row, d.expect);
    if (row === 2) {
      // Row 2 holds the column-S ARRAYFORMULA; deleting it would break S. Pull row 3 up instead.
      if (sh.getLastRow() >= 3) {
        sh.getRange(3, 1, 1, MASTER_LAST_COL).copyTo(sh.getRange(2, 1, 1, MASTER_LAST_COL));
        sh.deleteRow(3);
      } else {
        sh.getRange(2, 1, 1, MASTER_LAST_COL).clearContent();
      }
    } else {
      sh.deleteRow(row);
    }
    return { log: `Deleted row ${row}: ${d.expect}` };
  });
}

/* =========================== Cap holds =========================== */

function requireTable_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`The "${name}" table isn't set up yet. In the sheet: Sync League > Set up site tables.`);
  return sh;
}

// Make a player a cap hold for a team: rename his Master list row (if it
// isn't a hold already) and add the hold to Cap Holds + the team tab.
function adminAddHold(token, h) {
  return adminWrite_(token, "Add cap hold", ss => {
    requireTable_(ss, SITE_SHEETS.holds);
    const code = String(h.code || "").trim();
    if (Object.values(TEAM_CODES).indexOf(code) < 0) throw new Error("Pick a team.");
    const plain = cleanName_(h.name);
    if (!plain) throw new Error("Pick a player.");
    const master = makeCapHoldOnMaster_(ss, plain);
    if (!master.ok) throw new Error(`${plain} isn't on the Master list. Add his contract first.`);
    const holdName = master.masterName.replace(HOLD_RE, "").trim() + " (cap hold)";
    const added = appendCapHold_(ss, code, holdName, String(h.note || "Added on site"));
    const tab = addCapHoldToTeamTab_(ss, code, holdName);
    return { log: `${holdName} → ${code}. ${master.msg}; ${tab}${added ? "" : " (already in Cap Holds)"}` };
  });
}

// Removes the Cap Holds row (and the team tab's Cap Hold cell). The Master
// list row stays, so it can be deleted separately if the hold is gone for good.
function adminRemoveHold(token, h) {
  return adminWrite_(token, "Remove cap hold", ss => {
    const sh = requireTable_(ss, SITE_SHEETS.holds);
    const row = Number(h.row);
    const cur = row >= 2 && row <= sh.getLastRow() ? sh.getRange(row, 1, 1, 2).getDisplayValues()[0] : null;
    if (!cur || cur[0].trim() !== h.code || cur[1].trim() !== h.name) {
      throw new Error("That cap hold moved or was already removed. Reload and try again.");
    }
    sh.deleteRow(row);
    const tab = removeCapHoldFromTeamTab_(ss, h.code, h.name);
    return { log: `${h.name} removed from ${h.code}. ${tab}` };
  });
}

function removeCapHoldFromTeamTab_(ss, code, holdName) {
  const sh = ss.getSheetByName(code);
  if (!sh) return `no ${code} tab`;
  const key = norm_(cleanName_(holdName));
  const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getDisplayValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === "cap hold" && norm_(cleanName_(vals[i][1])) === key) {
      sh.getRange(i + 1, 2).clearContent();
      return `cleared ${code} tab row ${i + 1}`;
    }
  }
  return `not on the ${code} tab`;
}

/* ===================== Waived & re-signed ======================== */
// Follows the cap-hold-and-min-contract procedure:
//  1. old Master list row -> "Name (cap hold)" (team, salaries, statuses untouched)
//  2. new row at the end of his NBA team's block: Name | team | 2 | UFA, D filled #4a86e8
//  3. a team tab Cap Hold cell with his plain name becomes "Name (cap hold)";
//     if no team tab holds him, ask which team carries the hold (code)
// w = { name, code? }  ->  { needTeam: true } when the hold's team is unclear
function adminWaiveResign(token, w) {
  const plain = cleanName_(w && w.name);
  if (!plain) throw new Error("Pick a player.");
  requireAdmin_(token);
  const code = String(w.code || "").trim();
  if (!code) {
    const ss = openSs_();
    const found = findPlainCapHoldOnTabs_(ss, plain);
    if (!found) return { needTeam: true, msg: `No team tab lists ${plain} in a Cap Hold row. Which team carries his cap hold?` };
    w = Object.assign({}, w, { code: found.code });
  }
  return adminWrite_(token, "Waived & re-signed", ss => {
    const sh = ss.getSheetByName(SHEETS.master);
    const f = findOnMaster_(sh, plain);
    if (!f.active.length) throw new Error(`${plain} has no active Master list row to turn into a cap hold.`);
    const oldRow = f.active[0];
    const masterName = f.names[oldRow];
    const nba = String(sh.getRange(oldRow, 2).getDisplayValue()).trim() || "Z";
    const holdName = masterName + " (cap hold)";

    sh.getRange(oldRow, 1).setValue(holdName);                           // step 1
    const ins = insertMasterRowForTeam_(sh, nba);                        // step 2
    sh.getRange(ins.row, 1, 1, 4).setValues([[masterName, ins.code, 2, "UFA"]]);
    sh.getRange(ins.row, 4).setBackground(ADMIN.minFill);
    const renamedRow = ins.row <= oldRow ? oldRow + 1 : oldRow;

    const onTab = findPlainCapHoldOnTabs_(ss, plain);                    // step 3
    let tab;
    if (onTab && onTab.code === w.code) {
      ss.getSheetByName(onTab.code).getRange(onTab.row, 2).setValue(holdName);
      tab = `${onTab.code} tab row ${onTab.row} renamed`;
    } else {
      tab = addCapHoldToTeamTab_(ss, w.code, holdName);
    }
    if (ss.getSheetByName(SITE_SHEETS.holds)) appendCapHold_(ss, w.code, holdName, "Waived & re-signed");
    return {
      oldRow: renamedRow, newRow: ins.row, code: w.code,
      log: `${masterName}: row ${renamedRow} → cap hold (${w.code}); new $2.0 / UFA row ${ins.row} (${ins.code}); ${tab}`,
    };
  });
}

// A team tab Cap Hold row that still has the plain name (no "(cap hold)")
function findPlainCapHoldOnTabs_(ss, plain) {
  const key = norm_(plain);
  for (const code of Object.values(TEAM_CODES)) {
    const sh = ss.getSheetByName(code);
    if (!sh || sh.getLastRow() < 1) continue;
    const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getDisplayValues();
    for (let i = 0; i < vals.length; i++) {
      const v = String(vals[i][1] || "");
      if (String(vals[i][0]).trim().toLowerCase() === "cap hold" && !HOLD_RE.test(v) && norm_(v) === key) {
        return { code, row: i + 1 };
      }
    }
  }
  return null;
}

/* ============================== Cash ============================= */

function ledgerBalance_(ss, code, season) {
  return readCash_(ss, season).reduce((s, x) => (x.code === code && x.season === season ? s + x.amt : s), 0);
}

// t = { season, from, to, amt, note, ref, override }. Two rows: +amt for the
// sender (adds to its payroll), -amt for the receiver.
function adminRecordCash(token, t) {
  return adminWrite_(token, "Record cash", ss => {
    const sh = requireTable_(ss, SITE_SHEETS.cash);
    const amt = Math.round(Number(t.amt) * 10) / 10;
    if (!(amt > 0)) throw new Error("Amount must be more than $0.");
    const codes = Object.values(TEAM_CODES);
    if (codes.indexOf(t.from) < 0 || codes.indexOf(t.to) < 0 || t.from === t.to) throw new Error("Pick two different teams.");
    const season = String(t.season || "").trim();
    if (!/^\d{4}-\d{2}$/.test(season)) throw new Error("Season looks like 2026-27.");
    const after = { [t.from]: ledgerBalance_(ss, t.from, season) + amt, [t.to]: ledgerBalance_(ss, t.to, season) - amt };
    const bad = Object.keys(after).filter(k => Math.abs(after[k]) > LIMITS.cash + 1e-9);
    if (bad.length && !t.override) {
      throw new Error(bad.map(k => `${k} would be at ${after[k] > 0 ? "+" : "-"}$${Math.abs(after[k]).toFixed(1)}M`).join(", ") +
        ` (limit ±$${LIMITS.cash}M). Check "override" to record it anyway.`);
    }
    const now = new Date(), note = String(t.note || ""), ref = String(t.ref || "");
    sh.getRange(sh.getLastRow() + 1, 1, 2, 6).setValues([
      [now, season, t.from, amt, note || `Sent to ${t.to}`, ref],
      [now, season, t.to, -amt, note || `Received from ${t.from}`, ref],
    ]);
    return { log: `${season}: ${t.from} sent $${amt.toFixed(1)}M to ${t.to}${bad.length ? " (override)" : ""}${note ? " · " + note : ""}` };
  });
}

function adminDeleteCash(token, d) {
  return adminWrite_(token, "Delete cash row", ss => {
    const sh = requireTable_(ss, SITE_SHEETS.cash);
    const row = Number(d.row);
    const cur = row >= 2 && row <= sh.getLastRow() ? sh.getRange(row, 1, 1, 6).getDisplayValues()[0] : null;
    if (!cur || cur[2].trim() !== d.code || parseSal_(cur[3]) !== Number(d.amt)) {
      throw new Error("That ledger row moved or was already deleted. Reload and try again.");
    }
    sh.deleteRow(row);
    return { log: `Deleted ledger row ${row}: ${cur[1]} ${cur[2]} ${cur[3]} ${cur[4]}` };
  });
}

/* ========================== Rankings ============================= */

// ranks = [{ name, rank }] keyed by Team Name on Team Power Rankings
function adminSetRanks(token, ranks) {
  return adminWrite_(token, "Power rankings", ss => {
    const sh = ss.getSheetByName(SHEETS.power);
    const vals = sh.getDataRange().getDisplayValues();
    const hdr = vals[0].map(h => String(h).trim().toLowerCase());
    const cR = hdr.indexOf("ranking"), cN = hdr.indexOf("team name");
    if (cR < 0 || cN < 0) throw new Error("Couldn't find the Ranking / Team Name columns.");
    const want = {};
    (ranks || []).forEach(r => { want[String(r.name).trim().toLowerCase()] = r.rank === "" || r.rank == null ? "" : Number(r.rank); });
    const changed = [];
    const out = vals.slice(1).map(r => {
      const k = String(r[cN]).trim().toLowerCase();
      if (!(k in want)) return [r[cR]];
      if (String(want[k]) !== String(r[cR]).trim()) changed.push(`${String(r[cN]).trim()} ${r[cR] || "—"}→${want[k] === "" ? "—" : want[k]}`);
      return [want[k]];
    });
    if (out.length) sh.getRange(2, cR + 1, out.length, 1).setValues(out);
    return { log: changed.join(", ") || "No changes" };
  });
}

/* ======================= Payroll check / sync ==================== */

// Each team tab's "Total Payroll:" row by season, plus the names listed on
// the tab. The page compares these to its own payroll (LeagueMath.teamBook)
// and lists the differences and any rostered player the tab is missing.
function adminPayrollCheck(token) {
  requireAdmin_(token);
  const ss = openSs_();
  const totals = {}, names = {};
  Object.values(TEAM_CODES).forEach(code => {
    const sh = ss.getSheetByName(code);
    totals[code] = null; names[code] = [];
    if (!sh || sh.getLastRow() < 1) return;
    const vals = sh.getRange(1, 1, sh.getLastRow(), Math.min(sh.getLastColumn(), 10)).getDisplayValues();
    names[code] = vals.slice(1).map(v => String(v[1] || "").trim()).filter(Boolean);
    const r = vals.find(v => v.some(x => /^total payroll/i.test(String(x).trim())));
    if (!r) return;
    const i = r.findIndex(x => /^total payroll/i.test(String(x).trim()));
    totals[code] = r.slice(i + 1, i + 8).map(parseSal_);
  });
  return { totals, names };
}

function adminRunSync(token) {
  requireAdmin_(token);
  syncSleeperLeague(); // takes its own lock and clears the site cache
  const ss = openSs_();
  logAdmin_(ss, "Run sync", "From the site");
  return { ok: true, lastSync: lastSync_(ss) };
}

function adminGetLog(token) {
  requireAdmin_(token);
  const sh = openSs_().getSheetByName(SITE_SHEETS.admin);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(sh.getLastRow() - 1, 300);
  return sh.getRange(sh.getLastRow() - n + 1, 1, n, 3).getDisplayValues()
    .map(r => ({ time: r[0], action: r[1], details: r[2] })).reverse();
}

/* ========================= One-time setup ======================== */

function setupSiteTables() {
  const ui = SpreadsheetApp.getUi();
  const res = setupSiteTables_(SpreadsheetApp.getActiveSpreadsheet(), name =>
    ui.alert("Set up site tables", `"${name}" already has data. Replace it with a fresh migration from the team tabs?`, ui.ButtonSet.YES_NO) === ui.Button.YES);
  // The old in-sheet popup is gone; remove its on-open trigger if it was turned on
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "autoOpenPopup") ScriptApp.deleteTrigger(t); });
  clearSiteCache_();
  ui.alert("Site tables", res.join("\n"), ui.ButtonSet.OK);
}

// confirmOverwrite(name) -> true to replace a table that already has rows
function setupSiteTables_(ss, confirmOverwrite) {
  const masterSeason = readMaster_(ss).seasons[0];
  const tables = [
    { name: SITE_SHEETS.holds, hdr: ["Team code", "Player", "Added", "Note"],
      rows: () => holdsFromTeamTabs_(ss).map(h => [h[0], h[1], new Date(), h[3]]) },
    { name: SITE_SHEETS.cash, hdr: ["Date", "Season", "Team code", "Amount", "Note", "Trade ref"],
      rows: () => cashFromTeamTabs_(ss).map(c => [new Date(), masterSeason, c.code, c.amt, "Opening balance", ""]) },
    { name: SITE_SHEETS.admin, hdr: ["Time", "Action", "Details"], rows: () => [] },
  ];
  const report = [];
  tables.forEach(t => {
    let sh = ss.getSheetByName(t.name);
    if (sh && sh.getLastRow() > 1 && !confirmOverwrite(t.name)) { report.push(`${t.name}: kept as is.`); return; }
    if (!sh) sh = ss.insertSheet(t.name);
    sh.clearContents();
    const rows = t.rows();
    sh.getRange(1, 1, 1, t.hdr.length).setValues([t.hdr]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (t.name === SITE_SHEETS.cash) sh.getRange(2, 2, Math.max(rows.length, 1) + 500, 1).setNumberFormat("@"); // keep "2026-27" as text
    if (rows.length) sh.getRange(2, 1, rows.length, t.hdr.length).setValues(rows);
    report.push(`${t.name}: ${rows.length} row${rows.length === 1 ? "" : "s"}.`);
  });
  return report;
}
