import { listProperties, setEnrichmentSummary } from '../storage/properties.js'
import { getAssessor } from './assessor.js'
import { getViolations } from './violations.js'
import { getPermits } from './permits.js'
import { geocodeAddress } from './geocode.js'
import { neighborhoodAtPoint } from './neighborhoods.js'

/**
 * Throttle delay between WPRDC API calls. 200ms = 5 req/sec, polite to a
 * free public API. Cache-only properties skip the delay since no API call
 * happens.
 */
const THROTTLE_MS = 200

let cancelFlag = false

/** Cancel any in-flight bulk enrichment loop (cooperative). */
export function cancelBulkEnrichment() {
  cancelFlag = true
}

/**
 * Walk every Pittsburgh property and ensure its assessor data is fetched,
 * then denormalize neighborhood + ward + fair-market-value + year-built
 * onto the property record so Home can filter/badge them efficiently.
 *
 * Properties already enriched (with assessor data cached AND summary already
 * populated on the record) are skipped — re-running the bulk enrich is cheap.
 *
 * @param {(info: {
 *   processed: number, total: number, currentAddress: string|null,
 *   neighborhood: string|null, hilltopSoFar: number, errors: number, status: 'running'|'done'|'cancelled'
 * }) => void} [onProgress]
 * @returns {Promise<{ processed: number, enriched: number, hilltopFound: number, errors: number, cancelled: boolean }>}
 */
export async function enrichAllPittsburghProperties(onProgress = () => {}) {
  cancelFlag = false

  const all = await listProperties()
  const targets = all.filter(p => p.isPittsburghProper && p.parcelId)
  const total = targets.length

  let processed = 0
  let enriched = 0
  let hilltopFound = 0
  let errors = 0

  // Import locally to avoid a cycle with the home view.
  const { isHilltopNeighborhood } = await import('./hilltop.js')

  for (const prop of targets) {
    if (cancelFlag) break

    let neighborhood = null
    let ward = null
    let fairMarketValue = null
    let yearBuilt = null
    let latitude = null
    let longitude = null
    let hitApi = false

    try {
      // Assessor: year built + fair market + ward (parsed from MUNIDESC).
      // Assessor's NEIGHDESC field is unfortunately a numeric county
      // assessor code, NOT a human-readable neighborhood name — so we get
      // the real neighborhood from violations/permits below.
      const assessorRes = await getAssessor(prop.parcelId)
      if (assessorRes.fromCache === false) hitApi = true
      if (assessorRes.status === 'ok' && assessorRes.data) {
        const d = assessorRes.data
        fairMarketValue = d.FAIRMARKETTOTAL ?? null
        yearBuilt = d.YEARBLT ? Math.round(d.YEARBLT) : null
        ward = parseWardFromMunidesc(d.MUNIDESC)
      }

      // Neighborhood + coords: try violations first (most properties have at
      // least one record there since the dataset is dense). Fall back to
      // permits. Last resort: geocode the address and look up the
      // neighborhood polygon containing it.
      const violationsRes = await getViolations(prop.parcelId)
      if (violationsRes.fromCache === false) hitApi = true
      neighborhood = firstNonEmpty(violationsRes.data, 'neighborhood')
      ;({ latitude, longitude } = firstLatLng(violationsRes.data) || { latitude: null, longitude: null })

      if (!neighborhood || latitude == null) {
        const permitsRes = await getPermits(prop.parcelId)
        if (permitsRes.fromCache === false) hitApi = true
        if (!neighborhood) neighborhood = firstNonEmpty(permitsRes.data, 'neighborhood')
        if (latitude == null) {
          const ll = firstLatLng(permitsRes.data)
          if (ll) { latitude = ll.latitude; longitude = ll.longitude }
        }
      }

      if ((!neighborhood || latitude == null) && prop.address) {
        const coords = await geocodeAddress(prop.address)
        if (coords) {
          hitApi = true  // we called Census API
          if (latitude == null) { latitude = coords.lat; longitude = coords.lng }
          if (!neighborhood) {
            neighborhood = await neighborhoodAtPoint(coords.lat, coords.lng)
          }
        }
      }

      await setEnrichmentSummary(prop.caseNumber, {
        neighborhood, ward, fairMarketValue, yearBuilt, latitude, longitude,
        // Mark that we've tried — so the bulk-enrich button stops counting
        // this property as "unenriched" when there's simply no PLI data
        // available for it.
        attemptedAt: Date.now(),
      })
      enriched++
      // Count Hilltop using the full property-level check (neighborhood
      // OR ward-based fallback) — so this matches what the UI shows.
      const summary = { neighborhood, ward }
      const { isHilltopProperty } = await import('./hilltop.js')
      if (isHilltopProperty({ enrichmentSummary: summary })) hilltopFound++
    } catch (e) {
      console.warn(`[bulk] enrichment failed for ${prop.caseNumber}:`, e)
      errors++
    }

    processed++
    onProgress({
      processed, total,
      currentAddress: prop.address,
      neighborhood,
      hilltopSoFar: hilltopFound,
      errors,
      status: 'running',
    })

    // Throttle only when we actually hit the API.
    if (hitApi && processed < total) {
      await new Promise(r => setTimeout(r, THROTTLE_MS))
    }
  }

  const finalStatus = cancelFlag ? 'cancelled' : 'done'
  onProgress({
    processed, total, currentAddress: null, neighborhood: null,
    hilltopSoFar: hilltopFound, errors, status: finalStatus,
  })

  return { processed, enriched, hilltopFound, errors, cancelled: cancelFlag }
}

/** Extract the first non-empty value of `field` from a list of records. */
function firstNonEmpty(records, field) {
  if (!Array.isArray(records)) return null
  for (const r of records) {
    const v = r?.[field]
    if (v && String(v).trim()) return String(v).trim()
  }
  return null
}

/** Extract the first {latitude, longitude} pair from a list of records. */
function firstLatLng(records) {
  if (!Array.isArray(records)) return null
  for (const r of records) {
    const lat = Number(r?.latitude)
    const lng = Number(r?.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { latitude: lat, longitude: lng }
    }
  }
  return null
}

/** Parse "30th Ward - PITTSBURGH" → "30". Returns null for non-Pittsburgh. */
function parseWardFromMunidesc(munidesc) {
  if (!munidesc) return null
  const m = String(munidesc).match(/(\d+)\w*\s+Ward/i)
  return m ? m[1] : null
}
