/**
 * Build the bundled ZIP → median household income table for the valuation
 * tool's "median income" factor.
 *
 *     node scripts/build-zip-income.mjs
 *
 * Source: U.S. Census American Community Survey (ACS) 5-year, table B19013
 * (median household income), by ZCTA. Pulled via the free, keyless Census
 * Reporter API (censusreporter.org), which serves the same Census table — the
 * Census Bureau's own API now requires a per-user key, and bundling avoids any
 * runtime network dependency anyway.
 *
 * The parent-child query "860|05000US42003" = every ZCTA within Allegheny
 * County (FIPS 42003). Re-run this when a newer ACS 5-year release drops; it
 * stamps the release + pull date into the output header.
 *
 * Output: public/zip_median_income.json  { _source, _table, _year, _pulled, data: { "15210": 52169, ... } }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public', 'zip_median_income.json')
const URL = 'https://api.censusreporter.org/1.0/data/show/latest?table_ids=B19013&geo_ids=860|05000US42003'

const main = async () => {
  const r = await fetch(URL)
  if (!r.ok) throw new Error(`Census Reporter ${r.status} ${r.statusText}`)
  const j = await r.json()

  const data = {}
  let kept = 0, skipped = 0
  for (const [geoId, rec] of Object.entries(j.data || {})) {
    // geoId looks like "86000US15210" → trailing 5 digits are the ZCTA/ZIP.
    const zip = geoId.slice(-5)
    const est = rec?.B19013?.estimate?.B19013001
    if (est == null || !Number.isFinite(Number(est))) { skipped++; continue }
    data[zip] = Math.round(Number(est))
    kept++
  }

  const out = {
    _source: 'U.S. Census ACS 5-year, table B19013 (median household income), via Census Reporter API (censusreporter.org); parent-child query 860|05000US42003 = all ZCTAs in Allegheny County',
    _table: 'B19013',
    _year: j.release?.name || 'unknown',         // e.g. "ACS 2024 5-year"
    _pulled: new Date().toISOString().slice(0, 10),
    data,
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0))
  console.log(`Wrote ${OUT}`)
  console.log(`  ${out._year}; kept ${kept} ZIPs, skipped ${skipped} (no estimate)`)
  console.log(`  file size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`)
}

main().catch(e => { console.error(e); process.exit(1) })
