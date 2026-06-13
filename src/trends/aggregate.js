/**
 * Pure aggregation logic for the Trends view.
 *
 * A "sale" is one history entry whose outcomeCategory is a priced outcome
 * (sold_third_party / plaintiff_overbid / plaintiff_cost) carrying a numeric
 * soldFor. We deliberately separate true market sales (third party) from
 * lender repossessions (plaintiff overbid/cost) everywhere downstream.
 *
 * Kept free of DOM and storage concerns so it can be unit-tested directly —
 * see aggregate.test.js. Condemned/Hilltop classification is INJECTED by the
 * caller (the view supplies functions backed by the enrichment indexes) so
 * this module needs no browser-only imports.
 */
import { SALE_CATEGORIES, OUTCOME_META } from '../pdf/outcome.js'

/**
 * Flatten properties → individual sale records.
 * @param {object[]} properties
 * @param {{ isCondemned?: (p:object)=>boolean, isHilltop?: (p:object)=>boolean }} [classifiers]
 */
export function extractSales(properties, { isCondemned, isHilltop } = {}) {
  const sales = []
  for (const p of properties || []) {
    for (const h of (p.history || [])) {
      if (!SALE_CATEGORIES.has(h.outcomeCategory)) continue
      if (typeof h.soldFor !== 'number' || !Number.isFinite(h.soldFor)) continue
      sales.push({
        caseNumber: p.caseNumber,
        saleMonth: h.saleMonth || null,
        category: h.outcomeCategory,
        isMarket: !!OUTCOME_META[h.outcomeCategory]?.isMarket,
        soldFor: h.soldFor,
        neighborhood: p.enrichmentSummary?.neighborhood || null,
        municipality: p.municipality || null,
        saleType: p.saleType || null,
        isPittsburgh: !!p.isPittsburghProper,
        condemned: isCondemned ? !!isCondemned(p) : false,
        hilltop: isHilltop ? !!isHilltop(p) : false,
      })
    }
  }
  return sales
}

/** Median of a numeric array, or null if empty. Median over mean so a couple
 *  of outliers don't distort a small group. */
export function median(nums) {
  if (!nums || nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Count / median / min / max summary of a set of sales. */
export function summarize(sales) {
  const vals = sales.map(s => s.soldFor)
  return {
    count: vals.length,
    median: median(vals),
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
  }
}

/** Group sales by a key function; entries whose key is null/undefined are skipped. */
export function groupBy(sales, keyFn) {
  const m = new Map()
  for (const s of sales) {
    const k = keyFn(s)
    if (k == null || k === '') continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(s)
  }
  return m
}

/**
 * Build a breakdown: for each group, the overall summary plus separate
 * summaries for third-party (true market) and plaintiff (overbid+cost) sales.
 * Rows are sorted by total sale count descending, then key ascending.
 *
 * @param {object[]} sales
 * @param {(s:object)=>(string|null)} keyFn
 * @param {{ sortKeyAsc?: boolean }} [opts]  sort rows by key ascending instead
 *        of by count (useful for the time/month breakdown).
 */
export function buildBreakdown(sales, keyFn, { sortKeyAsc = false } = {}) {
  const groups = groupBy(sales, keyFn)
  const rows = []
  for (const [key, groupSales] of groups) {
    rows.push({
      key,
      total: summarize(groupSales),
      thirdParty: summarize(groupSales.filter(s => s.category === 'sold_third_party')),
      plaintiff: summarize(groupSales.filter(s => s.category !== 'sold_third_party')),
    })
  }
  if (sortKeyAsc) {
    rows.sort((a, b) => String(a.key).localeCompare(String(b.key)))
  } else {
    rows.sort((a, b) => b.total.count - a.total.count || String(a.key).localeCompare(String(b.key)))
  }
  return rows
}

/** Number of distinct sale months represented in the sales set. */
export function distinctMonths(sales) {
  return new Set(sales.map(s => s.saleMonth).filter(Boolean)).size
}
