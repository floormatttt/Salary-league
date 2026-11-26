# Running the league site

The site is static, hosted free on GitHub Pages from this repo. It doesn't use Google Sheets anymore.

```
browser ──> GitHub Pages: site/ + data/*.json      (contracts, cap holds, cash, ranks, logs)
        ──> Sleeper API (live rosters, records, picks)   ──> ESPN API (game logs)
GitHub Actions, every 5 min: sync/sync.mjs reads Sleeper → commits data/ → redeploys
Commissioner page: edits = commits to data/ through the GitHub API (your token)
```

## Go live (one time)
1. **Push the code:** run `git push`.
2. **Turn on Pages:** go to **Settings → Pages**, and under **Build and deployment → Source** choose **GitHub Actions**.
3. **Run it once:** go to **Actions → Sync and deploy → Run workflow**. After a minute or two the site is at
   **https://floormatttt.github.io/Salary-league/**. After that it runs by itself every 5 minutes and after every push.
   - If the sync step says it can't push: go to **Settings → Actions → General → Workflow permissions**, choose **Read and write**, and save.
4. **Make your commissioner token:** go to **GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token**.
   - **Repository access:** Only select repositories → `Salary-league`.
   - **Permissions:** *Contents* Read and write, and *Actions* Read and write.
   - Paste the token on the site's **Commissioner** page. It stays in that browser until you sign out.
   - **For other commissioners:** add each one under **Settings → Collaborators**, and they make their own token the same way. Or give them a token you made, like a shared passcode. Edits are logged under the token's GitHub user.
5. **Retire the sheet's sync** once the site looks right: in the spreadsheet, open **Extensions → Apps Script → Triggers** and delete the `syncSleeperLeague` trigger. Until then both run side by side; that's harmless, but the sheet stops matching the site as soon as someone edits on the site.

## Everyday use
- **Contracts, cap holds, cash, rankings:** edit them on the Commissioner page. Each save is a commit, so you can see every change on GitHub. The page shows the change at once; the public site catches up after GitHub Pages redeploys, which takes about a minute.
- **New adds from Sleeper:** these show up under **Commissioner → Pending** with a PENDING note. Set the salary and clear the note.
- **Drops:** these become cap holds automatically, on the team that dropped the player.
- **Spreadsheet:** use the **Spreadsheet** button in the top bar (or the footer link). It's a read-only, color-coded .xlsx with the master list, standings, a tab per team, cap holds, the cash ledger, picks, the log and the rules.

## Commands
| | |
|---|---|
| `npm test` | All tests: import, payroll, trade rules, commissioner edits, sync, card, and the GitHub commit flow |
| `npm run serve` | Build and preview at http://localhost:8080 with live Sleeper data and your local `data/` |
| `npm run shots` | Screenshots of every page at phone and desktop width, offline, from the test data |
| `npm run sync` | Run the Sleeper sync locally. It edits `data/`, so set `DATA_DIR=some/copy` to try it on a copy first |
| `npm run import -- --force file.json` | Re-import from the old sheet. This **replaces** `data/`; it's for setup only |

## Things to know
- **Timing:** GitHub runs scheduled jobs "about" every 5 minutes, and they're often a few minutes late. **Run sync now** on the Commissioner page starts one right away.
- **Inactivity:** GitHub pauses scheduled jobs in a repo with no activity for 60 days, which could happen in the offseason. If syncing stops, go to **Actions → Sync and deploy → Enable workflow**.
- **Old links:** player links in the old sheet point at the old Apps Script URL. On the new site, `…/Salary-league/?n=Player Name` opens that player's card.
- **The repo is public,** because free GitHub Pages needs a public repo. So the league data in `data/` is public, the same as what the site shows.
- **Unofficial APIs:** ESPN's endpoints are unofficial. If they change, game logs and bios disappear from the cards, but nothing else breaks.

## Rule interpretations (unchanged from the sheet version)
- **Cash and apron limits:** sending cash raises the sender's payroll this season, so it counts toward its apron limit. A 2nd-apron team can send at most $5M, and a luxury-tax team can't send cash at all.
- **Rounding:** tiers use payroll rounded to $0.1M. $150.0 is under the cap, and adding exactly +$15.0M at the 1st apron is allowed.
- **Over $300M:** a team over $300M before a trade can only lose cap.
- **Draft picks:** the next 3 drafts are 2027–2029, plus any later season that appears in traded picks.
- **Removing a cap hold** keeps the "(cap hold)" contract. Delete that under Contracts if it's gone for good.
- **Waived & re-signed** always asks which team carries the hold.
