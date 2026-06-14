/**
 * End-to-end spot check for the four new enrichment fields, run against LIVE
 * WPRDC data + the bundled QOZ polygons, for one known Carrick parcel.
 *
 *     node scripts/spot-check-carrick.mjs [PARID]
 *
 * This is the CLI stand-in for "open the app and enrich the sale list": it
 * exercises the same pure functions the browser uses (extractSizeFields,
 * summarizeViolations, pointInFeature, parseZipFromAddress) on real records,
 * so we can confirm the logic before touching IndexedDB. The full N-property
 * run still happens in the app (this script can't read your uploaded PDF).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSizeFields } from '../src/enrichment/assessorFields.js'
import { summarizeViolations } from '../src/enrichment/violationsSummary.js'
import { pointInFeature } from '../src/enrichment/pointInPolygon.js'
import { parseZipFromAddress } from '../src/enrichment/income.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = 'https://data.wprdc.org/api/3/action'
const ASSESS = '65855e14-549e-4992-b5be-d629afc676fa'
const VIOL = '70c06278-92c5-4040-ab28-17671866f81c'
const PARID = process.argv[2] || '0095D00083000000' // 148 Madeline St, Carrick

async function ds(resource, filters, limit = 1000) {
  const u = `${API}/datastore_search?resource_id=${resource}&filters=${encodeURIComponent(JSON.stringify(filters))}&limit=${limit}`
  const j = await (await fetch(u)).json()
  if (!j.success) throw new Error('WPRDC error: ' + JSON.stringify(j.error))
  return j.result.records
}

const main = async () => {
  console.log(`\n=== Spot check: PARID ${PARID} ===\n`)

  // ── Part A: size off the assessor record ──
  const [assess] = await ds(ASSESS, { PARID }, 1)
  if (!assess) { console.log('No assessor record found.'); return }
  const size = extractSizeFields(assess)
  console.log('ASSESSOR (raw):', {
    addr: assess.PROPERTYADDRESS, FINISHEDLIVINGAREA: assess.FINISHEDLIVINGAREA,
    BEDROOMS: assess.BEDROOMS, FULLBATHS: assess.FULLBATHS, HALFBATHS: assess.HALFBATHS,
    FAIRMARKETTOTAL: assess.FAIRMARKETTOTAL, YEARBLT: assess.YEARBLT,
  })
  console.log('→ size fields:', size)

  // ── Part B: violation risk summary ──
  const vrows = await ds(VIOL, { parcel_id: PARID })
  const vsum = summarizeViolations(vrows)
  console.log(`\nVIOLATIONS: ${vrows.length} raw rows →`,
    { total: vsum.total, open: vsum.open, recent: vsum.recent, headline: vsum.headline })
  console.log('→ detail (top 5):', vsum.detail.slice(0, 5))

  // ── Part C: Opportunity Zone (use the violation row's lat/long, or assessor) ──
  const geo = vrows.find(r => Number.isFinite(Number(r.latitude)))
  const lat = geo ? Number(geo.latitude) : null
  const lng = geo ? Number(geo.longitude) : null
  const ozPath = path.join(__dirname, '..', 'public', 'opportunity_zones.geojson')
  const oz = JSON.parse(fs.readFileSync(ozPath, 'utf8'))
  let inOZ = null, tract = null
  if (lat != null && lng != null) {
    inOZ = false
    for (const f of oz.features) {
      if (pointInFeature(lat, lng, f)) { inOZ = true; tract = f.properties.geoid; break }
    }
  }
  console.log(`\nOPPORTUNITY ZONE: coords (${lat}, ${lng}) → inOpportunityZone=${inOZ}`,
    tract ? `tract ${tract}` : '', `(${oz.features.length} Allegheny tracts loaded)`)

  // ── Part D: ZIP parse (income value requires the bundled table) ──
  const zip = parseZipFromAddress((geo && geo.address) || assess.PROPERTYADDRESS)
  console.log(`\nZIP parsed from address: ${zip}`)
  const incPath = path.join(__dirname, '..', 'public', 'zip_median_income.json')
  if (fs.existsSync(incPath)) {
    const inc = JSON.parse(fs.readFileSync(incPath, 'utf8'))
    console.log(`→ zipMedianIncome: ${inc.data?.[zip] ?? 'null (zip not in table)'}`)
  } else {
    console.log('→ zip_median_income.json not built yet → zipMedianIncome would be null')
  }
  console.log('\n=== done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
