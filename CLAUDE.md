# Salary League site

Static website for a salary-cap fantasy NBA league on Sleeper, hosted on GitHub Pages. It doesn't use Google Sheets anymore.
How it runs and goes live: [docs/DEPLOY.md](docs/DEPLOY.md). The original spec, from when this was an Apps Script app: [docs/MASTER_PROMPT.md](docs/MASTER_PROMPT.md).
Its rules (payroll, trade limits, cap holds, cash) still apply.

## Layout
- `site/`: the pages (`index.html`, `app.js`, `card.js`, `admin.js`, `export.js`, `app.css`). Plain browser JS, no bundler.
- `lib/`: shared by the browser, the sync and the tests (UMD).
  - `LeagueMath.js` handles payroll and trades.
  - `Mutations.js` holds every data change (commissioner edits and the sync's drop/add handling).
  - `League.js` builds the league object and `toJson`.
  - `Card.js` holds the player-card data.
- `data/*.json`: the league data. It's written by the sync (GitHub Actions) and by commissioner edits (GitHub API commits). Always write it with `League.toJson`, which gives one element per line.
- `sync/sync.mjs`: the Sleeper sync, run every 5 min by `.github/workflows/site.yml`, which also deploys `dist/` to Pages.
- `tools/`: `build.mjs` (makes `dist/`), `serve.mjs`, `screenshots.mjs`, and the one-time sheet import (`export-workbook.mjs`, `import-workbook.mjs`).
- `test/`: `node --test`. Fixtures are the frozen workbook snapshot plus Sleeper JSON in `fixtures/`. They're never the live `data/`.

## Commands
`npm test` · `npm run serve` · `npm run shots` · `npm run sync` (use `DATA_DIR=copy` to experiment)

## Rules that bite
- Change data only through `lib/Mutations.js`, so the commissioner page, the sync and the tests agree.
- Commissioner commits go through `Admin.apply`. It rereads the data at the current head and retries on a 422 (not fast-forward). Never write data without that.
- The sync must stay idempotent: a quiet run changes no files, because every change becomes a commit and a deploy.
- ESPN: use `site.web.api.espn.com`. Never replace `espn.json` with an empty or partial index.
- Sleeper `/players/nba` is fetched at most once a day.
