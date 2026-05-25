/**
 * Format / sanity checks on a parsed property record.
 *
 * Goal: catch the kinds of errors we've seen in real parses — bad case
 * numbers, mangled parcel IDs, opening bids that lost digits, column-shift
 * errors where values from adjacent cells got swapped.
 *
 * This is purely a CLIENT-SIDE check (no API calls). The orchestrator
 * uses the issue list to decide whether to fire a follow-up repair call.
 *
 * Returns { ok: boolean, issues: string[] }.
 */

// Case # format: 2-letter prefix + YY + NNNNNN. The prefix varies by case
// type: GD = General Docket (tax sales, civil), MG = Mortgage (foreclosures),
// AR = Arbitration, etc. Allow any 2-letter prefix rather than locking to GD.
const CASE_RE = /^[A-Z]{2}-\d{2}-\d{6}$/i

// Parcel ID format: 1-4 digits, hyphen-or-not, ONE letter, hyphen-or-not,
// 1-5 digits, optional 4th hyphen-segment of 1-6 digits.
const PARCEL_RE = /^\d{1,4}-?[A-Z]-?\d{1,5}(?:-?\d{1,6})?$/i

// Patterns that STRONGLY indicate a law-firm name (i.e. the value was
// column-shifted from the attorney cell). Excludes LLC/LLP on their own
// because mortgage servicers and banks legitimately use those suffixes
// when serving as plaintiffs in foreclosure cases (e.g. "Nationstar
// Mortgage LLC", "Specialized Loan Servicing LLC").
const ATTORNEY_PATTERNS = [
  /\bESQ\.?\b/i,
  /\bP\.?C\.?\b/i,
  /\bLAW GROUP\b/i,
  /\bLEGAL GROUP\b/i,
  /\bLEGAL TAX SERVICE\b/i,
  /\b& MAIELLO\b/i,
  /\bGOEHRING RUTTER\b/i,
  /\b& BOEHM\b/i,
  /\bKRATZENBERG\b/i,
  /\bANDREWS & PRICE\b/i,
  /\bMAURICE A NERNBERG\b/i,
  /\bLOGS LEGAL\b/i,
  /\bATTORNEY/i,
]

// Patterns that indicate a legitimate plaintiff entity (bank, servicer,
// municipal body, school district). Used as an OVERRIDE when the attorney
// heuristic might fire incorrectly — if the value looks like one of these,
// don't flag it.
const LEGITIMATE_PLAINTIFF_PATTERNS = [
  /\bBANK\b/i,
  /\bMORTGAGE\b/i,
  /\bSERVICING\b/i,
  /\bSCHOOL DISTRICT\b/i,
  /\bBOROUGH\b/i,
  /\bTOWNSHIP\b/i,
  /\bAUTHORITY\b/i,
  /\bMUNICIPALITY\b/i,
  /\bCITY OF\b/i,
  /\bCOUNTY\b/i,
  /\bTREASURER\b/i,
  /\bN\.?A\.?\b/i,              // "Bank, N.A." = National Association
  /\bNATIONAL ASSOCIATION\b/i,
  /\bTRUST\b/i,
  /\bFEDERAL\b/i,
  /\bHOMEOWNERS ASSOCIATION\b/i,
]

// Real Sheriff sale opening bids are rarely below $500. Anything lower is
// likely a truncation error (e.g., "$8,104.17" parsed as "$94.17").
const MIN_REASONABLE_BID = 500

export function validateProperty(p) {
  const issues = []

  if (!p.caseNumber || !CASE_RE.test(String(p.caseNumber).trim())) {
    issues.push(`caseNumber "${p.caseNumber}" doesn't match expected GD-YY-NNNNNN format`)
  }

  if (!p.parcelId) {
    issues.push('parcelId is missing')
  } else {
    const stripped = String(p.parcelId)
      .replace(/^\s*(?:parcel(?:\s*\/\s*tax)?\s*(?:id|#|number)?|parid)\s*:?\s*/i, '')
      .trim()
    if (!PARCEL_RE.test(stripped)) {
      issues.push(`parcelId "${p.parcelId}" doesn't match expected DDDD-L-DDDDD format`)
    }
  }

  if (p.openingBid == null || !Number.isFinite(Number(p.openingBid)) || Number(p.openingBid) <= 0) {
    issues.push(`openingBid "${p.openingBid}" is missing or non-positive`)
  } else if (Number(p.openingBid) < MIN_REASONABLE_BID) {
    issues.push(`openingBid $${p.openingBid} is suspiciously low — may be truncated`)
  }

  if (!p.plaintiff || String(p.plaintiff).trim().length < 3) {
    issues.push('plaintiff missing or too short')
  } else if (
    ATTORNEY_PATTERNS.some(re => re.test(p.plaintiff)) &&
    !LEGITIMATE_PLAINTIFF_PATTERNS.some(re => re.test(p.plaintiff))
  ) {
    // Only flag if it matches attorney patterns AND doesn't also match
    // legitimate-plaintiff patterns (banks, servicers, school districts,
    // etc.). Prevents false positives on names like "Nationstar Mortgage LLC".
    issues.push(`plaintiff "${p.plaintiff}" looks like an attorney name — possible column-shift with the attorney field`)
  }

  if (!p.defendant || String(p.defendant).trim().length < 3) {
    issues.push('defendant missing or too short')
  }

  if (!p.plaintiffAttorney || String(p.plaintiffAttorney).trim().length < 3) {
    issues.push('plaintiffAttorney missing or too short')
  }

  if (!p.address || String(p.address).trim().length < 5) {
    issues.push('address missing or too short')
  }

  if (!p.municipality || String(p.municipality).trim().length < 2) {
    issues.push('municipality missing')
  }

  if (!p.saleType || String(p.saleType).trim().length < 3) {
    issues.push('saleType missing')
  }

  return { ok: issues.length === 0, issues }
}
