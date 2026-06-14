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

import { pointInFeature } from './pointInPolygon.js'

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
