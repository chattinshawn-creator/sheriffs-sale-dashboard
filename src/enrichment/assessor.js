import { stores, get, set } from '../storage/db.js'
import { normalizeParcelId } from './normalize.js'
import { fetchAssessorByParid } from './wprdc.js'

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Get the assessor record for a Sheriff-format parcel ID.
 * Returns an envelope describing where the data came from so the UI can
 * say "cached 3 days ago" vs "fetched just now."
 *
 * @param {string} rawParcelId - parcel ID as it appears in the Sheriff PDF
 * @param {{ force?: boolean }} [opts] - force=true bypasses the cache
 * @returns {Promise<{
 *   status: 'ok' | 'not-found' | 'normalize-failed' | 'error',
 *   parid?: string,           // normalized PARID (present when status !== 'normalize-failed')
 *   data?: object|null,       // the assessor record (when status === 'ok')
 *   fetchedAt?: number,       // epoch ms (when status === 'ok')
 *   fromCache?: boolean,      // true if served from IndexedDB (when status === 'ok')
 *   error?: string,           // human-readable (when status === 'error')
 * }>}
 */
export async function getAssessor(rawParcelId, opts = {}) {
  const parid = normalizeParcelId(rawParcelId)
  if (!parid) {
    return { status: 'normalize-failed' }
  }

  if (!opts.force) {
    const cached = await get(parid, stores.geoDataCache)
    if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) {
      return {
        status: cached.data ? 'ok' : 'not-found',
        parid,
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      }
    }
  }

  let record
  try {
    record = await fetchAssessorByParid(parid)
  } catch (e) {
    return {
      status: 'error',
      parid,
      error: String(e?.message || e),
    }
  }

  const fetchedAt = Date.now()
  await set(parid, { data: record, fetchedAt }, stores.geoDataCache)

  return {
    status: record ? 'ok' : 'not-found',
    parid,
    data: record,
    fetchedAt,
    fromCache: false,
  }
}

export { TTL_MS as ASSESSOR_CACHE_TTL_MS }
