# Sheriff's Sale Dashboard

A personal web app for browsing and bidding on Allegheny County, PA Sheriff's Sale properties. Runs entirely in your browser. No server, no database, no account.

## Status

**Foundation + parsing.** You can upload Sheriff's Sale PDFs, parse them with the Anthropic API, and browse the extracted properties grouped by sale month. Enrichment (assessor, liens, code violations), a ranked list view, per-property pages, and exports are planned for follow-up prompts.

## What works today

- Home / Upload / Settings views with simple top-nav routing
- Upload a single PDF at a time (drag-and-drop or file picker)
- Auto-detects document type (listings vs results) and sale month from the filename, with a confirmation step
- Appends every upload to a persistent archive (never overwrites)
- Warns on duplicate uploads (same filename + size)
- Stores your Anthropic API key in this browser only (with a "Clear key" button)
- **Parse PDF** sends the file to Claude Sonnet in chunks, extracts structured property records, and saves them to IndexedDB
  - Pre-parse cost estimate, live progress bar, and after-parse cost + cache-hit breakdown
  - Same case number across multiple months collapses into one canonical record with a `history[]` of per-month statuses, opening bids, and sale outcomes
  - Comments block parsed for postponement history, bankruptcy filings, replenishment-unpaid flag, stayed notes, sold notes
  - Failed chunks listed with a "Retry failed pages" button — successful chunks don't get re-spent
- Home view groups uploads and parsed properties by sale month, sorted by status (Sold → Active → Postponed → Stayed) then opening bid

## How to run it locally

You'll need [Node.js](https://nodejs.org) 18 or newer. Then, in this folder:

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). Hot reload is on, so saving a file reloads the page automatically.

## How to deploy to GitHub Pages

**Do `npm install` first** (step 1 of "Run it locally" above) so that a `package-lock.json` file exists in this folder. Then:

1. **Create an empty GitHub repo.** Go to <https://github.com/new>. Suggested name: `sheriffs-sale-dashboard`. **Leave it completely empty** — no README, no .gitignore, no license. We'll push everything from this folder.

2. **Push this folder up.** In a terminal in this folder, run:

   ```bash
   git init
   git add .
   git commit -m "Initial scaffold"
   git branch -M main
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/sheriffs-sale-dashboard.git
   git push -u origin main
   ```

   Replace `<YOUR_GITHUB_USERNAME>` with your actual GitHub username.

3. **Enable Pages.** On GitHub, go to your repo → **Settings** → **Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. You do not need to pick a workflow — the one in `.github/workflows/deploy.yml` is detected automatically.

4. **Wait for the first deploy.** The push from step 2 already triggered the workflow. Open the **Actions** tab on your repo — you should see a run called "Deploy to GitHub Pages." When it finishes (≈1–2 min), your site is live at:

   ```
   https://<YOUR_GITHUB_USERNAME>.github.io/sheriffs-sale-dashboard/
   ```

5. **Future updates:** any push to `main` redeploys automatically.

### If you rename the repo

The URL prefix the site is built for is hard-coded in `vite.config.js`. If you call the repo something other than `sheriffs-sale-dashboard`, edit that file and change:

```js
base: command === 'build' ? '/sheriffs-sale-dashboard/' : '/',
```

…replacing `sheriffs-sale-dashboard` with your repo name. Otherwise CSS and JS will 404 on the deployed site.

## Data flow at a high level

```
You upload a PDF
  ↓
Upload view reads the file → guesses type + month from filename → asks you to confirm
  ↓
Raw PDF is stored as a Blob in IndexedDB ("pdf-blobs" store)
Upload metadata is stored in IndexedDB ("uploads" store) — APPEND-ONLY
  ↓
You click "Parse PDF"
  ↓
PDF is split into 8-page chunks via pdf-lib (runs in your browser)
  ↓
Each chunk is sent to Claude Sonnet as a base64 PDF document
  ↓ system prompt + schema is cached after chunk 1 (subsequent chunks cost ~10%)
Claude returns structured property records as JSON
  ↓
Each property is upserted into IndexedDB ("properties" store), keyed by case
number — same case across multiple months collapses into one record with
a history[] of per-month statuses/bids/outcomes
  ↓
Home view shows uploads + properties grouped by sale month
  ↓
(Future) Enrichment lookups, ranked list filters, per-property page, exports
```

## Parsing

- **Model:** `claude-sonnet-4-5-20250929` (set in `src/pdf/claude.js`; update when a newer Sonnet is released)
- **Cost:** roughly $1.50–$2.50 per 85-page PDF, depending on how many properties are in it. The first chunk pays full price; chunks 2–N reuse a cached system prompt at ~10% of input cost. The app shows an estimate before parsing and the actual cost after.
- **Chunking:** 8 pages per chunk (configurable in `src/pdf/chunking.js`). 85 pages → ~11 chunks → ~11 API calls per parse.
- **Failure handling:** if some chunks fail (timeout, transient API error), the successful properties are saved and the failed chunks are listed with a Retry button — you don't re-spend the cost of the successful ones.
- **Re-parsing:** safe. The upsert keeps your `userFields` (notes, max bid, flag) and only refreshes parser-produced fields if this upload is the most recent for the property.

### Browser-direct API calls

The Anthropic API is called directly from your browser — there's no backend to proxy through, because this is a static site. Anthropic supports this with a special header (`anthropic-dangerous-direct-browser-access: true`). The "dangerous" name reflects that your API key sits in IndexedDB on this device — anyone with browser access can read it. That's the same tradeoff documented on the Settings page; the parser doesn't introduce new exposure, it just uses the key you saved.

## Storage

Everything lives in this browser's **IndexedDB**, in a database called `sheriffs-sale-dashboard`. Five stores:

| Store | Holds |
|---|---|
| `uploads` | one record per uploaded PDF (filename, size, page count, sale month, type, upload timestamp) |
| `pdf-blobs` | the raw PDF files |
| `properties` | canonical property records (designed but not populated yet) |
| `settings` | your Anthropic API key, app version, last-upload timestamps |
| `geo-data-cache` | placeholder for future enrichment lookups |

If you ever need to wipe everything: open browser devtools (F12) → **Application** tab → **IndexedDB** → right-click `sheriffs-sale-dashboard` → Delete.

## Known limits

- **Parsing cost is real.** Every parse spends Anthropic API tokens. The pre-parse estimate is a rough heuristic (~$0.02/page); the actual cost shown afterward is exact. If a chunk fails partway, you've still paid for the successful chunks — that's fine, just budget for re-runs.
- **No enrichment yet.** Properties show only what's in the Sheriff PDF (case, address, status, opening bid, comments signals). Assessor values, liens, code violations, condemnation, etc. all wait for a future prompt.
- **Navigation cancels live progress.** A parse runs as an async function tied to the Upload view. If you click away mid-parse, the JS keeps running and properties keep saving, but you lose the live progress bar. The summary card is gone too. Refreshing Home will show the properties that did save.
- **Same-name re-parse refreshes from this upload only.** If you upload a "revised" version of a PDF and parse it, properties already in the database will have this upload's history entry added (or replaced if the same uploadId), and top-level fields refresh only if this upload is the most recent month for the property. Your notes / max bid / flag are always preserved.
- **Page count is best-effort.** For PDFs from CountySuite (the Sheriff's software) it's accurate. For other PDFs it may show `0` or be slightly wrong — won't break anything.
- **Duplicate detection is name + size only.** Two genuinely different files that happen to share name and size would be flagged as duplicates. Unlikely in practice.
- **No backup, no sync.** All data lives in this browser on this device. Clearing browser data, switching browsers, or using a different machine starts you over. A future prompt can add an export.
- **One user, one device.** No multi-user, no auth.
- **API key sits in IndexedDB on this device.** Convenient, but don't use this app on a shared computer.

## File layout

```
.
├── .github/workflows/deploy.yml  ← GitHub Actions: builds and publishes to Pages
├── src/
│   ├── main.js                   ← app entry point
│   ├── router.js                 ← tiny hash-based router with error display
│   ├── styles.css
│   ├── views/                    ← one file per page (home, upload, settings)
│   ├── storage/                  ← IndexedDB stores + per-store helpers
│   ├── pdf/
│   │   ├── parse.js              ← orchestrator: chunk → call → upsert → progress
│   │   ├── chunking.js           ← splits a PDF into N-page chunks via pdf-lib
│   │   ├── claude.js             ← Anthropic API wrapper (browser fetch)
│   │   └── prompts.js            ← system prompt + property schema
│   └── ui/                       ← shared bits (nav, formatters)
├── index.html
├── package.json
├── vite.config.js
└── README.md (this file)
```
