# Sheriff's Sale Dashboard

A personal web app for browsing and bidding on Allegheny County, PA Sheriff's Sale properties. Runs entirely in your browser. No server, no database, no account.

## Status

**Foundation only.** You can upload Sheriff's Sale PDFs and they're kept in your browser's local database. PDF parsing, property enrichment, ranked lists, and per-property pages are planned for follow-up prompts.

## What works today

- Home / Upload / Settings views with simple top-nav routing
- Upload a single PDF at a time (drag-and-drop or file picker)
- Auto-detects document type (listings vs results) and sale month from the filename, with a confirmation step
- Appends every upload to a persistent archive (never overwrites)
- Warns on duplicate uploads (same filename + size)
- Stores your Anthropic API key in this browser only (with a "Clear key" button)
- "Parse PDF" button that returns a TODO message (placeholder for the next prompt)

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
(Future) Parse PDF button calls the Anthropic API → extracts properties
  ↓
(Future) Properties are stored in IndexedDB ("properties" store), keyed by case
         number, so notes you make on a property follow it across multiple
         monthly sales
  ↓
(Future) Home view shows a ranked list; clicking a property opens a per-property
         page
```

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

- **PDF parsing is not implemented yet.** The "Parse PDF" button is a placeholder. The next prompt adds the real parser using the Anthropic API.
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
│   ├── router.js                 ← tiny hash-based router (~30 lines)
│   ├── styles.css
│   ├── views/                    ← one file per page (home, upload, settings)
│   ├── storage/                  ← IndexedDB stores + per-store helpers
│   ├── pdf/parse.js              ← STUB for the next prompt
│   └── ui/                       ← shared bits (nav, formatters)
├── index.html
├── package.json
├── vite.config.js
└── README.md (this file)
```
