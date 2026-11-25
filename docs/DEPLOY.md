# Deploying the league site

## Files in the Apps Script project
Everything in [src/](../src/) is the full project. Run `npm run build` first, because `LeagueMath.html` is generated.

| File | What it is |
|---|---|
| `Code.gs` | Sleeper sync (unchanged behavior, plus: drops also go to Cap Holds, site cache cleared after each sync, new menu items) |
| `PlayerCard.gs` | Player card data (`getCard`, `getGameLog`, `getTxns`) and sheet name links |
| `Site.gs` | The only `doGet`, `include_()`, `getLeague()`, `getLog()`, `getRules()` |
| `Admin.gs` | Passcode, commissioner writes, `setupSiteTables` |
| `Site.html` | Page shell |
| `SiteCss.html` | Styles (light and dark) |
| `SiteApp.html` | Pages, trade machine, commissioner tools |
| `CardRender.html` | Player card renderers, used by the popup |
| `LeagueMath.html` | Generated from `lib/LeagueMath.js` |
| `appsscript.json` | Manifest (V8, web app runs as you, anyone can open it) |

**Delete `CardPage.html` from the project.** Its renderers moved to `CardRender.html`, and the in-sheet popup is gone.

## Steps
1. **Back up first:** File > Make a copy of the spreadsheet.
2. **Put the files in.** Either:
   - **Paste:** Extensions > Apps Script. Replace `Code.gs` and `PlayerCard.gs`, add the new files with the exact names above, and delete `CardPage`. An `.html` file is added as "HTML", and you leave off the extension.
   - **clasp:** put `{"scriptId": "<id from Project Settings>", "rootDir": "src"}` in `.clasp.json`, then run `npx clasp login` and `npm run push`.
3. **Check the time zone.** I guessed `America/Los_Angeles` in `appsscript.json`. If you're pasting, leave your project's own setting alone. If you're using clasp, change it in the file to match Project Settings first.
4. Reload the sheet, then run **Sync League › Set up site tables**. This creates Cap Holds (from every team tab's Cap Hold rows), Cash Ledger (one opening-balance row per team with cash) and Admin Log. It asks before replacing a table that already has rows, and it removes the old popup's on-open trigger if it's still there.
5. Run **Sync League › Set commissioner passcode…**. Use at least 6 characters, and share it only with the commissioners.
6. **Deploy:** Deploy › **Manage deployments** › edit (pencil) the existing web app deployment › Version: **New version** › Deploy.
   - Editing the existing deployment keeps the same `/exec` URL, so every player link already in the sheet keeps working and now opens the site with that player's card.
   - Choosing *New deployment* instead gives a new URL. If you do that, run **Set site link…** with it and then **Refresh player links now**.
   - The deployment should be set to execute as **Me**, with access for **Anyone**.
7. Open the `/exec` URL on a phone and a computer. On the Commissioner page, sign in and run **Payroll check**. Right now it should show only Memphis, and it names the 6 players the MEM tab is missing.

## What's tested and what isn't
`npm test` runs 34 tests against the real `.gs` files with a fake SpreadsheetApp, CacheService, PropertiesService, UrlFetchApp and LockService. The data is your workbook snapshot plus Sleeper's league settings and traded picks.
- Payroll matches every team tab's Total Payroll for all 7 seasons, except Memphis, where the tab is missing 6 players.
- The trade rules: each apron level (including exactly +$15M), pre-trade tier, hard max now vs. future seasons, the cash range, max and supermax limits, wrong-team players, 3-team trades with a pick and cash, and the roster-size warning.
- Admin writes never touch Master list column S, including add, edit, delete of row 2, waived & re-signed, and the sync's drop and add paths.
- Migration output, plus payroll staying the same before and after migration.
- The login lockout and session check.

`npm run shots` renders every page at 390px and 1000px, in light and dark, with real server responses. No page throws errors or scrolls sideways.

**Not verifiable without real Apps Script.** Check these after deploying:
- **Routing:** `google.script.history` / `google.script.url` routing inside the web app iframe (URL hash updates, back button, `?n=` on first load). The screenshots use the plain-browser fallback.
- **Session storage:** `sessionStorage` inside the iframe, which keeps you signed in on reload. If the browser blocks it, you'll just need to sign in again after a reload.
- **Copy share link:** copying to the clipboard can be blocked in the iframe. The link is always shown in a box to copy by hand.
- **Real-sheet behavior:** row inserts, conditional formatting and filters on the real Master list. The fake sheet doesn't model formats, so check that a row added from the site picks up its neighbors' colors.
- **Live data:** ESPN game logs and bios. Screenshots used a made-up game log, and the endpoints are unofficial.
- **Speed:** how fast `getLeague()` is on the real sheet. The first load does 3 Sleeper calls plus sheet reads; after that it's cached for 60 seconds.
- **"Run sync now"** runs the whole sync inside a web request. If it ever times out, use the sheet menu instead.

## Rule interpretations I made
- **Cash and apron limits:** sending cash raises the sender's payroll this season, so it counts toward its Δ. A 2nd-apron team can send at most $5M in a trade, and a luxury-tax team can't send cash at all. Receiving cash always helps.
- **Rounding:** tiers use payroll rounded to $0.1M, so $150.0 is under the cap and $150.1 is the 1st apron. Adding exactly +$15.0M at the 1st apron is allowed.
- **Over $300M:** a team already over $300M before a trade gets the same rule as the luxury tax (it can only lose cap).
- **Draft picks:** Sleeper calls this season "2026", so the next 3 drafts are 2027–2029, plus any later season that appears in traded picks.
- **Ownership:** the site goes by Sleeper rosters, not the team tabs. The tabs are still written during the transition, but they aren't read except to migrate and for the payroll check.
- **Player filters:** Free agents = on the Master list, not rostered, not a hold, and not pending. A pending row shows under Pending, and under Rostered if he's on a roster.
- **Removing a cap hold:** this takes it off the Cap Holds table and the team tab, but leaves the "(cap hold)" Master list row. Delete that row in the contract editor if the hold is gone for good.
- **Waived & re-signed:** if no team tab has him in a Cap Hold row under his plain name, the site asks which team carries the hold rather than guessing, as your procedure says.
- **Deleting Master list row 2:** row 2 holds the column-S ARRAYFORMULA, so the site copies row 3 up and deletes row 3 instead.
- **Cash Ledger opening rows:** these are dated the day you run setup and use the current season.
