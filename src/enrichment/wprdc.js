/**
 * Thin browser-direct wrapper around the WPRDC CKAN datastore_search API.
 *
 * WPRDC = Western Pennsylvania Regional Data Center. Free, no API key, CORS
 * allows browser-direct requests.
 *
 * Docs: https://data.wprdc.org/api/3/
 * Allegheny County Property Assessments dataset:
 *   https://data.wprdc.org/dataset/property-assessments
 */

// Resource IDs for the WPRDC datasets we query. Update here if any are
// republished under new IDs (find current IDs on each dataset's page at
// https://data.wprdc.org/).

// Allegheny County Property Assessments (parcel-level, all county)
export const ASSESSOR_RESOURCE_ID = '65855e14-549e-4992-b5be-d629afc676fa'

// Pittsburgh PLI/DOMI/ES Violations Report (current, June 2020+)
export const VIOLATIONS_RESOURCE_ID = '70c06278-92c5-4040-ab28-17671866f81c'

// Pittsburgh PLI Permits (current, June 2019+)
export const PERMITS_RESOURCE_ID = 'f4d1177a-f597-4c32-8cbf-7885f56253f6'

const API_BASE = 'https://data.wprdc.org/api/3/action'

/**
 * Fetch one assessor record by normalized PARID.
 */
export async function fetchAssessorByParid(parid) {
  if (!parid) throw new Error('fetchAssessorByParid: parid is required')
  const records = await fetchAllByFilter(ASSESSOR_RESOURCE_ID, { PARID: parid }, { limit: 1 })
  return records[0] || null
}

/**
 * Generic CKAN datastore_search wrapper: fetch all records matching an
 * exact-value filter on one or more columns. Used by violations and permits,
 * which return many records per parcel.
 *
 * @param {string} resourceId
 * @param {Record<string, string>} filterObj  e.g. { parcel_id: '0033K00240000000' }
 * @param {{ limit?: number }} [opts] - default limit 100 (enough for nearly all parcels)
 * @returns {Promise<object[]>}
 */
export async function fetchAllByFilter(resourceId, filterObj, opts = {}) {
  const limit = opts.limit ?? 100
  const filters = encodeURIComponent(JSON.stringify(filterObj))
  const url = `${API_BASE}/datastore_search?resource_id=${resourceId}&filters=${filters}&limit=${limit}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`WPRDC API ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  if (!data.success) {
    throw new Error('WPRDC API returned success: false — ' + JSON.stringify(data.error || {}))
  }
  return data.result?.records || []
}
