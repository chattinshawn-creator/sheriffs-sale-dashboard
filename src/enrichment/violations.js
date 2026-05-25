import { stores, get, set } from '../storage/db.js'
import { normalizeParcelId } from './normalize.js'
import { fetchAllByFilter, VIOLATIONS_RESOURCE_ID } from './wprdc.js'

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Fetch every PLI/DOMI/ES violation record for a parcel.
 * Coverage starts June 2020 (per the WPRDC dataset). Older violations
 * exist in a separate historical resource we don't query here.
 *
 * Returns the same envelope shape as getAssessor() for UI consistency.
 * `data` is an ARRAY of violation records (possibly empty).
 *
 * @param {string} rawParcelId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{
 *   status: 'ok' | 'normalize-failed' | 'error',
 *   parid?: string,
 *   data?: object[],
 *   fetchedAt?: number,
 *   fromCache?: boolean,
 *   error?: string,
 * }>}
 */
export async function getViolations(rawParcelId, opts = {}) {
  const parid = normalizeParcelId(rawParcelId)
  if (!parid) return { status: 'normalize-failed' }

  if (!opts.force) {
    const cached = await get('violations:' + parid, stores.geoDataCache)
    if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) {
      return {
        status: 'ok',
        parid,
        data: cached.data || [],
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      }
    }
  }

  let records
  try {
    records = await fetchAllByFilter(VIOLATIONS_RESOURCE_ID, { parcel_id: parid })
  } catch (e) {
    return { status: 'error', parid, error: String(e?.message || e) }
  }

  const fetchedAt = Date.now()
  await set('violations:' + parid, { data: records, fetchedAt }, stores.geoDataCache)

  return { status: 'ok', parid, data: records, fetchedAt, fromCache: false }
}
