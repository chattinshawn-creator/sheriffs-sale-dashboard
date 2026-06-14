/**
 * Resolve the distance-factor reference point the user types into coordinates.
 *
 * Accepts either:
 *   - a "lat,lng" pair  ("40.44, -79.98")  -> used directly
 *   - a 5-digit ZIP     ("15210")          -> looked up in the bundled
 *                                             Allegheny ZIP-centroid table
 *
 * The centroid table (public/zip_centroids.json) is built by
 * scripts/build-zip-centroids.mjs from the Census TIGERweb ZCTA layer. Missing
 * file / unknown ZIP -> null (the view shows a hint; the distance factor then
 * scores neutral for every property until a valid reference is entered).
 */
let _mapPromise = null
let _map = null

export function loadZipCentroids() {
  if (_mapPromise) return _mapPromise
  const url = `${import.meta.env.BASE_URL}zip_centroids.json`
  _mapPromise = fetch(url)
    .then(r => (r.ok ? r.json() : { data: {} }))
    .then(json => { _map = json?.data || {}; return _map })
    .catch(() => { _map = {}; return _map })
  return _mapPromise
}

/**
 * Resolve typed reference text to { lat, lng } or null. Caller must have
 * awaited loadZipCentroids() first (so ZIP lookups have data).
 *
 * @returns {{ lat:number, lng:number, kind:'latlng'|'zip', label:string } | null}
 */
export function resolveReferencePoint(text) {
  const s = String(text || '').trim()
  if (!s) return null

  // lat,lng pair?
  const pair = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (pair) {
    const lat = Number(pair[1])
    const lng = Number(pair[2])
    if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng, kind: 'latlng', label: `${lat}, ${lng}` }
    }
    return null
  }

  // ZIP?
  const zip = s.match(/^\d{5}$/) ? s : null
  if (zip && _map && _map[zip]) {
    const [lat, lng] = _map[zip]
    return { lat, lng, kind: 'zip', label: `ZIP ${zip}` }
  }
  return null
}
