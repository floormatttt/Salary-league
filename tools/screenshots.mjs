// Renders every site page in headless Chrome at 390px and 1000px with a mocked
// google.script.run whose answers come from the real server code (test harness).
// Output: shots/*.png, plus any page errors printed to the console.
// Run: npm run shots            (CHROME=path to override the browser)
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { makeGas, ROOT } from "../test/harness.mjs";
const puppeteer = createRequire(import.meta.url)("puppeteer-core");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.join(ROOT, "shots");
mkdirSync(OUT, { recursive: true });

const gas = makeGas();
gas.eval(`setPasscode_("letmein1")`);
const L = gas.ctx.getLeague();
const firstRoster = L.rosters[L.teams[0].rid].starters[0].name;

// A synthetic ESPN game log so the card's game log / stats sections render
function fakeLog() {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: String(i), date: new Date(2026, 10, 24 - i * 2).toISOString(), opp: ["BOS", "NYK", "MIA", "DEN"][i % 4], at: i % 2 ? "@" : "vs",
    res: i % 3 ? "W" : "L", score: "112-104", type: "RS", min: 34 - (i % 5), pts: 24 + (i % 7), reb: 7 + (i % 4), ast: 6 + (i % 3),
    stl: 1, blk: i % 2, to: 3, pf: 2, fgm: 9, fga: 18, fg3m: 2, fg3a: 6, ftm: 4, fta: 5, fp: 38.5 + (i % 6) * 2.25,
  }));
  return { ok: true, season: "2026-27", rows, summary: {
    g: 14, avg: { min: 32.1, pts: 27.0, reb: 8.4, ast: 6.9, stl: 1, blk: 0.5, to: 3, fp: 44.1, fg3m: 2 },
    pct: { fg: 0.5, fg3: 0.333, ft: 0.8 },
    adv: { ts: 0.61, efg: 0.55, par3: 0.33, ftr: 0.28, astTo: 2.3, fpMin: 1.37, fpSd: 4.2, last5: 45.2, last10: 44.6, high: 49.75, low: 38.5, dd: 4, td: 1 },
    per36: { pts: 30.3, reb: 9.4, ast: 7.7, stl: 1.1, blk: 0.6, fp: 49.5 }, eligibility: "Supermax eligible (30+ FPPG)" }, playoffs: null, unscored: [] };
}

const card = name => {
  const c = gas.ctx.getCard(name);
  c.espn = c.espn || { id: "1", name, team: c.nbaTeam, pos: "G", jersey: "4", ht: "6' 4\"", wt: "205 lbs", age: 25, dob: "2001-03-04", born: "Atlanta, GA",
    college: "", exp: 5, img: "", inj: null };
  return c;
};

const MOCK = {
  getLeague: L,
  getLog: gas.ctx.getLog(),
  getRules: gas.ctx.getRules(),
  getCard: { [firstRoster]: card(firstRoster), "Jalen Johnson": card("Jalen Johnson") },
  getGameLog: fakeLog(),
  getTxns: { ok: true, rows: [{ ts: Date.now() - 864e5, season: "2026", type: "Trade", text: "Orlando → Atlanta",
    parts: [{ team: "Atlanta", items: [{ player: "Herbert Jones" }, { pick: "2029 1st (Dallas's)" }] }, { team: "Orlando", items: [{ player: "Michael Porter Jr." }] }] }] },
  adminLogin: { ok: true, token: "t" }, adminCheck: { ok: true },
  adminPayrollCheck: (() => { const t = gas.ctx.adminLogin("letmein1").token; return gas.ctx.adminPayrollCheck(t); })(),
  adminGetLog: [{ time: "11/25/2026 3:01 PM", action: "Edit contract", details: "Row 2: Jalen Johnson (ATL) 32 / 43 / 40 / UFA" }],
};

const mockScript = `<script>
window.__MOCK = ${JSON.stringify(MOCK).replace(/</g, "\\u003c")};
window.google = { script: { run: (function () {
  function runner(ok, bad) {
    return new Proxy({}, { get: function (_, fn) {
      if (fn === "withSuccessHandler") return function (f) { return runner(f, bad); };
      if (fn === "withFailureHandler") return function (f) { return runner(ok, f); };
      return function () {
        var a = arguments, m = window.__MOCK[fn];
        setTimeout(function () {
          if (m === undefined) { (bad || console.error)(new Error("mock: no " + fn)); return; }
          var v = (m && typeof m === "object" && !Array.isArray(m) && fn === "getCard") ? (m[a[0]] || { found: false, query: a[0] }) : m;
          ok && ok(JSON.parse(JSON.stringify(v)));
        }, 20);
      };
    } });
  }
  return runner(null, null);
})() } };
</script>`;

function page(n = "") {
  const html = gas.ctx.doGet({ parameter: { n } }).getContent();
  // mock must exist before the app scripts run; the hash-routing path is used (no google.script.history)
  return html.replace("<script>var BOOT", mockScript + "\n<script>var BOOT");
}
writeFileSync(path.join(OUT, "site.html"), page());
writeFileSync(path.join(OUT, "site-card.html"), page("Jalen Johnson"));

const enc = o => "trade/" + encodeURIComponent(JSON.stringify(o));
const tb = code => L.teams.find(t => t.code === code);
const pl = (code, i) => L.rosters[tb(code).rid].starters[i].name;
const trade = enc({ t: ["ATL", "BOS", "MIA"], m: [["p", pl("ATL", 0), "ATL", "BOS"], ["p", pl("BOS", 1), "BOS", "MIA"], ["p", pl("MIA", 2), "MIA", "ATL"],
  ["k", (L.picks.ATL[0] || {}).label || "", "ATL", "MIA"], ["c", 3, "BOS", "ATL"]] });

const SHOTS = [
  ["standings", ""], ["team-ATL", "team/ATL"], ["team-MEM", "team/MEM"], ["players", "players"], ["trade", trade], ["trade-empty", "trade"],
  ["log", "log"], ["rules", "rules"], ["admin-login", "admin"],
  ["admin-pending", "admin", { admin: true }], ["admin-holds", "admin", { admin: true, tab: "Cap holds" }],
  ["admin-cash", "admin", { admin: true, tab: "Cash" }], ["admin-check", "admin", { admin: true, tab: "Payroll check", click: "Run check" }],
  ["admin-contract", "admin", { admin: true, tab: "Contracts", js: "S.admin.edit = editable(S.L.contracts[0]); rerender();" }],
  ["admin-waive", "admin", { admin: true, tab: "Waived & re-signed" }],
  ["admin-ranks", "admin", { admin: true, tab: "Rankings" }],
  ["admin-sync", "admin", { admin: true, tab: "Sync & log" }],
  ["card", "", { file: "site-card.html" }],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const errors = [];
for (const dark of [false, true]) {
  for (const width of [390, 1000]) {
    for (const [name, hash, o = {}] of SHOTS) {
      if (only && !only.test(name)) continue;
      if (dark && !["standings", "team-ATL", "trade", "card"].includes(name)) continue;
      const p = await browser.newPage();
      await p.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
      p.on("pageerror", e => errors.push(`${name}@${width}: ${e.message}`));
      p.on("console", m => { if (m.type() === "error") errors.push(`${name}@${width}: console: ${m.text()}`); });
      if (o.admin) await p.evaluateOnNewDocument(() => sessionStorage.setItem("slAdmin", "t"));
      await p.goto("file:///" + path.join(OUT, o.file || "site.html").replace(/\\/g, "/") + "#" + hash);
      await new Promise(r => setTimeout(r, 250));
      if (o.tab) await clickText(p, "button[data-act=adminTab]", o.tab);
      if (o.click) await clickText(p, "button", o.click);
      if (o.js) await p.evaluate(o.js);
      await new Promise(r => setTimeout(r, 250));
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) errors.push(`${name}@${width}: page scrolls sideways by ${overflow}px`);
      const file = `${name}-${width}${dark ? "-dark" : ""}.png`;
      await p.screenshot({ path: path.join(OUT, file), fullPage: !o.file });
      await p.close();
    }
  }
}
await browser.close();

async function clickText(p, sel, text) {
  await p.evaluate((sel, text) => {
    const b = Array.from(document.querySelectorAll(sel)).find(x => x.textContent.trim() === text);
    if (b) b.click(); else console.error("no button " + text);
  }, sel, text);
  await new Promise(r => setTimeout(r, 200));
}

console.log(errors.length ? "Problems:\n  " + errors.join("\n  ") : "No page errors or sideways scrolling.");
console.log("Screenshots in " + OUT);
