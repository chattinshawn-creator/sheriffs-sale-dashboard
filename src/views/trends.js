import { listProperties } from '../storage/properties.js'
import { loadCondemnedIndex, getCondemnedInfoSync } from '../enrichment/condemned.js'
import { normalizeParcelId } from '../enrichment/normalize.js'
import { isHilltopProperty } from '../enrichment/hilltop.js'
import { downloadCsv } from '../export/csv.js'
import { escapeHtml, formatMonth } from '../ui/format.js'
import {
  extractSales, buildBreakdown, summarize, distinctMonths,
} from '../trends/aggregate.js'

// Minimum number of sales in a group before we show a median. Below this we
// show only the raw count with a "too few" note — a median over 1–4 points
// is noise, and we never want to imply a trend that isn't there.
const MIN_SAMPLE = 5

export async function renderTrends(el) {
  const [properties] = await Promise.all([
    listProperties(),
    loadCondemnedIndex().catch(err => {
      console.warn('[trends] condemned index failed to load:', err)
      return null
    }),
  ])

  const sales = extractSales(properties, {
    isCondemned: isCondemnedProp,
    isHilltop: isHilltopProperty,
  })

  if (sales.length === 0) {
    el.innerHTML = `
      ${styleBlock()}
      <h1>Trends</h1>
      <div class="banner info">No sales recorded yet.</div>
      <p class="muted">
        Price trends are built from properties that actually <strong>sold</strong>
        (third-party, plaintiff overbid, or plaintiff cost). Parse a
        <em>results</em> PDF on the <a href="#/upload">Upload</a> page and they'll
        appear here.
      </p>
    `
    return
  }

  const months = distinctMonths(sales)
  const thirdPartyCount = sales.filter(s => s.category === 'sold_third_party').length
  const plaintiffCount = sales.length - thirdPartyCount

  // Pittsburgh-only subset for neighborhood / condemned breakdowns.
  const pghSales = sales.filter(s => s.isPittsburgh)

  const sections = [
    {
      name: 'By sale month',
      subtitle: 'Watch this once several months accumulate — a single month is a snapshot, not a trend.',
      keyLabel: 'Sale month',
      keyFmt: formatMonth,
      rows: buildBreakdown(sales, s => s.saleMonth, { sortKeyAsc: true }),
    },
    {
      name: 'By Pittsburgh neighborhood',
      subtitle: 'Pittsburgh-proper sales only, grouped by enriched neighborhood.',
      keyLabel: 'Neighborhood',
      rows: buildBreakdown(pghSales, s => s.neighborhood),
    },
    {
      name: 'By municipality (county-wide)',
      subtitle: 'All sales grouped by the municipality on the sale record.',
      keyLabel: 'Municipality',
      rows: buildBreakdown(sales, s => s.municipality),
    },
    {
      name: 'Condemned vs. not (Pittsburgh)',
      subtitle: 'From the Pittsburgh PLI condemned/dead-end list. Pittsburgh-proper only.',
      keyLabel: 'Condition',
      rows: buildBreakdown(pghSales, s => (s.condemned ? 'Condemned' : 'Not condemned')),
    },
    {
      name: 'Hilltop vs. not',
      subtitle: 'Hilltop neighborhoods vs. everywhere else.',
      keyLabel: 'Area',
      rows: buildBreakdown(sales, s => (s.hilltop ? 'Hilltop' : 'Not Hilltop')),
    },
    {
      name: 'By sale type',
      subtitle: 'Tax lien vs. mortgage foreclosure vs. other, as labeled on the record.',
      keyLabel: 'Sale type',
      rows: buildBreakdown(sales, s => s.saleType),
    },
  ]

  const thinBanner = months <= 1
    ? `<div class="banner warn">
         <strong>Only ${months} sale month archived${months === 1 ? ` (${escapeHtml(formatMonth(sales[0].saleMonth))})` : ''}.</strong>
         These are current figures, not a trend yet — trends appear as more months are added.
       </div>`
    : ''

  el.innerHTML = `
    ${styleBlock()}
    <h1 style="margin-bottom:4px;">Trends</h1>
    <p class="muted" style="margin-top:0;">
      ${sales.length} sale${sales.length === 1 ? '' : 's'} across
      ${months} month${months === 1 ? '' : 's'} —
      <strong>${thirdPartyCount}</strong> third-party (market) and
      <strong>${plaintiffCount}</strong> plaintiff (overbid/cost).
    </p>

    ${thinBanner}

    <div class="banner info small">
      <strong>Read with care:</strong> a group's median is shown only once it has
      ${MIN_SAMPLE}+ sales — smaller groups show the raw count instead. And
      enrichment (neighborhood, condemned status) reflects each property's
      <em>current</em> state, not its state on the sale date. Third-party prices
      are real market sales; plaintiff overbid/cost are the lender taking the
      property back — they're kept in separate columns on purpose.
    </div>

    <div class="row" style="margin:12px 0;justify-content:flex-end;">
      <a href="#" id="export-trends-csv" class="small">Download trends CSV</a>
    </div>

    ${sections.map(renderTable).join('')}
  `

  el.querySelector('#export-trends-csv').addEventListener('click', (e) => {
    e.preventDefault()
    const csv = buildTrendsCsv(sections)
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(csv, `sheriffs-sale-trends-${date}.csv`)
  })
}

// ── Classification helper (Pittsburgh condemned lookup) ─────────────────────

function isCondemnedProp(p) {
  if (!p.isPittsburghProper) return false
  const parid = normalizeParcelId(p.parcelId)
  if (!parid) return false
  return !!getCondemnedInfoSync(parid)
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTable(section) {
  const { name, subtitle, keyLabel, keyFmt, rows } = section
  if (rows.length === 0) {
    return `<h2>${escapeHtml(name)}</h2><p class="muted small">No sales in this breakdown.</p>`
  }
  // Bar scale: largest median among rows that clear the threshold, per column.
  const maxTP = maxMedian(rows.map(r => r.thirdParty))
  const maxPL = maxMedian(rows.map(r => r.plaintiff))

  const body = rows.map(r => `
    <tr>
      <td>${escapeHtml(keyFmt ? keyFmt(r.key) : r.key)}</td>
      <td class="num">${r.total.count}</td>
      <td>${summaryCell(r.thirdParty, maxTP)}</td>
      <td>${summaryCell(r.plaintiff, maxPL)}</td>
    </tr>
  `).join('')

  return `
    <h2 style="margin-bottom:2px;">${escapeHtml(name)}</h2>
    ${subtitle ? `<p class="muted small" style="margin-top:0;">${escapeHtml(subtitle)}</p>` : ''}
    <table class="trends-table">
      <thead>
        <tr>
          <th>${escapeHtml(keyLabel)}</th>
          <th class="num">All sales</th>
          <th>Third party (market)</th>
          <th>Plaintiff (overbid/cost)</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `
}

function summaryCell(sum, maxForBar) {
  if (sum.count === 0) return '<span class="muted">—</span>'
  if (sum.count < MIN_SAMPLE) {
    return `<span class="muted small">${sum.count} sale${sum.count === 1 ? '' : 's'} · too few for a median</span>`
  }
  const pct = maxForBar > 0 ? Math.round((sum.median / maxForBar) * 100) : 0
  return `
    <div><strong>${fmtMoney(sum.median)}</strong> <span class="muted small">median · n=${sum.count}</span></div>
    <div class="trend-bar"><div class="trend-bar-fill" style="width:${pct}%"></div></div>
    <div class="muted small">${fmtMoney(sum.min)} – ${fmtMoney(sum.max)}</div>
  `
}

function maxMedian(summaries) {
  const eligible = summaries.filter(s => s.count >= MIN_SAMPLE && s.median != null).map(s => s.median)
  return eligible.length ? Math.max(...eligible) : 0
}

function fmtMoney(n) {
  if (n == null) return '—'
  return '$' + Math.round(n).toLocaleString()
}

function styleBlock() {
  return `
    <style>
      .trends-table { width:100%; border-collapse:collapse; margin:6px 0 22px; font-size:14px; }
      .trends-table th, .trends-table td {
        text-align:left; padding:8px 10px; border-bottom:1px solid var(--color-border, #e5e7eb);
        vertical-align:top;
      }
      .trends-table th { font-weight:600; color:var(--color-muted, #6b7280); font-size:13px; }
      .trends-table td.num, .trends-table th.num { text-align:right; white-space:nowrap; }
      .trends-table tbody tr:hover { background:var(--color-info-bg, #eff6ff); }
      .trend-bar { height:6px; background:var(--color-border, #e5e7eb); border-radius:3px; margin:4px 0; overflow:hidden; max-width:160px; }
      .trend-bar-fill { height:100%; background:var(--color-info, #2563eb); }
    </style>
  `
}

// ── CSV export ───────────────────────────────────────────────────────────────

function buildTrendsCsv(sections) {
  const headers = [
    'Breakdown', 'Group', 'All sales',
    'Third party count', 'Third party median', 'Third party min', 'Third party max',
    'Plaintiff count', 'Plaintiff median', 'Plaintiff min', 'Plaintiff max',
  ]
  const rows = [headers]
  for (const section of sections) {
    for (const r of section.rows) {
      const label = section.keyFmt ? section.keyFmt(r.key) : r.key
      const tp = thresholded(r.thirdParty)
      const pl = thresholded(r.plaintiff)
      rows.push([
        section.name, label, r.total.count,
        r.thirdParty.count, tp.median, tp.min, tp.max,
        r.plaintiff.count, pl.median, pl.min, pl.max,
      ])
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

// Below MIN_SAMPLE the median is statistically meaningless, so we blank it in
// the CSV too (consistent with the on-screen "too few" treatment). The raw
// count is always kept.
function thresholded(sum) {
  if (sum.count < MIN_SAMPLE) return { median: '', min: '', max: '' }
  return { median: csvNum(sum.median), min: csvNum(sum.min), max: csvNum(sum.max) }
}

function csvNum(n) { return n == null ? '' : Math.round(n) }

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
