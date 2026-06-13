import { stores, get, set } from '../storage/db.js'

/**
 * Geocode an address via OpenStreetMap Nominatim — used as a fallback when
 * the parcel centroid dataset has no record (mostly condo units, which the
 * county centroid file omits).
 *
 * Chosen over the US Census geocoder because Nominatim sends CORS headers
 * (`access-control-allow-origin: *`) so it works from the browser; Census
 * does not.
 *
 * Usage policy: max ~1 request/second. The bulk enricher throttles this
 * path accordingly. Results cached for a year.
 *
 * IMPORTANT: build the query from the property's MUNICIPALITY, not the
 * mailing city. Sheriff PDFs list many suburban properties with a
 * "Pittsburgh" mailing city even though the real municipality is Whitehall,
 * Castle Shannon, Ross, etc. — and Nominatim matches far better on the real
 * municipality.
 */
const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const TTL_MS = 365 * 24 * 60 * 60 * 1000

/**
 * @param {string} street - street line, e.g. "213 Shadowlawn Circle"
 * @param {string} municipality - e.g. "Whitehall"
 * @returns {Promise<{lat:number, lng:number}|null>}
 */
export async function geocodeViaOsm(street, municipality) {
  const cleanStreet = cleanStreetLine(street)
  if (!cleanStreet) return null
  const query = [cleanStreet, municipality, 'PA'].filter(Boolean).join(', ')
  const key = 'osm:' + query.toUpperCase()

  const cached = await get(key, stores.geoDataCache)
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) {
    return cached.data  // may be null (cached miss)
  }

  const params = new URLSearchParams({
    q: query, format: 'json', limit: '1', countrycodes: 'us',
  })

  let coords = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    let res
    try {
      res = await fetch(`${ENDPOINT}?${params}`, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data[0]) {
        coords = { lat: Number(data[0].lat), lng: Number(data[0].lon) }
      }
    }
  } catch (e) {
    console.warn('[osm] geocode failed for', query, e?.name || e)
  }

  await set(key, { data: coords, fetchedAt: Date.now() }, stores.geoDataCache)
  return coords
}

/**
 * Pull a usable street line out of the messy `address` field.
 * Takes everything before the first comma, then strips trailing decorations
 * the Sheriff PDF appends like " - CONDOMINIUM", " - 4TH WARD", "Apt. 13".
 */
function cleanStreetLine(address) {
  if (!address) return null
  let s = String(address).split(',')[0]          // "128 N Craig Street 305 - 4TH WARD - CONDOMINIUM"
  s = s.split(' - ')[0]                            // "128 N Craig Street 305"
  s = s.replace(/\bapt\.?\s*\S+/i, '')             // drop "Apt. 13"
  s = s.replace(/\bunit\s*\S+/i, '')               // drop "Unit 5"
  return s.replace(/\s+/g, ' ').trim()
}
