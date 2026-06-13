/**
 * Condemned / Dead End property lookup, sourced from Pittsburgh PLI's
 * condemned_dead_end_properties.geojson (kept in /public/).
 *
 * The GeoJSON is a list of point features keyed by `parcel_id` already in
 * the WPRDC 16-char PARID format. We build an in-memory Map<parid, records[]>
 * on first use and serve synchronous lookups after that.
 *
 * Some parcels have multiple inspection records (re-inspections over time).
 * `getCondemnedInfo` returns the most recent record plus the full list.
 *
 * Coverage: Pittsburgh only. Lookups against non-Pittsburgh parcels return
 * null — that's correct (not a missing-data signal).
 */

let _indexPromise = null

/**
 * Force the GeoJSON to load + index. Useful when you want to do synchronous
 * lookups later (call this once on view entry, await it, then call the
 * sync helper getCondemnedInfoSync everywhere else).
 */
export function loadCondemnedIndex() {
  if (_indexPromise) return _indexPromise
  const url = `${import.meta.env.BASE_URL}condemned_dead_end.geojson`
  _indexPromise = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`Failed to load condemned_dead_end.geojson: ${r.status}`)
      return r.json()
    })
    .then(data => {
      const idx = new Map()
      for (const feature of data?.features || []) {
        const parid = feature?.properties?.parcel_id
        if (!parid) continue
        if (!idx.has(parid)) idx.set(parid, [])
        idx.get(parid).push(feature.properties)
      }
      _index = idx
      return idx
    })
    .catch(err => {
      _indexPromise = null // allow retry
      throw err
    })
  return _indexPromise
}

// Synchronous accessor — only valid after loadCondemnedIndex() has resolved.
let _index = null

/**
 * Synchronous lookup. Returns the latest inspection record envelope, or
 * null if the parcel isn't in the dataset. The caller is responsible for
 * having awaited loadCondemnedIndex() at least once already.
 */
export function getCondemnedInfoSync(parcelId) {
  if (!_index || !parcelId) return null
  const records = _index.get(String(parcelId).trim())
  if (!records || records.length === 0) return null
  const sorted = [...records].sort((a, b) =>
    String(b.create_date || '').localeCompare(String(a.create_date || '')))
  const latest = sorted[0]
  return {
    parcelId: latest.parcel_id,
    address: latest.address,
    owner: latest.owner,
    propertyType: latest.property_type,
    inspectionStatus: latest.inspection_status,
    latestInspectionResult: latest.latest_inspection_result,
    latestInspectionScore: latest.latest_inspection_score,
    createDate: latest.create_date,
    neighborhood: latest.neighborhood,
    council: latest.council_district,
    ward: latest.ward,
    allInspections: sorted,
  }
}

/** Async convenience: awaits the index, then does the sync lookup. */
export async function getCondemnedInfo(parcelId) {
  await loadCondemnedIndex()
  return getCondemnedInfoSync(parcelId)
}

/**
 * Normalize a Sheriff-format parcel ID to the WPRDC PARID used in this
 * dataset. Re-uses the existing normalizer so the lookup works against
 * raw `prop.parcelId` from the parser.
 */
export async function isCondemnedByRawParcelId(rawParcelId) {
  if (!rawParcelId) return false
  const { normalizeParcelId } = await import('./normalize.js')
  const parid = normalizeParcelId(rawParcelId)
  if (!parid) return false
  return !!getCondemnedInfoSync(parid)
}

/** Sync version of isCondemnedByRawParcelId — caller must pass already-normalized parid. */
export function isCondemnedByParid(parid) {
  return !!getCondemnedInfoSync(parid)
}
