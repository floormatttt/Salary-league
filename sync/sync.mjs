// Sleeper sync (runs every 5 minutes in GitHub Actions; see .github/workflows/site.yml).
// Port of the old sheet script:
//   - reads every completed Sleeper transaction this season
//   - new ones: logged to data/log.json (Trade / Add / Drop / Commissioner moves),
//     drops -> the contract becomes a cap hold for the team that dropped him,
//     adds  -> a "PENDING — needs contract" row for the commissioners
//   - daily: refreshes data/players.json (Sleeper names) and data/espn.json (ESPN ids + bios)
//   - keeps data/txns.json (compact transactions for the player cards)
// Only files whose content changed are rewritten, so a quiet run commits nothing.
//   node sync/sync.mjs            (needs Node 18+ for fetch)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const League = require("../lib/League.js");
const MU = require("../lib/Mutations.js");
const CardData = require("../lib/Card.js");
const LM = require("../lib/LeagueMath.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLEEPER = "https://api.sleeper.app/v1";
const ESPN_SITE = "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba";
const DAY = 24 * 3600 * 1000;
const MAX_LEG = 30;

export async function runSync(D, fetchJson, now = Date.now()) {
  const id = League.CONFIG.leagueId;
  const notes = [];
  const iso = new Date(now).toISOString();
  const state = D.state;

  // ---- daily: Sleeper player names (the /players/nba dump is several MB; Sleeper asks for ~1 call/day)
  if (!state.playersAt || now - Date.parse(state.playersAt) > DAY || !Object.keys(D.players).length) {
    const raw = await fetchJson(`${SLEEPER}/players/nba`);
    if (raw && Object.keys(raw).length > 500) {
      const players = {};
      Object.keys(raw).forEach(pid => {
        const p = raw[pid] || {};
        const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || pid;
        players[pid] = p.team ? [name, p.team] : [name];
      });
      D.players = players;
      state.playersAt = iso;
      notes.push(`players: ${Object.keys(players).length}`);
    }
  }

  // ---- daily: ESPN index (name -> athletes) from all 30 team rosters. Never keep a failed/partial fetch.
  if (!state.espnAt || now - Date.parse(state.espnAt) > DAY) {
    const lists = await Promise.all(Array.from({ length: 30 }, (_, i) => fetchJson(`${ESPN_SITE}/teams/${i + 1}/roster`).catch(() => null)));
    const idx = {};
    lists.forEach(r => {
      if (!r || !r.athletes) return;
      const team = CardData.fixAbbr(r.team && r.team.abbreviation);
      r.athletes.forEach(a => { const rec = CardData.espnRecord(a, team); const k = LM.norm(rec.name); (idx[k] = idx[k] || []).push(rec); });
    });
    if (Object.keys(idx).length >= 300) { D.espn = idx; state.espnAt = iso; notes.push(`espn: ${Object.keys(idx).length}`); }
    else notes.push("espn: fetch looked incomplete; kept the old index");
  }

  // ---- transactions: this league + up to 2 previous seasons (for player cards)
  const league = await fetchJson(`${SLEEPER}/league/${id}`);
  const chain = [{ id, season: String(league.season) }];
  let prev = league.previous_league_id;
  for (let i = 0; i < 2 && prev && prev !== "0"; i++) {
    const have = D.txns.find(t => t.L === prev);
    if (have) { chain.push({ id: prev, season: have.s, cached: true }); prev = have.pl || null; continue; }
    const lg = await fetchJson(`${SLEEPER}/league/${prev}`);
    chain.push({ id: prev, season: String(lg.season), pl: lg.previous_league_id });
    prev = lg.previous_league_id;
  }
  const legs = async lid => (await Promise.all(Array.from({ length: MAX_LEG + 1 }, (_, l) => fetchJson(`${SLEEPER}/league/${lid}/transactions/${l}`).catch(() => [])))).flat().filter(Boolean);
  const current = await legs(id);
  if (!current.length && !state.started) notes.push("no transactions yet");

  // compact copy for the cards
  const compact = (t, lg) => ({
    L: lg.id, s: lg.season, pl: lg.pl || undefined, id: String(t.transaction_id), ts: t.status_updated || t.created, ty: t.type,
    a: t.adds || null, d: t.drops || null, r: t.roster_ids || [],
    p: (t.draft_picks || []).map(pk => [pk.season, pk.round, pk.roster_id, pk.owner_id, pk.previous_owner_id]),
    b: t.settings && t.settings.waiver_bid != null ? t.settings.waiver_bid : null,
  });
  let txns = D.txns.filter(t => t.L !== id && chain.some(c => c.id === t.L));
  for (const lg of chain.slice(1)) if (!lg.cached) txns = txns.concat((await legs(lg.id)).filter(t => t.status === "complete").map(t => compact(t, lg)));
  const seenTx = new Set();
  txns = txns.concat(current.filter(t => t.status === "complete").map(t => compact(t, chain[0])))
    .filter(t => (seenTx.has(t.id) ? false : seenTx.add(t.id)))
    .sort((a, b) => b.ts - a.ts);
  D.txns = txns;

  // ---- apply new transactions to the league data
  const done = current.filter(t => t.status === "complete" || t.status === "failed");
  const seen = new Set(state.seen);
  const since = Date.parse(state.since || 0) || 0; // anything before this was handled already (import / first run)
  const fresh = done.filter(t => !seen.has(String(t.transaction_id)) && (t.status_updated || t.created) > since);
  if (!state.started) {
    // First run: everything already in Sleeper counts as handled.
    D.log.unshift({ ts: iso, type: "Info", teams: "—", players: "—", details: "Transaction tracking started. Moves from here on are read from Sleeper's transaction list.", status: "" });
    state.started = true;
    state.since = iso;
    notes.push(`baseline: ${fresh.length} existing transactions marked as seen`);
  } else if (fresh.length) {
    const byRid = {};
    D.teams.forEach(t => { byRid[String(t.rid)] = t; });
    const n = MU.applyTransactions(D, fresh, {
      nameOf: pid => (D.players[pid] ? D.players[pid][0] : String(pid)),
      nbaOf: pid => (D.players[pid] && D.players[pid][1]) || "",
      teamOf: rid => byRid[String(rid)] || null,
    });
    notes.push(`applied ${fresh.length} new transaction(s), ${n} log entr${n === 1 ? "y" : "ies"}`);
  }
  if (fresh.length) {
    state.seen = Array.from(new Set(state.seen.concat(fresh.map(t => String(t.transaction_id))))).slice(-5000);
    state.lastChange = iso;
  }
  return notes;
}

/* ------------------------------ CLI ------------------------------ */

async function fetchJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "salary-league-sync" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 1000 * i));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.env.DATA_DIR || path.join(ROOT, "data"); // DATA_DIR: try it on a copy
  const D = {}, before = {};
  for (const [k, f] of Object.entries(League.FILES)) {
    const p = path.join(dir, f);
    before[k] = existsSync(p) ? readFileSync(p, "utf8") : "";
    D[k] = before[k] ? JSON.parse(before[k]) : (k === "contracts" ? { seasons: [], rows: [] } : ["state", "players", "espn", "rules"].includes(k) ? {} : []);
  }
  D.state.seen = D.state.seen || [];
  const notes = await runSync(D, fetchJson);
  const changed = [];
  for (const [k, f] of Object.entries(League.FILES)) {
    const s = League.toJson(D[k]);
    if (s !== before[k]) { writeFileSync(path.join(dir, f), s); changed.push(f); }
  }
  console.log([`changed: ${changed.join(", ") || "nothing"}`].concat(notes).join("\n"));
}
