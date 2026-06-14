/**
 * The weighted 1-100 valuation engine. Pure — no DOM, no storage, no network.
 * The view computes a `ctx` (reference point, value medians) and passes in the
 * properties + weights; this module returns a score + factor breakdown for each.
 *
 * Scaling model (confirmed with the user):
 *   - Each 'minmax' factor is normalized RELATIVE TO ITS OWN SALE-MONTH GROUP:
 *     the best property that month = 100, the worst = 0. So this month's
 *     listings compete against each other, not against the whole archive.
 *   - 'size' uses a FIXED diminishing-returns curve (see factors.sizeSubScore),
 *     NOT month-relative scaling — so a lone giant commercial parcel can't seize
 *     the "100" and bury an ideal rental.
 *   - 'boolean' (Opportunity Zone) and 'categorical' (lien type) map to fixed
 *     0-100 values and ignore the month set.
 *   - Missing data for a factor => sub-score 50, flagged `estimated:true`. The
 *     factor is never dropped or re-weighted; the underlying data is never faked.
 *
 * Weights are relative: each factor's effective weight = w / (sum of all w).
 * A factor at weight 0 contributes nothing (turned off). final =
 * round( Σ subScore_i × effectiveWeight_i ), floored at 1, capped at 100.
 */
import { FACTORS, isNum, sizeSubScore } from './factors.js'
import { extractSales, median } from '../trends/aggregate.js'

/** Sale prices at or below this are treated as nominal ($1 / $0 / symbolic gift
 *  deeds) and excluded from the value-median computation. */
const NOMINAL_MAX = 100

const NEUTRAL = 50

/**
 * Build neighborhood / municipality median SALE-price lookups for the price
 * factor's value fallback. Uses TRUE market (third-party) sales only, excludes
 * nominal transfers. Pure: takes the property list, returns two Maps.
 */
export function buildValueMedians(properties) {
  const sales = extractSales(properties)
    .filter(s => s.isMarket && isNum(s.soldFor) && s.soldFor > NOMINAL_MAX)

  const collect = (keyFn) => {
    const groups = new Map()
    for (const s of sales) {
      const k = keyFn(s)
      if (!k) continue
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(s.soldFor)
    }
    const out = new Map()
    for (const [k, vals] of groups) {
      const m = median(vals)
      if (m != null) out.set(k, m)
    }
    return out
  }

  return {
    byNeighborhood: collect(s => s.neighborhood),
    byMunicipality: collect(s => s.municipality),
  }
}

/** Group properties by their current sale month (history[0].saleMonth). */
function groupByMonth(properties) {
  const byMonth = new Map()
  for (const p of properties) {
    const m = p.history?.[0]?.saleMonth || 'unknown'
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(p)
  }
  return byMonth
}

/** Min/max over the finite numbers in `nums`, or null when there are none. */
function rangeOf(nums) {
  const finite = nums.filter(isNum)
  if (finite.length === 0) return null
  return { min: Math.min(...finite), max: Math.max(...finite) }
}

/**
 * Normalize a raw value to 0-100 against a {min,max} range, honoring direction.
 * Degenerate range (all equal / single property) => NEUTRAL, so a factor with
 * no spread doesn't arbitrarily crown a "winner".
 */
function scaleToRange(raw, range, direction) {
  if (range == null || !isNum(raw)) return NEUTRAL
  const { min, max } = range
  if (max === min) return NEUTRAL
  const t = (raw - min) / (max - min) // 0 at min, 1 at max
  const high = t * 100
  return direction === 'low' ? 100 - high : high
}

/**
 * Precompute, per month group, the {min,max} ranges every minmax/size factor
 * needs. Returns Map<month, { [factorKey]: range | {sqft,beds,baths} }>.
 */
function computeMonthStats(byMonth, ctx) {
  const stats = new Map()
  for (const [month, props] of byMonth) {
    const s = {}
    for (const f of FACTORS) {
      // Only 'minmax' factors need a month-relative range. 'size' is a fixed
      // absolute curve and 'boolean'/'categorical' map directly.
      if (f.kind === 'minmax') {
        s[f.key] = rangeOf(props.map(p => f.getRaw(p, ctx)))
      }
    }
    stats.set(month, s)
  }
  return stats
}

/** Sub-score (0-100) + estimated flag for one factor on one property. */
function subScoreFor(factor, prop, ctx, monthStat) {
  const raw = factor.getRaw(prop, ctx)

  if (factor.kind === 'minmax') {
    if (!isNum(raw)) return { score: NEUTRAL, estimated: true, raw: null }
    return { score: scaleToRange(raw, monthStat[factor.key], factor.direction), estimated: false, raw }
  }

  if (factor.kind === 'boolean') {
    if (raw == null) return { score: NEUTRAL, estimated: true, raw: null }
    return { score: raw ? 100 : 0, estimated: false, raw }
  }

  if (factor.kind === 'categorical') {
    if (!isNum(raw)) return { score: NEUTRAL, estimated: true, raw: null }
    return { score: raw, estimated: false, raw }
  }

  if (factor.kind === 'size') {
    const s = sizeSubScore(raw) // fixed curve, not month-relative
    if (s == null) return { score: NEUTRAL, estimated: true, raw }
    return { score: s, estimated: false, raw }
  }

  return { score: NEUTRAL, estimated: true, raw: null }
}

/** Normalize weights to effective fractions summing to 1 (0 when all weights 0). */
export function effectiveWeights(weights) {
  const total = FACTORS.reduce((s, f) => s + Math.max(0, weights[f.key] || 0), 0)
  const out = {}
  for (const f of FACTORS) {
    out[f.key] = total > 0 ? Math.max(0, weights[f.key] || 0) / total : 0
  }
  out._total = total
  return out
}

/**
 * Score every property. Returns Map<caseNumber, result> where result is:
 *   {
 *     final: number|null,        // 1-100, null when no factor has any weight
 *     factors: [{ key, label, score, weight, weightPct, estimated, raw }],
 *     anyEstimated: boolean,
 *   }
 *
 * @param {object[]} properties
 * @param {object} opts
 * @param {object} opts.weights   { [factorKey]: 0-100 }
 * @param {object} [opts.ctx]     { refPoint, valueMedians }
 */
export function computeScores(properties, { weights, ctx = {} } = {}) {
  const eff = effectiveWeights(weights || {})
  const byMonth = groupByMonth(properties)
  const monthStats = computeMonthStats(byMonth, ctx)

  const results = new Map()
  for (const [month, props] of byMonth) {
    const monthStat = monthStats.get(month)
    for (const prop of props) {
      const factors = []
      let weightedSum = 0
      let anyEstimated = false
      for (const f of FACTORS) {
        const { score, estimated, raw } = subScoreFor(f, prop, ctx, monthStat)
        const w = eff[f.key]
        weightedSum += score * w
        if (estimated && w > 0) anyEstimated = true
        factors.push({
          key: f.key,
          label: f.label,
          score: Math.round(score),
          weight: w,
          weightPct: Math.round(w * 1000) / 10, // one decimal
          estimated,
          raw,
        })
      }
      const final = eff._total > 0
        ? Math.max(1, Math.min(100, Math.round(weightedSum)))
        : null
      results.set(prop.caseNumber, { final, factors, anyEstimated })
    }
  }
  return results
}
