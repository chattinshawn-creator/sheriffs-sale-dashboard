/**
 * Qualified Opportunity Zone (QOZ) lookup, county-wide.
 *
 * A QOZ is a federally designated census tract (IRS §1400Z) where investors
 * get capital-gains tax breaks. Designations were made in 2018 and are fixed
 * by law; a new "OZ 2.0" nomination cycle opens July 1, 2026 but no new tracts
 * are designated yet, so the bundled file is the current legal set.
 *
 * Source: HUD Opportunity Zones layer
 *   services.arcgis.com/VTyQ9soqVukalItT/.../Opportunity_Zones/FeatureServer/13
 *   filtered to GEOID10 LIKE '42003%' (Allegheny County) → 68 tracts.
 *   Pulled 2026-06-13. See /public/opportunity_zones.geojson header fields.
 *
 * We bundle the tract POLYGONS and test each property's lat/long against them
 * with the same point-in-polygon code the neighborhood lookup uses. This is
 * the same bundled-GeoJSON pattern as condemned.js, just polygon-based instead
 * of keyed-by-parcel.
 *
 * Coverage: county-wide. A property whose coordinates fall outside every
 * designated tract returns inOpportunityZone:false (a real "no", not missing
 * data). Returns null only when coordinates are unknown or the file failed to
 * load — the valuation tool treats null as neutral.
 */

import { pointInFeature } from './pointInPolygon.js'

let _featuresPromise = null
let _features = null

/**
 * Load + cache the bundled QOZ polygons. Await once on view/enrichment entry,
 * then call getOpportunityZoneSync() freely.
 */
export function loadOpportunityZoneIndex() {
  if (_featuresPromise) return _featuresPromise
  const url = `${import.meta.env.BASE_URL}opportunity_zones.geojson`
  _featuresPromise = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`Failed to load opportunity_zones.geojson: ${r.status}`)
      return r.json()
    })
    .then(data => {
      _features = data?.features || []
      return _features
    })
    .catch(err => {
      _featuresPromise = null // allow retry
      throw err
    })
  return _featuresPromise
}

/**
 * Synchronous lookup by coordinates. Caller must have awaited
 * loadOpportunityZoneIndex() first.
 *
 * @returns {{ inOpportunityZone: boolean, ozTract: string|null } | null}
 *   - object when the index is loaded and coords are valid
 *   - null when coords are missing or the index hasn't loaded
 */
export function getOpportunityZoneSync(lat, lng) {
  if (!_features || lat == null || lng == null) return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  for (const feature of _features) {
    if (pointInFeature(lat, lng, feature)) {
      return { inOpportunityZone: true, ozTract: feature.properties?.geoid || null }
    }
  }
  return { inOpportunityZone: false, ozTract: null }
}

/** Async convenience: awaits the index, then does the sync lookup. */
export async function getOpportunityZone(lat, lng) {
  await loadOpportunityZoneIndex()
  return getOpportunityZoneSync(lat, lng)
}
