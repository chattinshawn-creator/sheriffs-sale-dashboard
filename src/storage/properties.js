import { stores, get, set, values } from './db.js'

/**
 * Canonical property shape. Keyed by `caseNumber` (e.g. "GD-16-022895"),
 * which uniquely identifies a case across multiple monthly sales.
 *
 * Field categories:
 *   - Parser-produced: filled by src/pdf/parse.js from the Sheriff's PDF
 *   - App-derived: computed from the parsed fields (e.g. isPittsburghProper)
 *   - Per-sale history: one entry per monthly upload this case appeared in
 *   - Enrichment: populated by later prompts (WPRDC, assessor, etc.)
 *   - User-supplied: ARV override, max bid, flag, notes — preserved across
 *     re-parses and across months, because they live on the canonical
 *     property, not on a specific upload
 *
 * For per-field "data unavailable" treatment in the UI, `_meta` records the
 * REASON an enrichment value is null:
 *   'outside-pittsburgh' | 'lookup-failed' | 'not-yet-fetched'
 */
export function emptyProperty(caseNumber) {
  return {
    // Parser-produced
    caseNumber,
    saleNumber: null,
    parcelId: null,
    address: null,
    municipality: null,
    tracts: 1,
    addresses: [],
    plaintiff: null,
    plaintiffAttorney: null,
    defendant: null,
    saleType: null,
    openingBid: null,
    serviceFlags: null,
    commentsRaw: '',
    commentsParsed: {
      postponementHistory: [],
      bankruptcyHistory: [],
      replenishmentUnpaid: false,
      stayedNotes: [],
      soldNotes: [],
    },

    // App-derived
    isPittsburghProper: false,

    // Denormalized enrichment summary — populated by bulk enrichment so
    // Home can filter/badge without reading geoDataCache for each property.
    // Full enrichment data still lives in geoDataCache; this is a fast-access
    // subset of the fields we need for triage.
    enrichmentSummary: {
      neighborhood: null,    // human-readable Pittsburgh neighborhood name
      ward: null,            // City ward (parsed from MUNIDESC)
      fairMarketValue: null, // WPRDC FAIRMARKETTOTAL
      yearBuilt: null,       // WPRDC YEARBLT
      latitude: null,        // for the map view
      longitude: null,
    },

    // Per-sale history (one entry per monthly upload)
    history: [],

    // Enrichment (populated later)
    enrichment: {
      assessor: null,
      liens: null,
      codeViolations: null,
      condemnation: null,
    },
    _meta: {},

    // User-supplied
    userFields: {
      arvOverride: null,
      maxBid: null,
      flag: null,
      notes: '',
    },
  }
}

/**
 * Fields the parser produces. Used to merge parsed output into an existing
 * canonical record without clobbering app-managed fields.
 */
const PARSER_FIELDS = [
  'saleNumber', 'parcelId', 'address', 'municipality', 'tracts', 'addresses',
  'plaintiff', 'plaintiffAttorney', 'defendant', 'saleType', 'openingBid',
  'serviceFlags', 'commentsRaw', 'commentsParsed',
  // Validation result — stamped by the parser, surfaced as a badge in the UI.
  '_validation',
]

/**
 * Insert or update a property from a parsed record.
 *
 * Behavior:
 *   - New caseNumber → create a fresh property from emptyProperty(),
 *     populate parser fields, set first history entry.
 *   - Existing caseNumber → append/replace this upload's history entry.
 *     If this upload is the MOST RECENT sale month for the property, also
 *     refresh the top-level parser fields (since values can drift over time
 *     as the case advances). userFields is ALWAYS preserved.
 *
 * @param {object} parsed - one entry from the parser's output
 * @param {{uploadId: string, saleMonth: string}} ctx
 */
export async function upsertProperty(parsed, { uploadId, saleMonth }) {
  if (!parsed.caseNumber) {
    throw new Error('upsertProperty: parsed record has no caseNumber')
  }

  const existing = await get(parsed.caseNumber, stores.properties)

  const newHistoryEntry = {
    saleMonth,
    uploadId,
    status: parsed.status ?? null,
    openingBid: parsed.openingBid ?? null,
    soldFor: parsed.soldFor ?? null,
    soldTo: parsed.soldTo ?? null,
  }

  if (!existing) {
    const fresh = emptyProperty(parsed.caseNumber)
    for (const k of PARSER_FIELDS) {
      if (parsed[k] !== undefined) fresh[k] = parsed[k]
    }
    fresh.isPittsburghProper = (parsed.municipality || '').toLowerCase() === 'pittsburgh'
    fresh.history = [newHistoryEntry]
    await set(parsed.caseNumber, fresh, stores.properties)
    return fresh
  }

  // Replace any existing entry for this same upload (re-parse case), then
  // sort descending by saleMonth.
  const otherHistory = existing.history.filter(h => h.uploadId !== uploadId)
  const newHistory = [...otherHistory, newHistoryEntry]
    .sort((a, b) => (b.saleMonth || '').localeCompare(a.saleMonth || ''))

  const isMostRecent = newHistory[0].uploadId === uploadId

  const merged = { ...existing, history: newHistory }
  if (isMostRecent) {
    for (const k of PARSER_FIELDS) {
      if (parsed[k] !== undefined) merged[k] = parsed[k]
    }
    merged.isPittsburghProper =
      (parsed.municipality || '').toLowerCase() === 'pittsburgh'
  }
  // Always preserve userFields from existing.
  merged.userFields = existing.userFields

  await set(parsed.caseNumber, merged, stores.properties)
  return merged
}

/**
 * All canonical properties, sorted by most-recent-sale-month descending,
 * then case number for stability.
 */
export async function listProperties() {
  const all = await values(stores.properties)
  return all.sort((a, b) => {
    const am = a.history[0]?.saleMonth || ''
    const bm = b.history[0]?.saleMonth || ''
    if (bm !== am) return bm.localeCompare(am)
    return a.caseNumber.localeCompare(b.caseNumber)
  })
}

export async function countProperties() {
  return (await values(stores.properties)).length
}

export async function getProperty(caseNumber) {
  return get(caseNumber, stores.properties)
}

/**
 * Merge enrichment-summary fields into an existing property record.
 * Used by bulk enrichment to denormalize WPRDC values (neighborhood,
 * ward, fair market value, year built) onto the property so Home can
 * filter/badge without reading geoDataCache for each property.
 *
 * No-op if the property doesn't exist.
 */
export async function setEnrichmentSummary(caseNumber, partial) {
  const existing = await get(caseNumber, stores.properties)
  if (!existing) return null
  const merged = {
    ...existing,
    enrichmentSummary: {
      ...(existing.enrichmentSummary || {}),
      ...partial,
    },
  }
  await set(caseNumber, merged, stores.properties)
  return merged
}

/**
 * Merge user-supplied fields into an existing property record. Only the
 * keys passed in `partial` are touched; everything else stays as-is.
 *
 * Allowed keys: arvOverride, maxBid, flag, notes.
 * No-op if the property doesn't exist (the user wouldn't have a page open
 * for a property that hasn't been parsed).
 */
export async function updateUserFields(caseNumber, partial) {
  const existing = await get(caseNumber, stores.properties)
  if (!existing) return null
  const merged = {
    ...existing,
    userFields: { ...existing.userFields, ...partial },
  }
  await set(caseNumber, merged, stores.properties)
  return merged
}
