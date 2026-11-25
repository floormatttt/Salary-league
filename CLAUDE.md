# Salary League site

Google Apps Script web app for a salary-cap fantasy NBA league on Sleeper. The full spec is
[docs/MASTER_PROMPT.md](docs/MASTER_PROMPT.md). Read it before changing behavior.

## Layout
- `src/`: exactly what gets pushed to Apps Script (`clasp push`, rootDir = src).
- `lib/LeagueMath.js`: the one copy of payroll and trade logic. `npm run build` wraps it into
  `src/LeagueMath.html`, which is generated, so never edit it by hand.
- `test/`: `node --test`. The harness fakes SpreadsheetApp/CacheService/etc. and runs `src/*.gs` in `vm`.
- `fixtures/`: test data built from the workbook export.
- `tools/`: build and headless-Chrome screenshot scripts.

## Commands
- `npm test`: build, then run every test.
- `npm run shots`: render pages at 390px and 1000px with a mocked `google.script.run`.
- `npm run push`: build, then `clasp push`. Needs `.clasp.json` with the script id.

## Apps Script rules that bite
- A `.gs` file and an `.html` file can't share a basename.
- Only one `doGet` and one `onEdit` in the whole project.
- Never write Master list column S (ARRAYFORMULA). Admin writes are limited to A:R.
- CacheService values max out at 100KB, so go through `cached_`/`cachePut_` (they chunk).
- Use `UrlFetchApp.fetchAll` and caching. ESPN: use `site.web.api.espn.com` (site.api returns 403), and never cache an empty index.
- Every admin write takes LockService, clears the site cache, and appends to Admin Log.
