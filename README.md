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
- Home view supports filter + sort + search:
  - Search box matches substrings across address, case #, defendant, parcel ID, municipality, plaintiff
  - Sort dropdown: Sale month (grouped), **Spread (best deals first)**, Opening bid asc/desc, Status priority, Case #, Address. Spread = ARV − opening bid; ARV is your override if set, else the WPRDC fair-market value from bulk enrichment. Properties with no spread data sort to the bottom.
  - Status chips: Active / Postponed / Stayed / Sold — click to toggle
  - Flag chips: Interested / Skip / Unflagged
  - "Only show needs-review" toggle for triage
  - "Showing N of M" counter and Clear filters link
  - Each property appears once under its most recent sale month (not under every month it appeared in — see the per-property history table for that)
- Uploads archive collapses into a `<details>` element at the top to save screen space when you're working with hundreds of properties
- Click any property card on Home to open a per-property page with:
  - Full sale info (plaintiff, attorney, defendant, sale type, etc.)
  - Inline edit form for your max bid, ARV override, interested/skip flag, and notes — auto-saves on blur
  - **Property Assessment** card pulled live from WPRDC (Western Pennsylvania Regional Data Center): assessed value, fair market value, year built, sq ft, BR/BA, condition, lot area, last sale price + date, owner of record
  - **Spread analysis**: ARV (your override or WPRDC fair market) minus opening bid; margin if you win at your max bid. Green for positive, red for negative.
  - **Pittsburgh data** card (Pittsburgh-proper properties only): PLI code violations (open/closed counts + per-record list since June 2020) and PLI permits (per-record list since June 2019). For properties outside Pittsburgh, the card greys out with a tooltip explaining the coverage gap.
  - History table showing every sale month this case has appeared in, with a "View source PDF" link per row
  - Structured Comments breakdown (postponement chain, bankruptcy history, replenishment flag, stayed/sold notes) plus the verbatim raw comments block

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
Click a property → per-property page with full details, history table,
                   structured Comments breakdown, and an inline edit form
                   for your max bid / ARV / flag / notes (auto-saves on blur)
  ↓
On page open, the property's parcel ID is normalized (e.g. "556-G-276"
→ "0556G00276000000") and looked up in the WPRDC Allegheny County Property
Assessments dataset. Result is cached in IndexedDB for 30 days.
  ↓
Spread analysis (ARV − opening bid, margin if won at max bid) renders
inline using the fetched assessor value.
  ↓
(Future) Pittsburgh-only enrichment sources (code violations, liens,
         condemnation, permits), ranked-list filters and search, exports
```

## Parsing

- **Model:** `claude-sonnet-4-5-20250929` (set in `src/pdf/claude.js`; update when a newer Sonnet is released)
- **Cost:** roughly $1.50–$2.50 per 85-page PDF, depending on how many properties are in it. The first chunk pays full price; chunks 2–N reuse a cached system prompt at ~10% of input cost. The app shows an estimate before parsing and the actual cost after.
- **Chunking:** 8 pages per chunk (configurable in `src/pdf/chunking.js`). 85 pages → ~11 chunks → ~11 API calls per parse.
- **Failure handling:** if some chunks fail (timeout, transient API error), the successful properties are saved and the failed chunks are listed with a Retry button — you don't re-spend the cost of the successful ones.
- **Re-parsing:** safe. The upsert keeps your `userFields` (notes, max bid, flag) and only refreshes parser-produced fields if this upload is the most recent for the property.

### Browser-direct API calls

The Anthropic API is called directly from your browser — there's no backend to proxy through, because this is a static site. Anthropic supports this with a special header (`anthropic-dangerous-direct-browser-access: true`). The "dangerous" name reflects that your API key sits in IndexedDB on this device — anyone with browser access can read it. That's the same tradeoff documented on the Settings page; the parser doesn't introduce new exposure, it just uses the key you saved.

### Validation + repair pass

The PDF parser isn't perfect — Claude occasionally column-shifts (assigns values from one cell to the wrong field) or drops digits from numbers. To catch these, every parsed record runs through a local validator that checks:

- `caseNumber` matches `GD-YY-NNNNNN`
- `parcelId` matches `DDDD-L-DDDDD` (1-4 digits, 1 letter, 1-5 digits, optional sub-segment)
- `openingBid` is present and ≥ $500 (lower values usually mean truncated digits)
- `plaintiff` doesn't contain attorney-firm patterns like "LLC" / "LLP" / "ESQ" / "& MAIELLO" / "LEGAL TAX SERVICE" (those would indicate column-shift with the attorney field)
- `plaintiffAttorney`, `defendant`, `address`, `municipality`, `saleType` are all present

When any record fails validation, the orchestrator makes a follow-up **repair call** to Claude using the *same* PDF chunk, the list of flagged records, and explicit guidance about column-shift errors. The repair response replaces the bad record. If repair fails too (or only fixes some fields), the record stays in storage with a `needs review` badge on Home and a banner at the top of its property page.

Cost: roughly +5-10% on top of the main parse, only billed for chunks that actually had flagged records.

## Enrichment

When you open a per-property page, the app looks up the county assessor record for that parcel and adds it to the page.

- **Source:** [WPRDC Allegheny County Property Assessments](https://data.wprdc.org/dataset/property-assessments), an open public dataset. No API key, no cost, CORS allows browser-direct queries.
- **Fields surfaced:** use, style, year built, stories, finished sq ft, BR/BA, condition, grade, lot area, fair market value, county assessed value, last sale price + date, prior sale, owner of record
- **Coverage:** every property in Allegheny County. (Pittsburgh-only sources like code violations and liens are planned for a follow-up prompt.)
- **Parcel ID normalization:** Sheriff PDFs use formats like `556-G-276` or `0033-B-00272`; WPRDC uses a 16-char no-separator format like `0556G00276000000`. The app converts automatically. If the source format doesn't match the standard pattern, you'll see a clear "couldn't normalize" message with a link to look the property up manually.
- **Caching:** results are cached in IndexedDB's `geo-data-cache` store for 30 days, keyed by normalized parcel ID. A **Refresh** link on the Property Assessment card bypasses the cache.
- **Spread analysis:** ARV − opening bid, plus margin if won at max bid. ARV defaults to WPRDC fair market value but uses your `arvOverride` if you've set one on this property.

### Pittsburgh-only data (PLI Violations + PLI Permits)

For properties whose Municipality column from the Sheriff PDF is `Pittsburgh`, the per-property page also loads:

- **PLI/DOMI/ES Violations** ([WPRDC dataset](https://data.wprdc.org/dataset/pittsburgh-pli-violations-report)) — open and closed violations, with case file type, status, investigation outcome, and date. Coverage starts **June 2020**; older violations live in a historical resource we don't currently query.
- **PLI Permits** ([WPRDC dataset](https://data.wprdc.org/dataset/pli-permits)) — every permit issued (building, mechanical, electrical, general). Coverage starts **June 2019**.

Both datasets are keyed on the same Allegheny County parcel ID, normalized the same way as the assessor lookup. Both share the 30-day cache TTL.

For properties **outside Pittsburgh proper** (Penn Hills, Munhall, Liberty, etc.), the Pittsburgh data card greys out with an explanation. PLI is a City of Pittsburgh department; surrounding municipalities have their own code enforcement that isn't published through WPRDC. This is the "data unavailable" treatment we designed at the start.

### Hilltop neighborhood flagging

Properties in any of the Pittsburgh Hilltop neighborhoods get an orange "Hilltop" badge on Home and on the per-property page, plus a "Hilltop only" filter on Home for fast triage.

**Tagged neighborhoods:** Allentown, Arlington, Beltzhoover, Bon Air, Carrick, Knoxville, Mt. Oliver Neighborhood, St. Clair, Hays, Lincoln Place, South Side Slopes, Mt. Washington, Duquesne Heights.

Neighborhood data is resolved in four tiers, in order:

1. **PLI violations** — the WPRDC PLI violations dataset has a human-readable `neighborhood` field. Most Pittsburgh parcels have at least one violation record.
2. **PLI permits** — same `neighborhood` field on the permits dataset; fallback when violations is empty.
3. **Geocode + point-in-polygon** — for parcels with no PLI history, we geocode the address via the US Census Geocoder (free, no API key) and look up which neighborhood polygon contains the resulting lat/lng. The polygon data comes from `public/neighborhoods.geojson` (Pittsburgh Department of City Planning, ~1.2 MB, loaded lazily on first need).
4. **Ward-based fallback** — if all of the above fail, the Hilltop badge can still fire based on the assessor's ward (parsed from MUNIDESC). Hilltop wards (Shawn-confirmed): 16, 17, 18, 29, 30, 32.

The bulk enrich runs all four tiers as needed and stores the resulting neighborhood + ward on each property's `enrichmentSummary`. Throttled at 200ms per uncached API call to be polite to free public services. Re-running is cheap: cached lookups skip the API.

### What's NOT enriched (and why)

- **Condemned/unfit property list** — not published as a clean dataset on WPRDC. The city tracks this internally but doesn't expose it for download.
- **Municipal liens at parcel level** — WPRDC only publishes lien data aggregated at the census-tract level, not per-property. For a specific property's lien status you'd still need to check with the City Treasurer directly.

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
│   ├── views/                    ← one file per page (home, upload, settings, property)
│   ├── storage/                  ← IndexedDB stores + per-store helpers
│   ├── pdf/
│   │   ├── parse.js              ← orchestrator: chunk → extract → validate → repair → upsert
│   │   ├── chunking.js           ← splits a PDF into N-page chunks via pdf-lib
│   │   ├── claude.js             ← Anthropic API wrapper (extract + repair calls)
│   │   ├── prompts.js            ← system prompts + property schema
│   │   └── validation.js         ← format + heuristic checks on parsed records
│   ├── enrichment/
│   │   ├── normalize.js          ← Sheriff parcel ID → WPRDC PARID
│   │   ├── wprdc.js              ← WPRDC CKAN API wrapper + dataset IDs
│   │   ├── assessor.js           ← cache-aware assessor lookup (30-day TTL)
│   │   ├── violations.js         ← PLI/DOMI/ES violations (Pittsburgh only)
│   │   ├── permits.js            ← PLI permits (Pittsburgh only)
│   │   ├── geocode.js            ← US Census Geocoder wrapper (address → lat/lng)
│   │   ├── neighborhoods.js      ← point-in-polygon against neighborhoods.geojson
│   │   ├── hilltop.js            ← Hilltop neighborhood list + matcher
│   │   └── bulk.js               ← bulk enrich all Pittsburgh properties
│   └── ui/                       ← shared bits (nav, formatters)
├── index.html
├── package.json
├── vite.config.js
└── README.md (this file)
```
