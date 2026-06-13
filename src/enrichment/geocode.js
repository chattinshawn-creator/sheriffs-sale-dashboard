import { stores, get, set } from '../storage/db.js'

/**
 * Geocode a US address to (lat, lng) using the US Census Geocoder.
 *
 * Free, no API key, CORS-friendly. Generous rate limits (~10k requests/day
 * per origin, well above what this app needs). Returns the first match if
 * any, or null if the address can't be geocoded.
 *
 * Results are cached in IndexedDB under "geocode:<normalized-address>" so
 * we never re-geocode the same address.
 */
const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'

const TTL_MS = 365 * 24 * 60 * 60 * 1000  // 1 year — addresses don't move

export async function geocodeAddress(rawAddress) {
  if (!rawAddress) return null
  const key = 'geocode:' + normalizeAddressKey(rawAddress)

  const cached = await get(key, stores.geoDataCache)
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) {
    return cached.data  // may be null (cached miss)
  }

  const params = new URLSearchParams({
    address: rawAddress,
    benchmark: 'Public_AR_Current',
    format: 'json',
  })
  let coords = null
  try {
    // Abort if the Census Geocoder stalls — without this, one slow request
    // would hang the whole bulk-enrich loop indefinitely.
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
      const match = data?.result?.addressMatches?.[0]
      if (match?.coordinates) {
        coords = { lat: match.coordinates.y, lng: match.coordinates.x }
      }
    }
  } catch (e) {
    // Timeout (AbortError) or network error — treat as "no match" and move on.
    console.warn('[geocode] failed for', rawAddress, e?.name || e)
  }

  await set(key, { data: coords, fetchedAt: Date.now() }, stores.geoDataCache)
  return coords
}

function normalizeAddressKey(addr) {
  return String(addr).toUpperCase().replace(/\s+/g, ' ').trim()
}
