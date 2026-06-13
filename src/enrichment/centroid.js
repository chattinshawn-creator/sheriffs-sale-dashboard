import { stores, get, set } from '../storage/db.js'
import { normalizeParcelId } from './normalize.js'
import { fetchAllByFilter } from './wprdc.js'

/**
 * Parcel centroid lookup from the WPRDC "Parcel Centroids in Allegheny
 * County with Geographic Identifiers" dataset.
 *
 * This is the PRIMARY source for map coordinates + neighborhood because:
 *   - It's keyed by PIN (the 16-char parcel ID = our normalized parcelId)
 *   - It covers all ~585k county parcels (not just Pittsburgh)
 *   - It's served by WPRDC's CKAN API, which sends CORS headers (unlike the
 *     US Census geocoder, which is CORS-blocked from the browser)
 *   - Centroid = the actual parcel location, more accurate than street-
 *     interpolated geocoding
 *
 * Fields used: LAT, LONG, CITY_NEIGHBORHOOD (Pittsburgh only), MUNI_NAME.
 *
 * Dataset: https://data.wprdc.org/dataset/parcel-centroids-in-allegheny-county-with-geographic-identifiers
 */
export const CENTROID_RESOURCE_ID = '3fab7152-3f11-4788-8372-4c33f86ea813'

const TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year — parcels don't move

/**
 * @param {string} rawParcelId - parcel ID as it appears on the property
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{
 *   status: 'ok' | 'not-found' | 'normalize-failed' | 'error',
 *   pin?: string,
 *   lat?: number, lng?: number,
 *   cityNeighborhood?: string|null,
 *   muniName?: string|null,
 *   fromCache?: boolean,
 *   error?: string,
 * }>}
 */
export async function getParcelCentroid(rawParcelId, opts = {}) {
  const pin = normalizeParcelId(rawParcelId)
  if (!pin) return { status: 'normalize-failed' }

  const cacheKey = 'centroid:' + pin
  if (!opts.force) {
    const cached = await get(cacheKey, stores.geoDataCache)
    if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) {
      return cached.data || { status: 'not-found', pin }
    }
  }

  let records
  try {
    records = await fetchAllByFilter(CENTROID_RESOURCE_ID, { PIN: pin }, { limit: 1 })
  } catch (e) {
    return { status: 'error', pin, error: String(e?.message || e) }
  }

  const r = records[0]
  let result
  if (r && Number.isFinite(Number(r.LAT)) && Number.isFinite(Number(r.LONG))) {
    result = {
      status: 'ok',
      pin,
      lat: Number(r.LAT),
      lng: Number(r.LONG),
      cityNeighborhood: (r.CITY_NEIGHBORHOOD && String(r.CITY_NEIGHBORHOOD).trim()) || null,
      muniName: (r.MUNI_NAME && String(r.MUNI_NAME).trim()) || null,
    }
  } else {
    result = { status: 'not-found', pin }
  }

  await set(cacheKey, { data: result, fetchedAt: Date.now() }, stores.geoDataCache)
  return { ...result, fromCache: false }
}
