/**
 * Shared ray-casting point-in-polygon for GeoJSON features.
 *
 * Extracted from neighborhoods.js so the Pittsburgh-neighborhood lookup and
 * the Opportunity-Zone lookup use ONE implementation rather than two copies.
 * GeoJSON coordinates are [lng, lat] pairs.
 */

/** True if (lat, lng) falls inside a Polygon/MultiPolygon GeoJSON feature. */
export function pointInFeature(lat, lng, feature) {
  const geom = feature?.geometry
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
 * Inside the outer ring (first) AND outside every hole ring (the rest).
 */
export function pointInPolygonRings(lat, lng, rings) {
  if (!rings || rings.length === 0) return false
  if (!pointInRing(lat, lng, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lat, lng, rings[i])) return false
  }
  return true
}

export function pointInRing(lat, lng, ring) {
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
