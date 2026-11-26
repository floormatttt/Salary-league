// The browser-only pieces, run in node: site/admin.js against a fake GitHub API
// (including a race with the sync), and site/export.js building the .xlsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { ROOT, League, freshData, league } from "./helpers.mjs";
const XLSX = createRequire(import.meta.url)("xlsx");

function browser(extra = {}) {
  const store = new Map();
  const ctx = vm.createContext(Object.assign({
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, isNaN, isFinite, encodeURIComponent, setTimeout,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    SITE: { owner: "o", repo: "r", branch: "main", workflow: "site.yml" },
  }, extra));
  ctx.window = ctx;
  for (const f of ["lib/LeagueMath.js", "lib/Mutations.js", "lib/League.js", "site/admin.js", "site/export.js"]) {
    vm.runInContext(readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  return ctx;
}

// A tiny in-memory GitHub: one branch of commits holding data/*.json
function fakeGitHub(files) {
  let n = 0;
  const commits = { c0: { tree: "t0", files: Object.assign({}, files) } };
  const trees = { t0: commits.c0.files };
  let head = "c0";
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const api = {
    calls, commits,
    head: () => head,
    // someone else (the sync) commits a change to one file
    externalCommit(path, content) { const id = "x" + ++n; trees["tx" + n] = Object.assign({}, commits[head].files, { [path]: content }); commits[id] = { tree: "tx" + n, files: trees["tx" + n] }; head = id; },
    fetch: async (url, opt = {}) => {
      const u = new URL(url), m = opt.method || "GET", p = u.pathname.replace("/repos/o/r", "");
      calls.push(m + " " + p);
      if (!/Bearer good/.test(opt.headers.Authorization)) return res(401, { message: "Bad credentials" });
      if (u.pathname === "/user") return res(200, { login: "commish" });
      if (p === "" ) return res(200, { permissions: { push: true } });
      if (p === "/git/ref/heads/main") return res(200, { object: { sha: head } });
      if (p.startsWith("/contents/")) { const f = commits[u.searchParams.get("ref")].files[p.slice(10)]; return f == null ? res(404, "") : res(200, f); }
      if (p.startsWith("/git/commits/") && m === "GET") return res(200, { tree: { sha: commits[p.slice(13)].tree } });
      if (p === "/git/trees") {
        const body = JSON.parse(opt.body), id = "t" + ++n;
        trees[id] = Object.assign({}, trees[body.base_tree]);
        body.tree.forEach(e => { trees[id][e.path] = e.content; });
        return res(201, { sha: id });
      }
      if (p === "/git/commits" && m === "POST") {
        const body = JSON.parse(opt.body), id = "c" + ++n;
        commits[id] = { tree: body.tree, files: trees[body.tree], parent: body.parents[0], message: body.message };
        return res(201, { sha: id });
      }
      if (p === "/git/refs/heads/main" && m === "PATCH") {
        const body = JSON.parse(opt.body);
        if (commits[body.sha].parent !== head) return res(422, { message: "Update is not a fast forward" });
        head = body.sha;
        return res(200, {});
      }
      if (p === "/actions/workflows/site.yml/dispatches") return res(204, null);
      return res(404, { message: "no route " + m + " " + p });
    },
  };
  return api;
}

function repoFiles() {
  const D = freshData(), files = {};
  for (const k of Object.keys(League.FILES)) files["data/" + League.FILES[k]] = League.toJson(D[k]);
  return files;
}

test("commissioner sign-in checks the token and write access", async () => {
  const gh = fakeGitHub(repoFiles());
  const w = browser({ fetch: gh.fetch });
  await assert.rejects(w.Admin.signIn("bad"), /didn't accept that token/);
  assert.equal(w.Admin.signedIn(), false);
  assert.equal(await w.Admin.signIn("good"), "commish");
  assert.equal(w.localStorage.getItem("slToken"), "good");
});

test("an edit is one commit with only the changed files, and it's logged", async () => {
  const gh = fakeGitHub(repoFiles());
  const w = browser({ fetch: gh.fetch });
  await w.Admin.signIn("good");
  const res = await w.Admin.apply([["recordCash", { season: "2026-27", from: "SAC", to: "WAS", amt: 3, note: "Trade" }]]);
  const c = gh.commits[gh.head()];
  assert.match(c.message, /^Cash: 2026-27: SAC sent \$3\.0M to WAS/);
  assert.match(c.message, /By commish/);
  const cash = JSON.parse(c.files["data/cash.json"]);
  assert.deepEqual(cash.slice(-2).map(x => [x.code, x.amt]), [["SAC", 3], ["WAS", -3]]);
  assert.equal(JSON.parse(c.files["data/admin-log.json"])[0].who, "commish");
  assert.equal(c.files["data/contracts.json"], gh.commits.c0.files["data/contracts.json"], "untouched file unchanged");
  assert.equal(res.D.cash.length, cash.length);
  const trees = gh.calls.filter(x => x === "POST /git/trees");
  assert.equal(trees.length, 1);
});

test("if the sync commits in between, the edit is redone on the new data (nothing lost)", async () => {
  const gh = fakeGitHub(repoFiles());
  let raced = false;
  const w = browser({
    fetch: async (url, opt) => {
      // right before the first ref update, the sync lands a commit adding a log entry
      if (!raced && (opt || {}).method === "PATCH") {
        raced = true;
        const log = JSON.parse(gh.commits[gh.head()].files["data/log.json"]);
        log.unshift({ ts: "2026-11-26T00:00:00Z", type: "Add", teams: "Utah", players: "Someone", details: "", status: "" });
        gh.externalCommit("data/log.json", League.toJson(log));
      }
      return gh.fetch(url, opt);
    },
  });
  await w.Admin.signIn("good");
  await w.Admin.apply([["setRanks", [{ code: "WAS", rank: 3 }]]]);
  const files = gh.commits[gh.head()].files;
  assert.equal(JSON.parse(files["data/teams.json"]).find(t => t.code === "WAS").rank, 3, "edit landed");
  assert.equal(JSON.parse(files["data/log.json"])[0].players, "Someone", "sync's commit kept");
  assert.equal(gh.calls.filter(x => x === "PATCH /git/refs/heads/main").length, 2);
});

test("a refused edit doesn't commit anything", async () => {
  const gh = fakeGitHub(repoFiles());
  const w = browser({ fetch: gh.fetch });
  await w.Admin.signIn("good");
  await assert.rejects(w.Admin.apply([["recordCash", { season: "2026-27", from: "SAC", to: "ATL", amt: 5 }]]), /ATL would be at -\$15\.0M/);
  assert.equal(gh.head(), "c0");
});

test("Run sync now dispatches the workflow", async () => {
  const gh = fakeGitHub(repoFiles());
  const w = browser({ fetch: gh.fetch });
  await w.Admin.signIn("good");
  await w.Admin.runSync();
  assert.ok(gh.calls.includes("POST /actions/workflows/site.yml/dispatches"));
});

test("spreadsheet export has the master list, standings, a tab per team and the ledgers", () => {
  const w = browser();
  const D = freshData(), L = league(D);
  const wb = w.Export.build(XLSX, L, D.log, D.rules);
  assert.equal(wb.SheetNames.length, 1 + 1 + 30 + 5);
  assert.deepEqual(wb.SheetNames.slice(0, 3), ["Master list", "Standings", "ATL"]);
  const ml = XLSX.utils.sheet_to_json(wb.Sheets["Master list"], { header: 1 });
  assert.equal(ml.length, 481);
  assert.deepEqual(ml[1].slice(0, 6), ["Jalen Johnson", "ATL", 32, 43, 40, "UFA"]);
  assert.equal(wb.Sheets["Master list"].C2.z, '"$"0.0;-"$"0.0');
  const mem = XLSX.utils.sheet_to_json(wb.Sheets.MEM, { header: 1 });
  assert.deepEqual(mem.find(r => r[2] === "Total Payroll:").slice(3, 6), [210.2, 141.8, 99.8]);
});
