# Master prompt: League website for my salary-cap fantasy NBA league

You're picking up a project that's already underway. Read this whole prompt first, then the files in this folder. Ask me questions only where this prompt leaves a decision open. Everything else here is already decided.

## Goal

Replace my Google Sheets workbook with a **website** for my salary-cap fantasy NBA league on Sleeper (league ID `1341793858815557632`). It has to:

- Work on **phones and computers**, for **every league member, with no Google edit access**.
- Show every feature the workbook has now, plus a **player popup card** and a **trade calculator** for cap legality.
- Let commissioners **edit** contracts, cap holds, cash and rankings **on the site**, behind a passcode. I shouldn't need to open the spreadsheet anymore.

## Platform (decided)

- **Google Apps Script web app**, container-bound to the workbook (spreadsheet ID `1I6FEq2JzPKhADk_THPyYe5SX0PkPH-MCniz9-AmDgV4`). Deploy with **Execute as: Me** and access **Anyone**. Nobody else needs sheet access.
- The spreadsheet stays as the **storage layer only**. The existing 5-minute Sleeper sync keeps writing to it, and the site reads and writes it through the script.
- Use HtmlService templates with partials (`include_()`), and `google.script.run` wrapped in Promises on the client.
- Single-page app with hash routes, mobile-first. Light and dark mode via `prefers-color-scheme`. Wide tables scroll sideways with the first column sticky.
- **Apps Script constraints to respect:**
  - A `.gs` file and an `.html` file **can't share a name**. That's why the card HTML is `CardPage.html` and not `PlayerCard.html`.
  - Only **one `doGet`** and **one `onEdit`** per project.
  - Viewers without edit access never run sheet scripts, and the Sheets phone app has no script UI at all. **That's why this is a website and not in-sheet popups.**
  - CacheService values max out at 100KB, so chunk them. A helper already exists in PlayerCard.gs.
  - UrlFetch daily quota: fetch in parallel with `fetchAll` and cache.

## Files I'm giving you

1. **Code.gs**: my working Sleeper sync. It rewrites `Rosters`, logs transactions to `League Log`, converts drops to cap holds, creates `PENDING — needs contract` rows for adds, updates Power Rankings PF/W/L/T, and runs every 5 minutes. **Keep its behavior.** Change it only where noted below.
2. **PlayerCard.gs**: player card server code: `getCard`, `getGameLog`, `getTxns`, `getPlayerIndex`, ESPN and Sleeper fetching, chunked cache, name linking, in-sheet popup helpers, `testPlayerCard()`. It currently has a `doGet`. **Move routing into the new site file so there's only one `doGet`.**
3. **CardPage.html**: the card UI, already a single page in this order: **Bio → Game log (last 10, "show all" toggle, season picker) → Transaction history → Stats (averages, advanced, per-36, playoffs) → Contract**. **Pull its render functions into a shared partial** used by both the site's player popup and this page.
4. **LeagueMath.js**: tested, pure payroll and trade logic (details below). Wrap it as `LeagueMath.html` (a `<script>` partial) for the client. Keep a node-runnable copy for tests.
5. **The workbook export** (text dump of every tab), for building test fixtures.

## Workbook facts (verified against the data)

- **Master list** (the contracts table):
  - Columns: A name, B NBA team, C:I salaries for 2026-27 → 2032-33, J contract details, K a label column, L:R status codes per season (PO, TO, MAX, SMAX, HOLD), S roster count.
  - **Never write column S.** S2 is a single ARRAYFORMULA COUNTIF against `Rosters!A2:AF26`.
  - Salaries display as `$32.0`. The words `UFA`/`RFA` mark when a contract ends.
  - Rows are grouped by NBA team in column B. `Z` is used for unknown teams.
  - Cap-hold rows are named `Player (cap hold)` and keep their salaries.
  - Colors come from conditional formatting. Don't hardcode fills, except the blue `#4a86e8` UFA cell on a new minimum contract.
- **Rosters**: one column per Sleeper roster, in roster_id order. Rows go: 7 starters, blank, 8 bench, blank, 2 IR, blank, 5 taxi.
- **Team Map**: roster_id → owner, team name, tab code. There are 32 rosters but only 30 teams (two "Unknown").
- **Team tabs** (ATL…WAS):
  - Column A is the slot (PG/SG/SF/PF/C/UTIL, Bench, IR, Taxi, Cap Hold), column B the name.
  - The CAP HOLDS section holds `Name (cap hold)` rows.
  - Then there's a `Cash Considerations` row, then `Total Payroll:` plus cap-space rows.
- **Payroll formula (verified for all 30 teams, all 7 seasons):** payroll = every rostered player (starters, bench, IR **and taxi**) + cap holds + that season's cash balance. Cash only applies to the current season.
  - The Memphis tab is **missing 6 rostered players** (Kalkbrenner, Dunn, Carter, Bona, Diawara, Reed), so building from Sleeper rosters is more correct than reading the tabs.
  - Thomas Bryant (HOU) and Jabari Walker (GSW) have no Master list row and count as $0. Flag missing contracts on the site.
- **Team Power Rankings**: Ranking (set by hand), Team Name, PF, W, L, T, Cap, Owner/GM.
- **League Log**: Timestamp, Type, Team(s), Player(s), Details, Status. Newest on top. H1:I1 shows "Last synced".
- **Rules tab** key numbers:
  - Cap tiers: normal 0–150, 1st apron 150.1–200, 2nd apron 200.1–250, luxury tax 250.1–300. "Cap space until max" uses 300, which I'm treating as a hard max.
  - Teams can have at most **2 max contracts and 1 supermax**. Max = over 22.5 FPPG, supermax = over 30.
  - Minimum contract: $2M for 1 year. Rookie scale by pick.
  - Trades need commissioner approval (3-2 vote).

## Trade calculator rules (my decisions; implement exactly)

**Apron level comes from the team's PRE-trade current-season payroll.** Then the team's net change in current-season payroll (Δ = incoming salary − outgoing salary + cash sent − cash received) must fit:
- Under cap (≤150): no limit.
- 1st apron: Δ ≤ +$15M.
- 2nd apron: Δ ≤ +$5M.
- Luxury tax (and anything over 300): Δ ≤ 0. They can only lose cap.

Other checks:
- **Hard max:** post-trade current-season payroll can't go over $300M. That makes the trade illegal. Going over in a *future* season is only a warning.
- **Cash:** each season every team starts at a net balance of 0. Balance = cash sent − cash received. It must stay **between −$10M and +$10M** after the trade. Sending, receiving and sending again are all fine as long as the balance stays in range.
  - Cash sent **adds** to the sender's payroll and cash received **subtracts**, matching the team tabs.
  - Cash balances live in a **Cash Ledger** table.
- **Max contract limits:** post-trade counts of current-season MAX ≤ 2 and SMAX ≤ 1. Over that makes the trade illegal.
- **A player can only be traded by the team that has him.**
- **Warnings only, not illegal:** future-season payroll over 300, missing contracts, and active roster over the Sleeper limit (count of `roster_positions`).
- **Show every season:** before, out, in, after, and the apron level after, for each team. Support 2–4 team trades, draft picks (informational, no cap effect) and cash.
- Give a shareable link that encodes the trade in the URL hash. Also add a commissioner button: "Record cash from this trade" in the ledger.

`LeagueMath.js` already does all of this (`teamBook`, `evaluateTrade`, `tierOf`, `cashBalance`). Its payroll output matches the team tabs exactly, except for the Memphis gap above. Test with the fixture builder below.

## Site pages

1. **Standings (home):** rank, team, owner, W-L-T, PF, current payroll, apron chip, cash balance, max/supermax counts.
2. **Team page:**
   - Header: owner, record, payroll, apron level, cap space to each line, cash balance, maxes x/2, supermaxes x/1.
   - Roster grouped Starters/Bench/IR/Taxi with salary and status for all 7 seasons.
   - Cap holds, then a totals row per season with apron coloring.
   - Draft picks owned. Use Sleeper `/league/{id}/traded_picks` plus `settings.draft_rounds`, for the next 3 drafts plus any later season that appears in traded picks. Label them like `2029 1st (Dallas's)`.
3. **Players:**
   - Search plus filters: All / Rostered / Free agents (on the Master list, not rostered, not holds) / Cap holds / Pending contracts.
   - Columns: name, NBA team, fantasy team, salaries, statuses.
4. **Trade machine:** as specified above.
5. **Transactions:** League Log, newest first, filterable by team and type.
6. **Rules:** render the Rules tab.
7. **Player popup:** tapping any player name anywhere opens the card as a modal, using the shared renderer and the existing `getCard`/`getGameLog`/`getTxns`.
   - `?n=Name` in the URL opens the site with that player's popup, so old sheet links keep working.
8. **Commissioner (admin):** passcode login. Store a SHA-256 hash in Script Properties, set from a sheet menu item. Lock out for 10 minutes after 10 failures. Every write takes `LockService`, clears the site cache, and adds a row to an **Admin Log** sheet. Features:
   - **Pending contracts queue:** rows whose details say PENDING. Edit them to set salaries, statuses and details.
   - **Contract editor:** add, edit or delete a Master list row. Write only A:R. Check the row's current name before writing, since rows move.
   - **Cap holds:** convert a player to a hold for a team, or remove one.
   - **"Waived & re-signed":** follows my `cap-hold-and-min-contract` procedure. Rename the row to `(cap hold)`, insert a new $2M/UFA row at the end of the NBA team's block, copy the format from the row above, set the `#4a86e8` fill on D, and ask which fantasy team carries the hold if it's unclear.
   - **Cash:** record a transfer (two ledger rows, ± amount), with a ledger list and delete. Block anything that leaves a balance outside ±$10M unless I check "override".
   - **Power rankings:** edit the rank numbers.
   - **"Payroll check":** compare site payroll vs each team tab's `Total Payroll:` row and list the differences.
   - **Run sync now**, and view the Admin Log.

## New storage tables (create with a one-time `setupSiteTables()` menu item)

- **Cap Holds:** Team code | Player (as on Master list, with "(cap hold)") | Added | Note. Migrate it from every team tab's Cap Hold rows.
- **Cash Ledger:** Date | Season | Team code | Amount (signed: + sent, − received) | Note | Trade ref. Migrate one "Opening balance" row per team from the team tab's Cash Considerations value. In the current data that's ATL −10, CHA +2, DEN +10, DET +10, LAC −10, LAL +5, MEM +8, MIA +6, PHI −4, TOR −3, UTA −1.
- **Admin Log:** Time | Action | Details.
- Don't overwrite tables that already exist without confirming first.

## Changes to Code.gs (the sync)

- When a drop creates a cap hold, also append it to **Cap Holds**. Keep writing to the team tab too, during the transition.
- At the end of each sync, clear the site's cached league data.
- Add menu items: Set commissioner passcode…, Set up site tables, plus the existing player-card items.

## Data the site loads

`getLeague()` returns one object, cached about 60s in chunks and cleared on any write:
`{ season, seasons[7], teams[{rid, code, name, owner, rank, pf, w, l, t}], contracts[{r, n, hold, nba, sal[7] (number|"UFA"|"RFA"|null), st[7], det, cnt}], rosters{rid:{starters,bench,ir,taxi:[{pid,name}]}}, holds[{code,name}], cash[{date,season,code,amt,note}], picks{code:[...]}, limits{hardCap:300, cash:10, maxes:2, supermaxes:1, activeRoster} }`.
Rosters come live from Sleeper (`/league/{id}/rosters`), with names from the hidden `_Players` sheet. Load the log and rules lazily in separate calls.

## Known data-source facts

- **ESPN:**
  - `site.api.espn.com` returns **403** to Google's servers. Use `site.web.api.espn.com` for both rosters (`/apis/site/v2/sports/basketball/nba/teams/{1..30}/roster`) and game logs (`/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog`).
  - These endpoints are unofficial. Never cache an empty or failed ESPN index.
- **Sleeper:**
  - `/league/{id}` gives scoring_settings, roster_positions, settings, previous_league_id and season.
  - Transactions come per leg via `/league/{id}/transactions/{leg}`. Also use `/league/{id}/traded_picks`.
  - Only fetch `/players/nba` about once a day. The sync already caches it in `_Players`.

## How to work

1. Make a plan and a task list first. Show me the plan before writing code.
2. Build a **node test harness**:
   - A fake SpreadsheetApp, CacheService, PropertiesService, UrlFetchApp and LockService, with fixtures built from the workbook export.
   - Run the server code in `vm` against those fixtures.
   - Tests needed: payroll matches the team tabs for all 30 teams, trade cases (each apron level, the cash range, max limits, hard cap, 3-team trades), admin writes never touch column S, and migration output.
3. Render every page in headless Chrome at 390px and 1000px wide, with a mocked `google.script.run`. Look at the screenshots and fix layout problems before calling anything done.
4. Keep files small and named clearly. Suggested: `Site.gs`, `Admin.gs`, `Site.html`, `SiteCss.html`, `SiteApp.html`, `CardRender.html`, `LeagueMath.html`, plus the existing files.
5. Finish with:
   - Deploy steps: paste the files, run `setupSiteTables`, set the passcode, then Deploy → New version.
   - Anything you couldn't verify without real Apps Script.
   - Any rule interpretation you had to make.
