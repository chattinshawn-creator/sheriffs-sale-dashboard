/**
 * Ordering for a property's history[] entries — newest sale first.
 *
 * The non-obvious part is the tie-break WITHIN a single sale month. A property
 * can have two entries for the same month: the "before" listing (from the Sale
 * List PDF) and the "after" result (from the Results PDF). The entry at
 * history[0] is what the UI shows as the property's CURRENT status, so we must
 * not let a stale listing ("Postponed"/"Active") outrank the actual outcome
 * ("Sold").
 *
 * Rule: within the same month, a `listings` entry never outranks a non-listings
 * (results) entry. Upload time is the final tiebreaker.
 *
 * Robust to partial data: entries written before uploadType existed are treated
 * as non-listings (rank 0), so tagging just the listings side via a re-parse is
 * enough to push the result to the front.
 */
export function compareHistoryEntries(a, b) {
  const monthCmp = (b.saleMonth || '').localeCompare(a.saleMonth || '')
  if (monthCmp !== 0) return monthCmp

  const aListing = a.uploadType === 'listings' ? 1 : 0
  const bListing = b.uploadType === 'listings' ? 1 : 0
  if (aListing !== bListing) return aListing - bListing

  return (b.uploadedAt || 0) - (a.uploadedAt || 0)
}
