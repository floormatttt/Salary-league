// Fake Apps Script runtime. Loads src/*.gs into a vm context backed by
// fixtures/workbook.json (sheet display values) and fixtures/sleeper/*.json.
//
//   const gas = makeGas();            // fresh copy of the workbook every call
//   gas.ctx.getLeague()               // call any server function
//   gas.writes                        // every range write: {sheet, r, c, nr, nc, op}
//   gas.sheet("Master list").cell(2, 1)
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKBOOK = JSON.parse(readFileSync(path.join(ROOT, "fixtures/workbook.json"), "utf8"));
const SLEEPER = Object.fromEntries(readdirSync(path.join(ROOT, "fixtures/sleeper"))
  .map(f => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(ROOT, "fixtures/sleeper", f), "utf8"))]));

/* ------------------------------ values ------------------------------ */

function fmtDate(d) {
  let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}
function display(v) {
  if (v == null) return "";
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function typed(v) {
  if (typeof v !== "string") return v;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})? ?[AP]M)?$/.test(v)) { const d = new Date(v); if (!isNaN(d)) return d; }
  const m = v.replace(/[$,]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(m)) return Number(m);
  return v;
}

/* ------------------------------ sheets ------------------------------ */

class FakeSheet {
  constructor(gas, name, rows, hidden) {
    this.gas = gas; this.name = name; this.hidden = !!hidden;
    this.cells = rows.map(r => r.slice());
    this.bg = new Map(); // "r,c" -> color
    this.maxRows = Math.max(1000, rows.length); this.maxCols = Math.max(26, ...rows.map(r => r.length));
  }
  getName() { return this.name; }
  getLastRow() { let n = this.cells.length; while (n && !this.cells[n - 1].some(v => v !== "" && v != null)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.cells.map(r => { let n = r.length; while (n && (r[n - 1] === "" || r[n - 1] == null)) n--; return n; })); }
  getMaxRows() { return Math.max(this.maxRows, this.cells.length); }
  getMaxColumns() { return this.maxCols; }
  cell(r, c) { return (this.cells[r - 1] || [])[c - 1] ?? ""; }
  set(r, c, v) { while (this.cells.length < r) this.cells.push([]); const row = this.cells[r - 1]; while (row.length < c) row.push(""); row[c - 1] = v; }
  getRange(a, b, c, d) {
    if (typeof a === "string") return this.getRange(...a1(a));
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  insertRowAfter(r) { this.cells.splice(r, 0, []); this.shiftBg(r + 1, 1); this.gas.ops.push({ sheet: this.name, op: "insertRowAfter", r }); }
  insertRowBefore(r) { this.cells.splice(r - 1, 0, []); this.shiftBg(r, 1); this.gas.ops.push({ sheet: this.name, op: "insertRowBefore", r }); }
  insertRowsAfter(r, n) { this.maxRows += n; }
  deleteRow(r) { this.cells.splice(r - 1, 1); this.shiftBg(r, -1); this.gas.ops.push({ sheet: this.name, op: "deleteRow", r }); }
  shiftBg(from, by) {
    const next = new Map();
    for (const [k, v] of this.bg) { const [r, c] = k.split(",").map(Number); if (by < 0 && r === from) continue; next.set(`${r >= from ? r + by : r},${c}`, v); }
    this.bg = next;
  }
  appendRow(vals) { const r = this.getLastRow() + 1; this.getRange(r, 1, 1, vals.length).setValues([vals]); }
  clearContents() { this.gas.log(this, 1, 1, this.cells.length || 1, this.maxCols, "clear"); this.cells = []; return this; }
  hideSheet() { this.hidden = true; } isSheetHidden() { return this.hidden; }
  setFrozenRows() {} setColumnWidth() {}
}

function a1(s) {
  const p = s.split(":").map(x => { const m = x.match(/^([A-Z]+)(\d+)$/); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]), c]; });
  const [[r1, c1], [r2, c2] = p[0]] = p;
  return [r1, c1, r2 - r1 + 1, c2 - c1 + 1];
}

class FakeRange {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getSheet() { return this.sh; } getRow() { return this.r; } getColumn() { return this.c; }
  getNumRows() { return this.nr; } getNumColumns() { return this.nc; }
  grid(f) { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(f(this.r + i, this.c + j)); out.push(row); } return out; }
  getDisplayValues() { return this.grid((r, c) => display(this.sh.cell(r, c))); }
  getValues() { return this.grid((r, c) => typed(this.sh.cell(r, c))); }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  getFormulas() { return this.grid(() => ""); }
  setValues(v) {
    if (v.length !== this.nr || v.some(r => r.length !== this.nc)) throw new Error(`setValues size mismatch on ${this.sh.name}: range ${this.nr}x${this.nc}, data ${v.length}x${v[0] && v[0].length}`);
    this.sh.gas.log(this.sh, this.r, this.c, this.nr, this.nc, "setValues");
    v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x)));
    return this;
  }
  setValue(x) { this.sh.gas.log(this.sh, this.r, this.c, 1, 1, "setValue"); this.sh.set(this.r, this.c, x); return this; }
  clearContent() { this.sh.gas.log(this.sh, this.r, this.c, this.nr, this.nc, "clear"); this.grid((r, c) => this.sh.cells[r - 1] && this.sh.set(r, c, "")); return this; }
  setBackground(col) { this.sh.gas.log(this.sh, this.r, this.c, this.nr, this.nc, "format"); this.grid((r, c) => col ? this.sh.bg.set(`${r},${c}`, col) : this.sh.bg.delete(`${r},${c}`)); return this; }
  copyTo(dest, opts) {
    dest.sh.gas.log(dest.sh, dest.r, dest.c, this.nr, this.nc, opts && opts.formatOnly ? "format" : "copy");
    if (!(opts && opts.formatOnly)) { const v = this.grid((r, c) => this.sh.cell(r, c)); v.forEach((row, i) => row.forEach((x, j) => dest.sh.set(dest.r + i, dest.c + j, x))); }
  }
  setNumberFormat() { return this; } setFontWeight() { return this; }
}

class FakeSpreadsheet {
  constructor(gas) { this.gas = gas; this.sheets = Object.entries(WORKBOOK).map(([n, t]) => new FakeSheet(gas, n, t.rows, t.hidden)); }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets; }
  insertSheet(n) { if (this.getSheetByName(n)) throw new Error("exists: " + n); const s = new FakeSheet(this.gas, n, []); this.sheets.push(s); return s; }
  toast() {}
}

/* ------------------------------ Sleeper ------------------------------ */

// Rebuild Sleeper rosters from the snapshot's Rosters tab so they line up
// with the team tabs: col i = roster_id i+1; rows 2-8 starters, 10-17 bench,
// 19-20 IR, 22-26 taxi.
function rostersFromSheet() {
  const R = WORKBOOK.Rosters.rows;
  const P = WORKBOOK._Players.rows;
  // name -> Sleeper id, preferring players who are on an NBA team
  const pidOf = {};
  P.forEach(r => { if (r[2] && !(r[1] in pidOf)) pidOf[r[1]] = r[0]; });
  P.forEach(r => { if (!(r[1] in pidOf)) pidOf[r[1]] = r[0]; });
  const map = Object.fromEntries(WORKBOOK["Team Map"].rows.slice(1).map(r => [r[0], r[2]]));
  const pr = {}; WORKBOOK["Team Power Rankings"].rows.slice(1).forEach(r => { pr[String(r[1]).trim().toLowerCase()] = r; });
  const cols = R[0].length;
  const out = [];
  for (let c = 0; c < cols; c++) {
    const get = (a, b) => { const o = []; for (let r = a; r <= b; r++) o.push(String((R[r - 1] || [])[c] || "")); return o; };
    const pid = n => (n ? (pidOf[n] || "x_" + n) : "0");
    const starters = get(2, 8).map(pid), bench = get(10, 17).filter(Boolean).map(pid);
    const reserve = get(19, 20).filter(Boolean).map(pid), taxi = get(22, 26).filter(Boolean).map(pid);
    const rk = pr[String(map[String(c + 1)] || "").toLowerCase()] || [];
    const pf = Number(rk[2]) || 0;
    out.push({
      roster_id: c + 1, owner_id: "u" + (c + 1),
      starters, reserve, taxi,
      players: starters.filter(p => p !== "0").concat(bench, reserve, taxi),
      settings: { wins: Number(rk[3]) || 0, losses: Number(rk[4]) || 0, ties: Number(rk[5]) || 0, fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100) },
    });
  }
  return out;
}

function sleeperRoutes() {
  const L = "/league/1341793858815557632";
  return {
    [L]: SLEEPER.league,
    [L + "/rosters"]: rostersFromSheet(),
    [L + "/users"]: WORKBOOK["Team Map"].rows.slice(1).map(r => ({ user_id: "u" + r[0], display_name: r[1] })),
    [L + "/traded_picks"]: SLEEPER.league_traded_picks,
    "/state/nba": { leg: 5, week: 5 },
  };
}

/* ------------------------------ services ----------------------------- */

export function makeGas(opts = {}) {
  const gas = { writes: [], ops: [], urls: [] };
  gas.log = (sh, r, c, nr, nc, op) => gas.writes.push({ sheet: sh.name, r, c, nr, nc, op });
  const ss = new FakeSpreadsheet(gas);
  gas.ss = ss;
  gas.sheet = n => ss.getSheetByName(n);
  const routes = Object.assign(sleeperRoutes(), opts.routes || {});

  const cache = new Map(), props = new Map(Object.entries(opts.props || {}));
  const scriptCache = {
    get: k => (cache.has(k) ? cache.get(k) : null),
    put: (k, v) => { if (Buffer.byteLength(v) > 100 * 1024) throw new Error("Argument too large: value"); cache.set(k, v); },
    getAll: ks => Object.fromEntries(ks.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
    putAll: o => Object.entries(o).forEach(([k, v]) => scriptCache.put(k, v)),
    remove: k => cache.delete(k),
    removeAll: ks => ks.forEach(k => cache.delete(k)),
  };
  gas.cache = cache;

  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const fetch = url => {
    gas.urls.push(url);
    const p = url.replace("https://api.sleeper.app/v1", "");
    if (p in routes) return resp(200, routes[p]);
    if (/\/transactions\/\d+$/.test(p)) return resp(200, []);
    if (p === "/players/nba") return resp(200, Object.fromEntries(WORKBOOK._Players.rows.map(r => [r[0], { first_name: r[1], last_name: "", team: r[2] || null }])));
    return resp(404, "");
  };

  const ui = { alert: () => "YES", prompt: () => ({ getSelectedButton: () => "OK", getResponseText: () => "" }),
    Button: { YES: "YES", NO: "NO", OK: "OK" }, ButtonSet: { YES_NO: 1, OK: 2, OK_CANCEL: 3 }, createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) };

  const htmlFile = n => readFileSync(path.join(ROOT, "src", n + ".html"), "utf8");
  const evaluateTemplate = (src, vars) => src.replace(/<\?(!?=)([\s\S]*?)\?>/g, (_, kind, expr) => {
    const v = vm.runInContext(`(function(){ with (this) { return (${expr}); } })`, ctx).call(vars);
    return kind === "!=" ? String(v) : String(v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  });
  const htmlOut = content => {
    const o = { getContent: () => content, setTitle: () => o, addMetaTag: () => o, setWidth: () => o, setHeight: () => o, setXFrameOptionsMode: () => o };
    return o;
  };

  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Set, Map, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    Logger: { log: (...a) => (opts.verbose ? console.log("[Logger]", ...a) : undefined) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss, getUi: () => opts.ui || ui, flush() {} },
    CacheService: { getScriptCache: () => scriptCache },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)),
      setProperties: o => Object.entries(o).forEach(([k, v]) => props.set(k, String(v))),
      getProperties: () => Object.fromEntries(props), deleteProperty: k => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch, fetchAll: reqs => reqs.map(r => fetch(r.url || r)) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" }, getUuid: () => randomUUID(),
      computeDigest: (alg, s) => Array.from(createHash(alg).update(s, "utf8").digest()).map(b => (b > 127 ? b - 256 : b)),
    },
    HtmlService: {
      createTemplateFromFile: n => { const t = { evaluate: () => htmlOut(evaluateTemplate(htmlFile(n), t)) }; return t; },
      createHtmlOutputFromFile: n => htmlOut(htmlFile(n)),
      XFrameOptionsMode: { ALLOWALL: 1 },
    },
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/TEST/exec" }), getProjectTriggers: () => [], deleteTrigger() {},
      newTrigger: () => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() {} }) },
  });
  gas.props = props;
  gas.ctx = ctx;
  for (const f of readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".gs"))) {
    vm.runInContext(readFileSync(path.join(ROOT, "src", f), "utf8"), ctx, { filename: f });
  }
  // const/let at top level aren't properties of the context; expose a getter for tests
  gas.eval = code => vm.runInContext(code, ctx);
  return gas;
}

export { WORKBOOK, SLEEPER, ROOT };
