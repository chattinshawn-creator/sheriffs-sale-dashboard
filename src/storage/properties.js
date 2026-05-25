/**
 * Canonical property shape (NOT YET POPULATED — designed here for the parser to fill in).
 *
 * Properties are keyed by `caseNumber` (e.g. "GD-16-022895"), which uniquely
 * identifies a case across multiple monthly sales. When the same case appears
 * in a future month's listing, we update its `history` array rather than
 * creating a new record. That way Shawn's notes/flags/maxBid follow the
 * property across months.
 *
 * Field-level "data unavailable" treatment: when an enrichment source can't
 * answer (e.g., code violations outside Pittsburgh proper), the field stays
 * present with value `null` and a parallel `_meta` entry records WHY it's
 * missing — "outside-pittsburgh" vs "lookup-failed" vs "not-yet-fetched".
 * The UI can then grey it out and show a tooltip explaining the reason.
 *
 * {
 *   caseNumber:        string                       // "GD-16-022895" (primary key)
 *   saleNumber:        string                       // "12JUL17" (Sheriff's internal ID)
 *   parcelId:          string                       // "556-G-276"
 *   address:           string                       // "605 SCENE RIDGE ROAD, MCKEESPORT, PA 15133"
 *   municipality:      string                       // "Liberty"
 *   isPittsburghProper:boolean                      // true only if municipality === "Pittsburgh"
 *   tracts:            number                       // 1 (or 2+ for multi-address cases)
 *   addresses:         Array<{address, parcelId}>   // present when tracts > 1
 *   plaintiff:         string
 *   plaintiffAttorney: string
 *   defendant:         string
 *   saleType:          string                       // "Real Estate Sale - Sci Fa Sur Tax Lien"
 *   openingBid:        number                       // 56872.30 (the "Cost & Tax Bid" amount)
 *   serviceFlags:      string                       // "XX" / "X" / "XXX"
 *   commentsRaw:       string                       // full free-text Comments block
 *   commentsParsed:    {                            // signals extracted from comments
 *     postponementHistory: string[],
 *     bankruptcyHistory:   string[],
 *     replenishmentUnpaid: boolean,
 *     stayedNotes:         string[],
 *     soldNotes:           string[],
 *   }
 *
 *   // One entry per monthly listing/result this case appeared in.
 *   history: Array<{
 *     saleMonth:  string,                           // "2026-05"
 *     uploadId:   string,                           // reference back to uploads store
 *     status:     string,                           // "Postponed to 7/6/2026" / "Stayed" / "Active" / "Sold"
 *     openingBid: number,
 *     soldFor:    number | null,                    // sale price IF status was "Sold"
 *     soldTo:     string | null,                    // purchaser IF status was "Sold"
 *   }>
 *
 *   // Future enrichment fields — designed now so the shape doesn't change.
 *   enrichment: {
 *     assessor:      object | null,
 *     liens:         array  | null,
 *     codeViolations:array  | null,
 *     condemnation:  object | null,
 *     // ... others added later
 *   }
 *
 *   // Per-field reason an enrichment value is missing.
 *   // Example: { codeViolations: 'outside-pittsburgh' }
 *   _meta: Record<string, 'outside-pittsburgh' | 'lookup-failed' | 'not-yet-fetched'>
 *
 *   // User-supplied fields — preserved across sales (live with the canonical
 *   // property, NOT with a specific monthly upload).
 *   userFields: {
 *     arvOverride: number | null,
 *     maxBid:      number | null,
 *     flag:        'interested' | 'skip' | null,
 *     notes:       string,
 *   }
 * }
 */

export function emptyProperty(caseNumber) {
  return {
    caseNumber,
    saleNumber: null,
    parcelId: null,
    address: null,
    municipality: null,
    isPittsburghProper: false,
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
    history: [],
    enrichment: {
      assessor: null,
      liens: null,
      codeViolations: null,
      condemnation: null,
    },
    _meta: {},
    userFields: {
      arvOverride: null,
      maxBid: null,
      flag: null,
      notes: '',
    },
  }
}

// TODO: parser lands in the next prompt and will use these helpers.
// import { stores, get, set, values } from './db.js'
// export async function upsertProperty(parsed, { uploadId, saleMonth }) { ... }
// export async function listProperties() { ... }
