/**
 * The eight valuation factors — pure definitions, no DOM / no storage.
 *
 * Each factor declares:
 *   key        — stable id used in weights, presets, CSV, breakdown
 *   label      — plain-English UI label (no jargon)
 *   hint       — one-line "what makes this score high" for tooltips
 *   kind       — how the raw value becomes a 0-100 sub-score:
 *                  'minmax'      — scaled relative to the month's set (see direction)
 *                  'boolean'     — true=100, false=0
 *                  'categorical' — getRaw returns the 0-100 score directly
 *                  'size'        — FIXED diminishing-returns curve vs. an ideal
 *                                  rental (NOT month-relative); see sizeSubScore
 *                  'distance'    — FIXED diminishing-returns curve on miles from
 *                                  the reference point (NOT month-relative); see
 *                                  distanceSubScore
 *   direction  — for 'minmax' only: 'high' (bigger raw = higher score) or
 *                'low' (smaller raw = higher score)
 *   getRaw(prop, ctx) — pull the raw value from the canonical property. Returns
 *                a Number, a boolean, an object (size), or null when the datum
 *                is unavailable (null => neutral 50, flagged "estimated").
 *
 * `ctx` carries values the view computes once and passes in:
 *   ctx.refPoint           — { lat, lng } | null   (distance reference)
 *   ctx.valueMedians       — { byNeighborhood: Map, byMunicipality: Map }
 *
 * Keeping these as data (not hard-coded into the engine) means the slider
 * panel, the breakdown, and the CSV all iterate the SAME list, and adding a
 * factor later is a one-entry change.
 */
import { caseCategory } from '../pdf/classify.js'

/** Cap on the price deal-ratio (V/C) before normalizing, so one absurd ratio
 *  doesn't flatten every other property to ~0. 10x value-to-cost is already a
 *  spectacular deal; anything beyond is treated as equally spectacular. */
export const PRICE_RATIO_CAP = 10

/** Effective opening bid floor. Ratios use this to avoid divide-by-zero / wild
 *  ratios from token $1 opening bids. */
const MIN_COST = 1

export const FACTORS = [
  {
    key: 'distance',
    label: 'Distance to your reference point',
    hint: 'Closer to the ZIP or lat,long you enter scores higher; the first ~2 miles matter most, then it flattens fast.',
    kind: 'distance',
    getRaw: (p, ctx) => {
      const ref = ctx?.refPoint
      const lat = p.enrichmentSummary?.latitude
      const lng = p.enrichmentSummary?.longitude
      if (!ref || !isNum(lat) || !isNum(lng)) return null
      return haversineMiles(lat, lng, ref.lat, ref.lng)
    },
  },
  {
    key: 'price',
    label: 'Deal quality (value vs. cost)',
    hint: 'Higher estimated value relative to the opening bid scores higher.',
    kind: 'minmax',
    direction: 'high',
    getRaw: (p, ctx) => {
      const cost = p.history?.[0]?.openingBid
      const value = estimatedValue(p, ctx)
      if (!isNum(value) || !isNum(cost) || cost <= 0) return null
      const ratio = value / Math.max(cost, MIN_COST)
      return Math.min(ratio, PRICE_RATIO_CAP)
    },
  },
  {
    key: 'risk',
    label: 'Low code-violation risk',
    hint: 'Fewer open/recent code violations scores higher. Pittsburgh only.',
    kind: 'minmax',
    direction: 'low',
    getRaw: (p) => {
      const cv = p.enrichmentSummary?.codeViolations
      if (cv == null || typeof cv !== 'object') return null
      // headline = open OR recent (the enrichment "risk" count). Fall back to
      // total only if headline is somehow absent on older records.
      return isNum(cv.headline) ? cv.headline : (isNum(cv.total) ? cv.total : null)
    },
  },
  {
    key: 'postponement',
    label: 'Fresh (few postponements)',
    hint: 'A new listing scores higher than one cycling for years.',
    kind: 'minmax',
    direction: 'low',
    getRaw: (p) => postponementCount(p),
  },
  {
    key: 'lienType',
    label: 'Lien type (tax/other over mortgage)',
    hint: 'Tax/municipal/other liens score high; bank mortgage foreclosures score low.',
    kind: 'categorical',
    getRaw: (p) => {
      const cat = caseCategory(p.caseNumber) // 'mortgage' | 'tax_other' | null
      if (cat === 'tax_other') return 100
      if (cat === 'mortgage') return 0
      return null // unclassifiable -> neutral 50, flagged
    },
  },
  {
    key: 'opportunityZone',
    label: 'Inside an Opportunity Zone',
    hint: 'Inside a federal Opportunity Zone scores 100, outside scores 0.',
    kind: 'boolean',
    getRaw: (p) => {
      const v = p.enrichmentSummary?.inOpportunityZone
      return v == null ? null : !!v
    },
  },
  {
    key: 'income',
    label: 'ZIP median income',
    hint: 'Higher median household income for the ZIP scores higher.',
    kind: 'minmax',
    direction: 'high',
    getRaw: (p) => {
      const v = p.enrichmentSummary?.zipMedianIncome
      return isNum(v) ? v : null
    },
  },
  {
    key: 'size',
    label: 'Size (sq ft, beds, baths)',
    hint: 'Reaching a good rental size (4 bd / 4 ba / 3,500 sq ft) scores high; bigger adds little more.',
    kind: 'size',
    getRaw: (p) => {
      const s = p.enrichmentSummary || {}
      const sqft = isNum(s.squareFeet) ? s.squareFeet : null
      const beds = isNum(s.bedrooms) ? s.bedrooms : null
      const baths = isNum(s.bathrooms) ? s.bathrooms : null
      if (sqft == null && beds == null && baths == null) return null
      return { sqft, beds, baths }
    },
  },
]

/** Lookup a factor definition by key. */
export const FACTOR_BY_KEY = Object.fromEntries(FACTORS.map(f => [f.key, f]))

// ── Shared helpers (exported so the engine + tests can reuse them) ───────────

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Estimated property value V for the price factor, first available of:
 *   1. county fair-market value (enrichmentSummary.fairMarketValue)
 *   2. the neighborhood (Pittsburgh) or municipality median SALE price
 *   3. the user's ARV override (userFields.arvOverride)
 * Returns null when none is known.
 */
export function estimatedValue(p, ctx) {
  const fmv = p.enrichmentSummary?.fairMarketValue
  if (isNum(fmv) && fmv > 0) return fmv

  const medians = ctx?.valueMedians
  if (medians) {
    const nh = p.enrichmentSummary?.neighborhood
    if (p.isPittsburghProper && nh && medians.byNeighborhood?.get(nh) != null) {
      return medians.byNeighborhood.get(nh)
    }
    const muni = p.municipality
    if (muni && medians.byMunicipality?.get(muni) != null) {
      return medians.byMunicipality.get(muni)
    }
  }

  const arv = p.userFields?.arvOverride
  if (isNum(arv) && arv > 0) return arv
  return null
}

/** Which value source the price factor actually used — for the breakdown UI. */
export function valueSourceLabel(p, ctx) {
  const fmv = p.enrichmentSummary?.fairMarketValue
  if (isNum(fmv) && fmv > 0) return 'county fair-market value'
  const medians = ctx?.valueMedians
  if (medians) {
    const nh = p.enrichmentSummary?.neighborhood
    if (p.isPittsburghProper && nh && medians.byNeighborhood?.get(nh) != null) {
      return 'neighborhood median sale price'
    }
    const muni = p.municipality
    if (muni && medians.byMunicipality?.get(muni) != null) {
      return 'municipality median sale price'
    }
  }
  const arv = p.userFields?.arvOverride
  if (isNum(arv) && arv > 0) return 'your ARV override'
  return null
}

/**
 * How many times this case has been postponed. Uses the parsed postponement
 * chain when present, else counts history entries that resolved to 'postponed'.
 * Always a number (0 when none) — a fresh listing is a real 0, not missing data.
 */
export function postponementCount(p) {
  const chain = p.commentsParsed?.postponementHistory?.length || 0
  const fromHistory = (p.history || []).filter(h => h.outcomeCategory === 'postponed').length
  return Math.max(chain, fromHistory)
}

/** Great-circle distance in miles. */
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613 // Earth radius, miles
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ── Size: fixed diminishing-returns curve (NOT month-relative) ───────────────
//
// Min-max scaling let one giant commercial parcel grab the "100" slot, pushing
// an ideal rental (4 bd / 4 ba / 3,500 sq ft) down into the 60s. Instead we
// score size on a fixed curve: rewards reaching a good-rental size, gives little
// extra for exceeding it, and has a floor so tiny units don't bottom out at 0.

/** Ideal-rental target every size ratio is measured against. */
export const SIZE_TARGET = { beds: 4, baths: 4, sqft: 3500 }

/** No single dimension beyond 1.5× the ideal adds anything — this is what stops
 *  a big warehouse from dominating on square footage alone. */
export const SIZE_RATIO_CAP = 1.5

/** Anchor points mapping sizeIndex → 0-100 sub-score (linearly interpolated,
 *  clamped at both ends). Calibrated to real examples: 2/1/750 ≈ 10,
 *  3/1/1250 ≈ 40 (below average), 4/4/3500 ≈ 90, larger climbs gently to 100. */
export const SIZE_ANCHORS = [
  { x: 0.25, y: 0 },
  { x: 0.321, y: 10 },
  { x: 0.452, y: 40 },
  { x: 1.00, y: 90 },
  { x: 1.50, y: 100 },
]

/** Piecewise-linear interpolation through ascending (x,y) anchors. Values below
 *  the first anchor clamp to its y; above the last clamp to its y. */
export function interpolateAnchors(x, anchors) {
  if (x <= anchors[0].x) return anchors[0].y
  const last = anchors[anchors.length - 1]
  if (x >= last.x) return last.y
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]
    const b = anchors[i]
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x)
      return a.y + t * (b.y - a.y)
    }
  }
  return last.y
}

/**
 * Size sub-score (0-100) on the fixed curve. Steps:
 *   1. ratios vs. the ideal rental, each capped at 1.5×:
 *        bedRatio = beds/4, bathRatio = baths/4, sqftRatio = sqft/3500
 *   2. sizeIndex = mean of the three (equal thirds). A MISSING component counts
 *      as 0, not dropped — a parcel with finished area but no bedrooms is
 *      non-residential and should land low (a warehouse mustn't ride sqft alone
 *      to the top). Returns null only when sqft, beds AND baths are all absent,
 *      so the engine flags it "estimated / no data" → neutral 50.
 *   3. map sizeIndex through SIZE_ANCHORS.
 *
 * @param {{sqft:?number, beds:?number, baths:?number}|null} raw
 * @returns {number|null}
 */
export function sizeSubScore(raw) {
  if (!raw) return null
  const { sqft, beds, baths } = raw
  if (sqft == null && beds == null && baths == null) return null
  const ratio = (val, target) => (isNum(val) ? Math.min(val / target, SIZE_RATIO_CAP) : 0)
  const sizeIndex = (
    ratio(beds, SIZE_TARGET.beds) +
    ratio(baths, SIZE_TARGET.baths) +
    ratio(sqft, SIZE_TARGET.sqft)
  ) / 3
  return interpolateAnchors(sizeIndex, SIZE_ANCHORS)
}

// ── Distance: fixed diminishing-returns curve (NOT month-relative) ───────────
//
// Distance to YOUR reference point is an absolute quality of a property, so it
// shouldn't be scaled against whatever else happens to be on the docket that
// month (the old min-max behavior). It rides a fixed curve instead.
//
// Each additional mile costs less score than the one before — and the drop-off
// accelerates after ~2 miles. The first two miles are steep (≈20 pts/mi), so the
// 1→2 mi gap is large; past 2 miles the per-mile penalty shrinks quickly, so the
// 4→5 mi gap is small. Anything beyond 25 miles bottoms out at 0.
//
//   mi:    0    1    2    3    4    5    7    10   15   25+
//   score: 100  80   60   47   38   32   24   16   8    0
//   Δ/mi:   20   20   13    9    6  …4   …2.7 …1.6  …0.8
export const DISTANCE_ANCHORS = [
  { x: 0, y: 100 },
  { x: 1, y: 80 },
  { x: 2, y: 60 },
  { x: 3, y: 47 },
  { x: 4, y: 38 },
  { x: 5, y: 32 },
  { x: 7, y: 24 },
  { x: 10, y: 16 },
  { x: 15, y: 8 },
  { x: 25, y: 0 },
]

/**
 * Distance sub-score (0-100) on the fixed curve above. `miles` is the
 * great-circle distance to the reference point (haversineMiles). Returns null
 * when distance is unavailable (no reference point or no coordinates) so the
 * engine flags it "estimated" → neutral 50.
 *
 * @param {number|null} miles
 * @returns {number|null}
 */
export function distanceSubScore(miles) {
  if (!isNum(miles)) return null
  return interpolateAnchors(Math.max(0, miles), DISTANCE_ANCHORS)
}
