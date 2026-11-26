// Renders every page of the built site (dist/) in headless Chrome at 390px and
// 1000px, offline: the site's own files come from dist/, Sleeper from the
// workbook snapshot, ESPN and GitHub are faked. Output: shots/*.png plus any
// page errors or sideways scrolling, printed at the end.
// Run: npm run shots [name-filter]       (CHROME=path to override the browser)
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, freshData, sleeperLive, League } from "../test/helpers.mjs";
const puppeteer = createRequire(import.meta.url)("puppeteer-core");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.join(ROOT, "shots"), DIST = path.join(ROOT, "dist");
mkdirSync(OUT, { recursive: true });
const SITE = "http://site.test/";

// Data files: the snapshot imported fresh (same as the tests), with a pending contract to show
const D = freshData();
D.contracts.rows.push({ id: 999, n: "Brand Newguy", nba: "GSW", sal: [null, null, null, null, null, null, null], st: ["", "", "", "", "", "", ""], det: "PENDING — needs contract" });
D.adminLog.unshift({ ts: "2026-11-25T23:10:00.000Z", who: "floormatttt", action: "Contract", details: "Edited Jalen Johnson (ATL) $32.0M / $43.0M / $40.0M / UFA" });
const live = sleeperLive();
const L = League.build(D, live);

function fakeLog() {
  const rows = Array.from({ length: 14 }, (_, i) => ({ eventId: String(i), stats: [String(34 - (i % 5)), String(24 + (i % 7)), String(7 + (i % 4)), String(6 + (i % 3)), "1", String(i % 2), "3", "2", "9-18", "2-6", "4-5"] }));
  const events = {};
  rows.forEach((r, i) => { events[r.eventId] = { gameDate: new Date(Date.UTC(2026, 10, 24 - i * 2)).toISOString(), opponent: { abbreviation: ["BOS", "NYK", "MIA", "DEN"][i % 4] }, atVs: i % 2 ? "@" : "vs", gameResult: i % 3 ? "W" : "L", score: "112-104" }; });
  return { names: ["minutes", "points", "totalRebounds", "assists", "steals", "blocks", "turnovers", "fouls", "fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "freeThrowsMade-freeThrowsAttempted"],
    events, seasonTypes: [{ displayName: "2026-27 Regular Season", categories: [{ events: rows }] }] };
}
const espn = { [require_norm("Jalen Johnson")]: [{ id: "4701230", name: "Jalen Johnson", team: "ATL", pos: "F", jersey: "1", ht: "6' 9\"", wt: "220 lbs", age: 24, dob: "2001-12-18", born: "Milwaukee, WI", college: "Duke", exp: 5, img: "", inj: null }] };
function require_norm(n) { return createRequire(import.meta.url)("../lib/LeagueMath.js").norm(n); }

function respond(url, method) {
  const u = new URL(url);
  if (url.startsWith(SITE)) {
    let p = u.pathname.slice(1) || "index.html";
    if (p.startsWith("data/")) {
      const key = Object.keys(League.FILES).find(k => "data/" + League.FILES[k] === p);
      const v = key === "espn" ? espn : D[key];
      return v !== undefined ? { status: 200, contentType: "application/json", body: JSON.stringify(v) } : { status: 404, body: "" };
    }
    const f = path.join(DIST, p);
    if (!existsSync(f)) return { status: 404, body: "" };
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(f)] || "application/octet-stream";
    return { status: 200, contentType: type, body: readFileSync(f) };
  }
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, PATCH" };
  const json = v => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(v) });
  if (u.host === "api.sleeper.app") {
    const p = u.pathname.replace("/v1/league/" + League.CONFIG.leagueId, "");
    if (p === "") return json(live.league);
    if (p === "/rosters") return json(live.rosters);
    if (p === "/users") return json(live.users);
    if (p === "/traded_picks") return json(live.traded);
  }
  if (u.host.endsWith("espn.com") && /gamelog/.test(u.pathname)) return json(fakeLog());
  if (u.host === "api.github.com") {
    if (method === "OPTIONS") return { status: 204, headers: CORS, body: "" };
    if (u.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: "abc" } });
    if (u.pathname.includes("/contents/data/admin-log.json")) return { status: 200, contentType: "text/plain", headers: CORS, body: JSON.stringify(D.adminLog) };
  }
  return null;
}

const enc = o => "trade/" + encodeURIComponent(JSON.stringify(o));
const tb = code => L.teams.find(t => t.code === code);
const pl = (code, i) => L.rosters[tb(code).rid].starters[i].name;
const trade = enc({ t: ["ATL", "BOS", "MIA"], m: [["p", pl("ATL", 0), "ATL", "BOS"], ["p", pl("BOS", 1), "BOS", "MIA"], ["p", pl("MIA", 2), "MIA", "ATL"],
  ["k", L.picks.ATL[0].label, "ATL", "MIA"], ["c", 3, "BOS", "ATL"]] });

const SHOTS = [
  ["standings", ""], ["team-ATL", "#team/ATL"], ["team-MEM", "#team/MEM"], ["players", "#players"], ["trade", "#" + trade], ["trade-empty", "#trade"],
  ["log", "#log"], ["rules", "#rules"], ["admin-login", "#admin"],
  ["admin-pending", "#admin", { admin: true }], ["admin-holds", "#admin", { admin: true, tab: "Cap holds" }],
  ["admin-cash", "#admin", { admin: true, tab: "Cash" }], ["admin-waive", "#admin", { admin: true, tab: "Waived & re-signed" }],
  ["admin-ranks", "#admin", { admin: true, tab: "Rankings" }], ["admin-sync", "#admin", { admin: true, tab: "Sync & log" }],
  ["admin-contract", "#admin", { admin: true, tab: "Pending", click: "Edit" }],
  ["card", "?n=Jalen%20Johnson", { viewport: true }],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const errors = [];
for (const dark of [false, true]) {
  for (const width of [390, 1000]) {
    for (const [name, suffix, o = {}] of SHOTS) {
      if (only && !only.test(name)) continue;
      if (dark && !["standings", "team-ATL", "trade", "card", "admin-cash"].includes(name)) continue;
      const p = await browser.newPage();
      await p.setViewport({ width, height: 800 });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
      await p.setRequestInterception(true);
      p.on("request", r => {
        const res = respond(r.url(), r.method());
        if (res) r.respond(res); else if (/fonts|cdnjs/.test(r.url())) r.abort(); else { errors.push(`${name}@${width}: unexpected request ${r.url()}`); r.abort(); }
      });
      p.on("pageerror", e => errors.push(`${name}@${width}: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${name}@${width}: console: ${m.text()}`); });
      await p.evaluateOnNewDocument(admin => {
        if (admin) { localStorage.setItem("slToken", "t"); localStorage.setItem("slWho", "floormatttt"); } else localStorage.clear();
      }, !!o.admin);
      await p.goto(SITE + suffix, { waitUntil: "networkidle0" });
      if (o.tab) await clickText(p, "button[data-act=adminTab]", o.tab);
      if (o.click) await clickText(p, "button", o.click);
      await new Promise(r => setTimeout(r, 300));
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) errors.push(`${name}@${width}: page scrolls sideways by ${overflow}px`);
      await p.screenshot({ path: path.join(OUT, `${name}-${width}${dark ? "-dark" : ""}.png`), fullPage: !o.viewport });
      await p.close();
    }
  }
}
await browser.close();

async function clickText(p, sel, text) {
  const ok = await p.evaluate((sel, text) => {
    const b = Array.from(document.querySelectorAll(sel)).find(x => x.textContent.trim() === text);
    if (b) b.click();
    return !!b;
  }, sel, text);
  if (!ok) errors.push(`no "${text}" button`);
  await new Promise(r => setTimeout(r, 300));
}

console.log(errors.length ? "Problems:\n  " + errors.join("\n  ") : "No page errors, unexpected requests or sideways scrolling.");
console.log("Screenshots in " + OUT);
