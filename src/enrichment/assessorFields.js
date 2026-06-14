/**
 * Pure helpers for reading building-size fields off an Allegheny County
 * Property Assessments record (the SAME record getAssessor() already fetches
 * for fair-market-value / year-built — no extra network call).
 *
 * These exist only for residential parcels; commercial / vacant land have the
 * fields blank or zero, which we honestly report as null (not 0) so the
 * valuation tool can treat them as "unknown / neutral" rather than "tiny".
 *
 * Field names verified against the WPRDC data dictionary:
 *   FINISHEDLIVINGAREA → squareFeet
 *   BEDROOMS           → bedrooms
 *   FULLBATHS/HALFBATHS → bathrooms (combined, per Shawn: full + 0.5×half)
 */

/** Number > 0, else null. Treats blank/0/non-numeric as "not recorded". */
function posNumOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Number ≥ 0, else null (for half-baths, where 0 is a valid real count). */
function nonNegOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Combine full + half baths the MLS/Zillow way: 2 full + 1 half = 2.5.
 * Returns null when neither is recorded; returns null for a combined 0
 * (which means "not recorded", not "a house with zero bathrooms").
 *
 * @param {*} full - FULLBATHS
 * @param {*} half - HALFBATHS
 * @returns {number|null}
 */
export function combineBaths(full, half) {
  const f = nonNegOrNull(full)
  const h = nonNegOrNull(half)
  if (f == null && h == null) return null
  const combined = (f || 0) + 0.5 * (h || 0)
  return combined > 0 ? combined : null
}

/**
 * Pull the three size fields off a raw assessor record.
 * Also returns the raw full/half counts so nothing is lost.
 *
 * @param {object|null} record - the WPRDC assessor record
 * @returns {{ squareFeet, bedrooms, bathrooms, fullBaths, halfBaths }}
 */
export function extractSizeFields(record) {
  if (!record) {
    return { squareFeet: null, bedrooms: null, bathrooms: null, fullBaths: null, halfBaths: null }
  }
  return {
    squareFeet: posNumOrNull(record.FINISHEDLIVINGAREA),
    bedrooms: posNumOrNull(record.BEDROOMS),
    bathrooms: combineBaths(record.FULLBATHS, record.HALFBATHS),
    fullBaths: nonNegOrNull(record.FULLBATHS),
    halfBaths: nonNegOrNull(record.HALFBATHS),
  }
}
