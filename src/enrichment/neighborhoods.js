/**
 * Pittsburgh-neighborhoods point-in-polygon lookup.
 *
 * Loads the GeoJSON from /public/neighborhoods.geojson (served at runtime
 * relative to the Vite base URL) and exposes neighborhoodAtPoint(lat, lng).
 *
 * The file is fetched once on first use and cached in memory for the rest
 * of the page session — ~1.2MB so we don't want to fetch it repeatedly.
 *
 * Each feature in the GeoJSON is a Census block group polygon tagged with
 * a `hood` field (the parent neighborhood name). A neighborhood typically
 * spans 3-10 block groups, but for point-in-polygon we don't need to
 * pre-merge them — we just iterate and return on first hit.
 */

let _featuresPromise = null

function loadFeatures() {
  if (_featuresPromise) return _featuresPromise
  // Vite injects the correct base URL at build time so this works locally
  // (/neighborhoods.geojson) and on Pages (/sheriffs-sale-dashboard/...).
  const url = `${import.meta.env.BASE_URL}neighborhoods.geojson`
  _featuresPromise = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`Failed to load neighborhoods.geojson: ${r.status}`)
      return r.json()
    })
    .then(data => data.features || [])
    .catch(err => {
      _featuresPromise = null  // allow retry
      throw err
    })
  return _featuresPromise
}

/**
 * Return the Pittsburgh neighborhood name containing (lat, lng), or null
 * if the point is outside every polygon.
 */
export async function neighborhoodAtPoint(lat, lng) {
  if (lat == null || lng == null) return null
  const features = await loadFeatures()
  for (const feature of features) {
    if (pointInFeature(lat, lng, feature)) {
      return feature.properties?.hood || null
    }
  }
  return null
}

function pointInFeature(lat, lng, feature) {
  const geom = feature.geometry
  if (!geom) return false
  if (geom.type === 'Polygon') {
    return pointInPolygonRings(lat, lng, geom.coordinates)
  }
  if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.coordinates) {
      if (pointInPolygonRings(lat, lng, polygon)) return true
    }
  }
  return false
}

/**
 * Standard ray-casting point-in-polygon, accounting for the outer ring
 * (first) and any inner rings (holes) that follow it. GeoJSON coordinates
 * are [lng, lat] pairs.
 */
function pointInPolygonRings(lat, lng, rings) {
  if (!rings || rings.length === 0) return false
  // Must be inside the outer ring AND outside every hole.
  if (!pointInRing(lat, lng, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lat, lng, rings[i])) return false
  }
  return true
}

function pointInRing(lat, lng, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
