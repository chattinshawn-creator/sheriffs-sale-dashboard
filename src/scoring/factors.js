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
 *                  'size'        — composite of sqft/beds/baths, min-maxed per component
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
    hint: 'Closer to the ZIP or lat,long you enter scores higher.',
    kind: 'minmax',
    direction: 'low',
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
    hint: 'Bigger living area / more bedrooms & bathrooms scores higher.',
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
