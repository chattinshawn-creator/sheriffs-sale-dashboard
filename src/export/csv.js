import { isHilltopProperty } from '../enrichment/hilltop.js'
import { getCondemnedInfoSync } from '../enrichment/condemned.js'
import { normalizeParcelId } from '../enrichment/normalize.js'
import { validateProperty } from '../pdf/validation.js'
import { caseCategory, saleReadiness, serviceStateForProperty, CASE_CATEGORY_META, READINESS_META } from '../pdf/classify.js'
import { formatMonth } from '../ui/format.js'

/**
 * Column definitions for the export. Each entry maps a header name to a
 * function that pulls the value from a property record. Stored as an array
 * (not an object) so column order is deterministic.
 *
 * Add or reorder columns here as the export evolves — no other file needs
 * to change.
 */
const COLUMNS = [
  ['Case #',            p => p.caseNumber],
  ['Address',           p => p.address],
  ['Municipality',      p => p.municipality],
  ['Neighborhood',      p => p.enrichmentSummary?.neighborhood],
  ['Ward',              p => p.enrichmentSummary?.ward],
  ['Parcel ID',         p => p.parcelId],
  ['Sale month',        p => formatMonth(p.history[0]?.saleMonth)],
  ['Status',            p => p.history[0]?.status],
  ['Sale type',         p => p.saleType],
  ['Case type',         p => caseLabel(p)],
  ['Sale readiness',    p => readinessLabel(p)],
  ['Service boxes checked', p => serviceStateForProperty(p).serviceCheckedCount],
  ['OK box checked?',   p => { const s = serviceStateForProperty(p).serviceOk; return s === true ? 'yes' : s === false ? 'no' : '' }],
  ['Opening bid',       p => p.history[0]?.openingBid],
  ['WPRDC fair market', p => p.enrichmentSummary?.fairMarketValue],
  ['Your ARV override', p => p.userFields?.arvOverride],
  ['Effective ARV',     p => p.userFields?.arvOverride ?? p.enrichmentSummary?.fairMarketValue],
  ['Spread',            p => spreadOf(p)],
  ['Your max bid',      p => p.userFields?.maxBid],
  ['Margin if won at max', p => marginIfWonAtMax(p)],
  ['Your flag',         p => p.userFields?.flag || ''],
  ['Your notes',        p => p.userFields?.notes],
  ['Plaintiff',         p => p.plaintiff],
  ['Plaintiff attorney',p => p.plaintiffAttorney],
  ['Defendant',         p => p.defendant],
  ['Service flags',     p => p.serviceFlags],
  ['Hilltop?',          p => isHilltopProperty(p) ? 'yes' : ''],
  ['Condemned?',        p => condemnedFlag(p)],
  ['Condemnation status', p => condemnedField(p, 'inspectionStatus')],
  ['Last inspection',   p => condemnedField(p, 'createDate')],
  ['Last inspection result', p => condemnedField(p, 'latestInspectionResult')],
  ['Year built',        p => p.enrichmentSummary?.yearBuilt],
  ['Tracts',            p => p.tracts],
  ['Bankruptcy history?', p => (p.commentsParsed?.bankruptcyHistory?.length ?? 0) > 0 ? 'yes' : ''],
  ['Postponement count', p => p.commentsParsed?.postponementHistory?.length ?? 0],
  ['Replenishment unpaid?', p => p.commentsParsed?.replenishmentUnpaid ? 'yes' : ''],
  ['Needs review?',     p => validateProperty(p).ok ? '' : 'yes'],
  ['Validation issues', p => {
    const v = validateProperty(p)
    return v.ok ? '' : v.issues.join('; ')
  }],
  ['Sale number',       p => p.saleNumber],
]

function caseLabel(p) {
  const k = caseCategory(p.caseNumber)
  return k ? CASE_CATEGORY_META[k].label : ''
}

function readinessLabel(p) {
  const k = saleReadiness(p)
  return k ? READINESS_META[k].label : ''
}

function spreadOf(p) {
  const bid = p.history[0]?.openingBid
  const arv = p.userFields?.arvOverride ?? p.enrichmentSummary?.fairMarketValue
  if (bid == null || arv == null) return null
  return arv - bid
}

function marginIfWonAtMax(p) {
  const max = p.userFields?.maxBid
  const arv = p.userFields?.arvOverride ?? p.enrichmentSummary?.fairMarketValue
  if (max == null || arv == null) return null
  return arv - max
}

function condemnedInfo(p) {
  const parid = normalizeParcelId(p.parcelId)
  if (!parid) return null
  return getCondemnedInfoSync(parid)
}

function condemnedFlag(p) {
  if (!p.isPittsburghProper) return 'n/a'
  return condemnedInfo(p) ? 'yes' : ''
}

function condemnedField(p, field) {
  if (!p.isPittsburghProper) return ''
  const info = condemnedInfo(p)
  return info ? (info[field] ?? '') : ''
}

/**
 * Build a CSV string from a list of properties.
 * RFC 4180-style quoting: any field containing a comma, quote, or newline
 * is wrapped in double quotes, and inner quotes are doubled.
 */
export function propertiesToCsv(properties, { scoreMap } = {}) {
  // Optionally insert a "Score" column (the weighted 1-100 valuation) right
  // after Address, when the caller supplies the computed score map. Other
  // callers get the unchanged column set.
  const columns = scoreMap
    ? [
        ...COLUMNS.slice(0, 2),
        ['Score', p => scoreMap.get(p.caseNumber)?.final ?? ''],
        ['Score has estimated factors?', p => scoreMap.get(p.caseNumber)?.anyEstimated ? 'yes' : ''],
        ...COLUMNS.slice(2),
      ]
    : COLUMNS

  const headers = columns.map(c => c[0])
  const rows = [headers]
  for (const p of properties) {
    rows.push(columns.map(([, fn]) => {
      try { return fn(p) } catch (e) { return null }
    }))
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/**
 * Trigger a browser download of the given CSV string under the given filename.
 * Uses a temporary object URL — revoked once the click event has fired.
 */
export function downloadCsv(csvString, filename) {
  const blob = new Blob(['﻿' + csvString], { type: 'text/csv;charset=utf-8;' })
  // BOM ('﻿') makes Excel recognize UTF-8 correctly so accented chars
  // and special punctuation render right instead of showing as gibberish.
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}

/**
 * Build a filename like "sheriffs-sale-2026-06-12-pittsburgh-active.csv"
 * based on the filter state (passed in so the export module doesn't have
 * to know about home.js internals).
 */
export function exportFilename({ filterSummary } = {}) {
  const date = new Date().toISOString().slice(0, 10)
  const suffix = filterSummary ? `-${filterSummary}` : ''
  return `sheriffs-sale-${date}${suffix}.csv`
}
