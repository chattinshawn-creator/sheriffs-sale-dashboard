import { stores, get, set } from '../storage/db.js'
import { normalizeParcelId } from './normalize.js'
import { fetchAllByFilter, PERMITS_RESOURCE_ID } from './wprdc.js'

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Fetch every PLI permit record for a parcel.
 * Coverage starts June 2019. Note: the permits dataset uses `parcel_num`
 * as its column name (the violations dataset uses `parcel_id` — same data,
 * different column).
 *
 * Returns the same envelope as getViolations().
 *
 * @param {string} rawParcelId
 * @param {{ force?: boolean }} [opts]
 */
export async function getPermits(rawParcelId, opts = {}) {
  const parid = normalizeParcelId(rawParcelId)
  if (!parid) return { status: 'normalize-failed' }

  if (!opts.force) {
    const cached = await get('permits:' + parid, stores.geoDataCache)
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
    records = await fetchAllByFilter(PERMITS_RESOURCE_ID, { parcel_num: parid })
  } catch (e) {
    return { status: 'error', parid, error: String(e?.message || e) }
  }

  const fetchedAt = Date.now()
  await set('permits:' + parid, { data: records, fetchedAt }, stores.geoDataCache)

  return { status: 'ok', parid, data: records, fetchedAt, fromCache: false }
}
