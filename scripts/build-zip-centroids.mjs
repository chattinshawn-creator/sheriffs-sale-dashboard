/**
 * Build the bundled ZIP -> lat/long centroid table for the valuation tool's
 * "distance" factor. The table is used ONLY to geocode the reference point the
 * user types (a ZIP); each property already carries its own coordinates from
 * enrichment, so this is a single small lookup table, not per-property data.
 *
 *     node scripts/build-zip-centroids.mjs
 *
 * Source: U.S. Census TIGERweb ArcGIS REST service (keyless, public) — the
 * ZCTA layer exposes CENTLAT/CENTLON (the Census-computed internal centroid)
 * per ZIP Code Tabulation Area. We query exactly the Allegheny-County ZIP set
 * already captured in public/zip_median_income.json so the two bundled tables
 * cover the same ZIPs. Re-run alongside build-zip-income.mjs when refreshing.
 *
 * Output: public/zip_centroids.json
 *   { _source, _layer, _pulled, data: { "15210": [40.4068, -79.9842], ... } }
 *   (lat, lng order; rounded to 5 decimals ~= 1.1 m precision, plenty here)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INCOME = path.join(__dirname, '..', 'public', 'zip_median_income.json')
const OUT = path.join(__dirname, '..', 'public', 'zip_centroids.json')

// TIGERweb ACS2023 layer 2 = "2020 Census ZIP Code Tabulation Areas".
const SERVICE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/2/query'

const main = async () => {
  // Reuse the income table as the canonical Allegheny ZIP set.
  const income = JSON.parse(fs.readFileSync(INCOME, 'utf8'))
  const zips = Object.keys(income.data || {})
  if (zips.length === 0) throw new Error('No ZIPs in zip_median_income.json — build that first.')

  const data = {}
  // Query in batches so the IN() clause / URL stays a sane length.
  const BATCH = 40
  for (let i = 0; i < zips.length; i += BATCH) {
    const batch = zips.slice(i, i + BATCH)
    const inClause = batch.map(z => `'${z}'`).join(',')
    const url = `${SERVICE}?where=${encodeURIComponent(`ZCTA5 IN (${inClause})`)}` +
      `&outFields=ZCTA5,CENTLAT,CENTLON&returnGeometry=false&f=json`
    const r = await fetch(url)
    if (!r.ok) throw new Error(`TIGERweb ${r.status} ${r.statusText}`)
    const j = await r.json()
    for (const f of j.features || []) {
      const z = f.attributes?.ZCTA5
      const lat = Number(f.attributes?.CENTLAT)
      const lng = Number(f.attributes?.CENTLON)
      if (!z || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
      data[z] = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]
    }
  }

  const missing = zips.filter(z => !data[z])
  const out = {
    _source: 'U.S. Census TIGERweb ArcGIS REST, layer "2020 Census ZIP Code Tabulation Areas" (CENTLAT/CENTLON); queried for the Allegheny ZIP set in zip_median_income.json',
    _layer: 'tigerWMS_ACS2023/MapServer/2',
    _pulled: new Date().toISOString().slice(0, 10),
    data,
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0))
  console.log(`Wrote ${OUT}`)
  console.log(`  kept ${Object.keys(data).length} of ${zips.length} ZIPs` +
    (missing.length ? `; no centroid for: ${missing.join(', ')}` : ''))
  console.log(`  file size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`)
}

main().catch(e => { console.error(e); process.exit(1) })
