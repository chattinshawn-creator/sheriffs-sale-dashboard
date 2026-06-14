import { listProperties, setEnrichmentSummary } from '../storage/properties.js'
import { getAssessor } from './assessor.js'
import { getViolations, summarizeViolations } from './violations.js'
import { getPermits } from './permits.js'
import { getParcelCentroid } from './centroid.js'
import { geocodeViaOsm } from './geocodeOsm.js'
import { extractSizeFields } from './assessorFields.js'
import { loadOpportunityZoneIndex, getOpportunityZoneSync } from './opportunityZone.js'
import { loadIncomeIndex, getZipMedianIncomeSync, parseZipFromAddress } from './income.js'

/**
 * Enrichment schema version. BUMP THIS whenever bulk enrich starts writing a
 * new enrichmentSummary field, so properties enriched under an older version
 * are recognized as needing a refresh (the Home "needs enrichment" count keys
 * off it). Re-running is cheap — the underlying API data is cached 30 days, so
 * a refresh just recomputes the new fields from cache.
 *   v1: neighborhood, ward, fairMarketValue, yearBuilt, lat/long
 *   v2: + squareFeet/bedrooms/bathrooms, codeViolations, OZ, zipMedianIncome
 */
export const ENRICH_VERSION = 2

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

  // Load the two bundled lookups ONCE up front (not per-property). If the QOZ
  // polygons fail to load, ozAvailable stays false and every property records
  // inOpportunityZone:null with a note rather than a wrong false. The income
  // table loads silently (missing file → neutral nulls).
  let ozAvailable = false
  try {
    await loadOpportunityZoneIndex()
    ozAvailable = true
  } catch (e) {
    console.warn('[bulk] Opportunity Zone polygons failed to load; OZ left null:', e)
  }
  await loadIncomeIndex()

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
    // New (valuation) fields. Size = countywide; violations = Pittsburgh-only;
    // OZ + income = countywide. All default to null = "unknown / neutral".
    let squareFeet = null
    let bedrooms = null
    let bathrooms = null
    let fullBaths = null
    let halfBaths = null
    let codeViolations = null
    let codeViolationsNote = null
    let inOpportunityZone = null
    let ozTract = null
    let ozNote = null
    let zipMedianIncome = null
    let hitApi = false
    let hitOsm = false  // Nominatim needs a longer (1s) throttle than WPRDC

    try {
      // Assessor works countywide: year built + fair market + ward, PLUS the
      // building-size fields (sqft / beds / baths) the valuation tool needs.
      // These come off the SAME record — no extra network call.
      if (prop.parcelId) {
        const assessorRes = await getAssessor(prop.parcelId)
        if (assessorRes.fromCache === false) hitApi = true
        if (assessorRes.status === 'ok' && assessorRes.data) {
          const d = assessorRes.data
          fairMarketValue = d.FAIRMARKETTOTAL ?? null
          yearBuilt = d.YEARBLT ? Math.round(d.YEARBLT) : null
          ward = parseWardFromMunidesc(d.MUNIDESC)
          const size = extractSizeFields(d)
          squareFeet = size.squareFeet
          bedrooms = size.bedrooms
          bathrooms = size.bathrooms
          fullBaths = size.fullBaths
          halfBaths = size.halfBaths
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

      // Code violations (RISK) — Pittsburgh PLI/DOMI/ES dataset is city-only,
      // so this factor is Pittsburgh-proper only. We fetch the parcel's
      // violation rows ONCE here and reuse them for both (a) the risk summary
      // and (b) the neighborhood-name fallback below.
      //
      // null vs 0 matters: non-Pittsburgh parcels get null + a note (the data
      // simply doesn't cover them — NOT "clean"); a Pittsburgh parcel with no
      // rows gets a real 0 (genuinely clean).
      if (prop.isPittsburghProper && prop.parcelId) {
        const violationsRes = await getViolations(prop.parcelId)
        if (violationsRes.fromCache === false) hitApi = true
        if (violationsRes.status === 'ok') {
          codeViolations = summarizeViolations(violationsRes.data)
          codeViolationsNote = null
          // Neighborhood fallback reuses the rows we just fetched.
          if (!neighborhood) neighborhood = firstNonEmpty(violationsRes.data, 'neighborhood')
        } else {
          // normalize-failed or network error: honestly null, with the reason.
          codeViolations = null
          codeViolationsNote = violationsRes.status === 'error'
            ? 'violations lookup unavailable (network?)'
            : 'parcel ID could not be matched to the violations dataset'
        }
        // Last-ditch neighborhood source: PLI permits.
        if (!neighborhood) {
          const permitsRes = await getPermits(prop.parcelId)
          if (permitsRes.fromCache === false) hitApi = true
          neighborhood = firstNonEmpty(permitsRes.data, 'neighborhood')
        }
      } else if (!prop.isPittsburghProper) {
        codeViolations = null
        codeViolationsNote = 'outside City of Pittsburgh'
      } else {
        // Pittsburgh but no parcel ID to match on.
        codeViolations = null
        codeViolationsNote = 'no parcel ID to match'
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

      // Opportunity Zone (countywide) — point-in-polygon against the bundled
      // QOZ tracts, using whatever coordinates we resolved above. No coords or
      // polygons-unavailable → null + note (neutral), never a wrong false.
      if (!ozAvailable) {
        inOpportunityZone = null
        ozTract = null
        ozNote = 'opportunity-zone polygons unavailable'
      } else if (latitude == null || longitude == null) {
        inOpportunityZone = null
        ozTract = null
        ozNote = 'no coordinates to test'
      } else {
        const oz = getOpportunityZoneSync(latitude, longitude)
        inOpportunityZone = oz ? oz.inOpportunityZone : null
        ozTract = oz ? oz.ozTract : null
        ozNote = null
      }

      // ZIP median household income (countywide) — bundled ACS lookup keyed by
      // the ZIP parsed out of the address. Missing ZIP / not-in-table → null.
      zipMedianIncome = getZipMedianIncomeSync(parseZipFromAddress(prop.address))

      await setEnrichmentSummary(prop.caseNumber, {
        neighborhood, ward, fairMarketValue, yearBuilt, latitude, longitude,
        squareFeet, bedrooms, bathrooms, fullBaths, halfBaths,
        codeViolations, codeViolationsNote,
        inOpportunityZone, ozTract, ozNote,
        zipMedianIncome,
        attemptedAt: Date.now(),
        enrichVersion: ENRICH_VERSION,
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
