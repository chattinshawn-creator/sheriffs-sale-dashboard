/**
 * Sale-outcome classification.
 *
 * Allegheny County results PDFs encode what actually happened to a property
 * in the free-text `status` field using a specific vocabulary. This module
 * turns that raw text into a small, stable set of machine-readable categories
 * (`outcomeCategory`) the rest of the app can rely on, plus a couple of
 * helpers for pulling the sale price out of the status and mapping categories
 * back onto the Home view's coarse status buckets.
 *
 * Keep this module PURE (no imports, no side effects) so it stays trivially
 * unit-testable — see outcome.test.js.
 *
 * Status vocabulary (confirmed against a real June 2026 results file):
 *
 *   "Third Party - $X"              → an outside bidder bought it.  This is a
 *                                     TRUE MARKET PRICE.            → sold_third_party
 *   "PLTF Overbid - $X"             → plaintiff bid above its cost; the bank
 *                                     took it back.                 → plaintiff_overbid
 *   "PLTF Cost - $X" /
 *   "PLTF Cost & Tax - $X"          → went back to the plaintiff at cost.
 *                                                                   → plaintiff_cost
 *   "Money Made"                    → sold; proceeds exceeded the debt. Price
 *                                     shown only sometimes.         → money_made
 *   "Postponed to <date>" /
 *   "Postponed (Waived) to <date>" /
 *   "PP Generally"                  → rolled to a later sale.       → postponed
 *   "Stayed"                        → sale halted.                  → stayed
 *   anything else (incl. "Active")  →                               → other
 */

/** The full set of category strings stored on each history entry. */
export const OUTCOME_CATEGORIES = [
  'sold_third_party',
  'plaintiff_overbid',
  'plaintiff_cost',
  'money_made',
  'postponed',
  'stayed',
  'other',
]

/**
 * Categories that represent a property changing hands at a price. Per the
 * user's decision, all three are tracked but LABELED DISTINCTLY downstream:
 * a third-party sale is a real market price, while a plaintiff overbid/cost
 * is the lender taking the property back — very different meanings.
 */
export const SALE_CATEGORIES = new Set([
  'sold_third_party',
  'plaintiff_overbid',
  'plaintiff_cost',
])

/**
 * Human-friendly metadata for each category, for use in the Trends view and
 * anywhere else we surface the outcome to the user.
 *   label     — short display name
 *   isSale    — does this represent a sale carrying a price?
 *   isMarket  — is it a true outside-market price (vs. lender repossession)?
 */
export const OUTCOME_META = {
  sold_third_party:  { label: 'Third party',     isSale: true,  isMarket: true  },
  plaintiff_overbid: { label: 'Plaintiff overbid', isSale: true, isMarket: false },
  plaintiff_cost:    { label: 'Plaintiff cost',  isSale: true,  isMarket: false },
  money_made:        { label: 'Money made',      isSale: false, isMarket: false },
  postponed:         { label: 'Postponed',       isSale: false, isMarket: false },
  stayed:            { label: 'Stayed',          isSale: false, isMarket: false },
  other:             { label: 'Other',           isSale: false, isMarket: false },
}

/**
 * Classify a raw status string into one of OUTCOME_CATEGORIES.
 * Tolerant of case, leading/trailing whitespace, and the en/em dashes the
 * PDF sometimes uses instead of a hyphen.
 *
 * @param {string|null|undefined} status
 * @returns {string} one of OUTCOME_CATEGORIES
 */
export function deriveOutcomeCategory(status) {
  if (!status) return 'other'
  // Normalize: collapse whitespace, unify dash characters, lowercase.
  const s = String(status)
    .replace(/[‐-―]/g, '-') // various unicode dashes → hyphen
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  if (!s) return 'other'

  // Order matters: check the more specific "pltf cost" / "pltf overbid"
  // before any generic checks. "pltf cost & tax" is covered by the cost test.
  if (s.startsWith('third party')) return 'sold_third_party'
  if (s.startsWith('pltf overbid') || s.startsWith('plaintiff overbid')) return 'plaintiff_overbid'
  if (s.startsWith('pltf cost') || s.startsWith('plaintiff cost')) return 'plaintiff_cost'
  if (s.startsWith('money made')) return 'money_made'

  // Postponements: "postponed to ...", "postponed (waived) to ...",
  // "pp generally", or a bare "pp".
  if (s.startsWith('postponed') || s.startsWith('pp generally') || s === 'pp') return 'postponed'
  if (s.startsWith('stayed')) return 'stayed'

  return 'other'
}

/**
 * Pull the dollar amount out of a status string like "Third Party - $12,500"
 * or "PLTF Cost & Tax - $8,104.17". Returns a Number, or null if no amount
 * is present. Used as a belt-and-suspenders fallback for `soldFor` when the
 * parser didn't populate it directly.
 *
 * @param {string|null|undefined} status
 * @returns {number|null}
 */
export function parseStatusAmount(status) {
  if (!status) return null
  const m = String(status).match(/\$\s*([\d][\d,]*(?:\.\d+)?)/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Map an outcome category (plus the raw status as a fallback) onto the Home
 * view's four coarse buckets: 'active' | 'postponed' | 'stayed' | 'sold'.
 * Returns null when the status is unknown/blank.
 *
 * Backwards-compatible: history entries saved before outcomeCategory existed
 * pass `category === undefined`, in which case we fall back to classifying the
 * raw status text exactly the way Home used to.
 *
 * @param {string|undefined} category
 * @param {string|null|undefined} rawStatus
 * @returns {'active'|'postponed'|'stayed'|'sold'|null}
 */
export function statusBucketFor(category, rawStatus) {
  switch (category) {
    case 'sold_third_party':
    case 'plaintiff_overbid':
    case 'plaintiff_cost':
    case 'money_made':
      return 'sold'
    case 'postponed':
      return 'postponed'
    case 'stayed':
      return 'stayed'
    // 'other' or undefined → fall through to raw-status classification.
  }

  const s = String(rawStatus || '').toLowerCase()
  if (/^active/.test(s)) return 'active'
  if (/^postponed/.test(s)) return 'postponed'
  if (/^stayed/.test(s)) return 'stayed'
  if (/^sold/.test(s)) return 'sold'
  return null
}
