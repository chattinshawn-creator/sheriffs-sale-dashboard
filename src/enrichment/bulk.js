import { listProperties, setEnrichmentSummary } from '../storage/properties.js'
import { getAssessor } from './assessor.js'
import { getViolations } from './violations.js'
import { getPermits } from './permits.js'
import { getParcelCentroid } from './centroid.js'
import { geocodeViaOsm } from './geocodeOsm.js'

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

    // Report which property we're STARTING on, so the UI shows live movement
    // even while this property's (possibly slow) network calls are in flight.
    onProgress({
      processed, total,
      currentAddress: prop.address,
      neighborhood: null,
      hilltopSoFar: hilltopFound,
      errors,
      status: 'running',
    })

    let neighborhood = null
    let ward = null
    let fairMarketValue = null
    let yearBuilt = null
    let latitude = null
    let longitude = null
    let hitApi = false
    let hitOsm = false  // Nominatim needs a longer (1s) throttle than WPRDC

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

      // PRIMARY source for coordinates + neighborhood: the WPRDC parcel
      // centroids dataset, keyed by PIN (= our parcel ID). Covers the whole
      // county and is CORS-friendly (the Census geocoder is not). Centroid =
      // actual parcel location, more accurate than street-interpolated geocoding.
      if (prop.parcelId) {
        const cen = await getParcelCentroid(prop.parcelId)
        if (cen.fromCache === false) hitApi = true
        if (cen.status === 'ok') {
          latitude = cen.lat
          longitude = cen.lng
          if (cen.cityNeighborhood) neighborhood = cen.cityNeighborhood
        }
      }

      // Pittsburgh fallback: if the centroid didn't carry a neighborhood
      // name, pull it from PLI violations/permits (which have a readable
      // `neighborhood` column).
      if (!neighborhood && prop.isPittsburghProper && prop.parcelId) {
        const violationsRes = await getViolations(prop.parcelId)
        if (violationsRes.fromCache === false) hitApi = true
        neighborhood = firstNonEmpty(violationsRes.data, 'neighborhood')
        if (!neighborhood) {
          const permitsRes = await getPermits(prop.parcelId)
          if (permitsRes.fromCache === false) hitApi = true
          neighborhood = firstNonEmpty(permitsRes.data, 'neighborhood')
        }
      }

      // Coordinate fallback: parcels missing from the centroid dataset
      // (mostly condo units) get geocoded via Nominatim, using the real
      // MUNICIPALITY rather than the mailing city.
      if (latitude == null && prop.address) {
        const coords = await geocodeViaOsm(prop.address, prop.municipality)
        hitOsm = true
        if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
          latitude = coords.lat
          longitude = coords.lng
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

    // Nominatim's usage policy wants ≤1 req/sec; WPRDC is fine at 5/sec.
    if (processed < total) {
      if (hitOsm) await new Promise(r => setTimeout(r, 1100))
      else if (hitApi) await new Promise(r => setTimeout(r, THROTTLE_MS))
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
