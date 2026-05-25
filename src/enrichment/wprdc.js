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

// Resource ID for the Allegheny County Property Assessments API-version table.
// If this dataset is ever republished under a new resource ID, update here.
// You can find the current ID at:
//   https://data.wprdc.org/dataset/property-assessments
// → "Property Assessments Parcel Data (API version)" → API endpoint → resource_id
export const ASSESSOR_RESOURCE_ID = '65855e14-549e-4992-b5be-d629afc676fa'

const API_BASE = 'https://data.wprdc.org/api/3/action'

/**
 * Fetch one assessor record by normalized PARID.
 * @param {string} parid - normalized 16-char WPRDC PARID
 * @returns {Promise<object|null>} the record, or null if not found
 */
export async function fetchAssessorByParid(parid) {
  if (!parid) throw new Error('fetchAssessorByParid: parid is required')

  const filters = encodeURIComponent(JSON.stringify({ PARID: parid }))
  const url = `${API_BASE}/datastore_search?resource_id=${ASSESSOR_RESOURCE_ID}&filters=${filters}&limit=1`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`WPRDC API ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  if (!data.success) {
    throw new Error('WPRDC API returned success: false — ' + JSON.stringify(data.error || {}))
  }
  const records = data.result?.records || []
  return records[0] || null
}
