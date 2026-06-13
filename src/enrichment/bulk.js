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
 * Walk every property (or just Pittsburgh ones) and denormalize
 * neighborhood + ward + fair-market-value + year-built + coordinates onto
 * the property record so Home / Map can filter/badge/plot them efficiently.
 *
 * Pittsburgh properties get the full treatment: assessor + PLI
 * violations/permits (for neighborhood + coords) + geocode fallback.
 * Non-Pittsburgh properties get assessor (works countywide) + geocode only
 * — the PLI datasets are Pittsburgh-only so we skip those wasted calls.
 *
 * @param {(info: {...}) => void} [onProgress]
 * @param {{ pittsburghOnly?: boolean }} [opts]
 * @returns {Promise<{ processed, enriched, hilltopFound, errors, cancelled }>}
 */
export async function enrichAllProperties(onProgress = () => {}, opts = {}) {
  cancelFlag = false
  const { pittsburghOnly = false } = opts

  const all = await listProperties()
  const targets = all.filter(p =>
    (p.parcelId || p.address) && (!pittsburghOnly || p.isPittsburghProper)
  )
  const total = targets.length

  let processed = 0
  let enriched = 0
  let hilltopFound = 0
  let errors = 0

  const { isHilltopProperty } = await import('./hilltop.js')

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
      // Assessor works countywide: year built + fair market + ward.
      if (prop.parcelId) {
        const assessorRes = await getAssessor(prop.parcelId)
        if (assessorRes.fromCache === false) hitApi = true
        if (assessorRes.status === 'ok' && assessorRes.data) {
          const d = assessorRes.data
          fairMarketValue = d.FAIRMARKETTOTAL ?? null
          yearBuilt = d.YEARBLT ? Math.round(d.YEARBLT) : null
          ward = parseWardFromMunidesc(d.MUNIDESC)
        }
      }

      // PLI violations/permits are Pittsburgh-only — only query them for
      // Pittsburgh properties (they'd return empty for everyone else).
      if (prop.isPittsburghProper && prop.parcelId) {
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
      }

      // Geocode fallback (countywide): fills missing coords for everyone,
      // and the neighborhood polygon for Pittsburgh parcels with no PLI data.
      if (latitude == null && prop.address) {
        const coords = await geocodeAddress(prop.address)
        if (coords) {
          hitApi = true  // we called Census API
          latitude = coords.lat
          longitude = coords.lng
          if (!neighborhood && prop.isPittsburghProper) {
            neighborhood = await neighborhoodAtPoint(coords.lat, coords.lng)
          }
        }
      }

      await setEnrichmentSummary(prop.caseNumber, {
        neighborhood, ward, fairMarketValue, yearBuilt, latitude, longitude,
        attemptedAt: Date.now(),
      })
      enriched++
      if (isHilltopProperty({ enrichmentSummary: { neighborhood, ward } })) hilltopFound++
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

// Backward-compatible alias (Pittsburgh-only) for any existing callers.
export function enrichAllPittsburghProperties(onProgress) {
  return enrichAllProperties(onProgress, { pittsburghOnly: true })
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
