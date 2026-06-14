import { listUploads } from '../storage/uploads.js'
import { listProperties } from '../storage/properties.js'
import {
  OUTCOME_CATEGORIES, OUTCOME_META, SALE_CATEGORIES,
} from '../pdf/outcome.js'
import { downloadCsv } from '../export/csv.js'
import { formatMonth, escapeHtml, escapeAttr } from '../ui/format.js'

/**
 * Archive overview — the health of the whole archive at a glance.
 *
 * Built entirely from data that already exists: the append-only uploads
 * archive (which PDFs landed, tagged by sale month) and the canonical
 * properties' per-sale history[] (what happened each month). No new data
 * sources, no schema changes.
 */
export async function renderArchive(el) {
  const [uploads, properties] = await Promise.all([
    listUploads(),
    listProperties(),
  ])

  if (uploads.length === 0 && properties.length === 0) {
    el.innerHTML = `
      <h1>Archive</h1>
      <div class="banner info">Nothing archived yet.</div>
      <p class="muted">
        Upload a Sheriff's Sale PDF on the <a href="#/upload">Upload</a> page to
        start building the archive.
      </p>
    `
    return
  }

  const months = buildMonthRows(uploads, properties)
  const totals = buildTotals(months, properties)

  el.innerHTML = renderShell(months, totals)

  el.querySelector('#export-archive-csv')?.addEventListener('click', (e) => {
    e.preventDefault()
    const csv = buildArchiveCsv(months)
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(csv, `sheriffs-sale-archive-${date}.csv`)
  })
}

// ─── Data assembly ─────────────────────────────────────────────────────────

/**
 * One row per sale month, merging upload metadata with the per-month outcome
 * counts derived from every property's history[]. Rows are newest-month-first.
 */
function buildMonthRows(uploads, properties) {
  const byMonth = new Map()

  const ensure = (month) => {
    if (!byMonth.has(month)) {
      byMonth.set(month, {
        month,
        hasListings: false,
        hasResults: false,
        uploadCount: 0,
        records: 0,
        byCategory: Object.fromEntries(OUTCOME_CATEGORIES.map(c => [c, 0])),
        salesWithPrice: 0,
      })
    }
    return byMonth.get(month)
  }

  for (const u of uploads) {
    const row = ensure(u.saleMonth || 'Unknown')
    row.uploadCount++
    if (u.type === 'listings') row.hasListings = true
    if (u.type === 'results') row.hasResults = true
  }

  for (const p of properties) {
    for (const h of (p.history || [])) {
      const row = ensure(h.saleMonth || 'Unknown')
      row.records++
      const cat = OUTCOME_CATEGORIES.includes(h.outcomeCategory) ? h.outcomeCategory : 'other'
      row.byCategory[cat]++
      if (SALE_CATEGORIES.has(cat) && typeof h.soldFor === 'number' && Number.isFinite(h.soldFor)) {
        row.salesWithPrice++
      }
    }
  }

  return [...byMonth.values()].sort((a, b) => String(b.month).localeCompare(String(a.month)))
}

function buildTotals(monthRows, properties) {
  const realMonths = monthRows.filter(r => r.month !== 'Unknown')
  const salesWithPrice = monthRows.reduce((sum, r) => sum + r.salesWithPrice, 0)
  return {
    monthCount: realMonths.length,
    propertyCount: properties.length,
    salesWithPrice,
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function renderShell(months, totals) {
  const thinBanner = totals.monthCount <= 1
    ? `<div class="banner warn">
         <strong>Only ${totals.monthCount} sale month archived.</strong>
         Trends need more months — add another month's PDFs and the
         <a href="#/trends">Trends</a> view will start comparing across months.
       </div>`
    : ''

  return `
    <h1 style="margin-bottom:4px;">Archive</h1>
    <p class="muted" style="margin-top:0;">The health of your whole archive at a glance.</p>

    <div class="row" style="gap:16px;flex-wrap:wrap;margin:12px 0;">
      ${statCard(totals.monthCount, `sale month${totals.monthCount === 1 ? '' : 's'} archived`)}
      ${statCard(totals.propertyCount, `distinct propert${totals.propertyCount === 1 ? 'y' : 'ies'}`)}
      ${statCard(totals.salesWithPrice, `sale${totals.salesWithPrice === 1 ? '' : 's'} with a price`, 'These feed the Trends view.')}
    </div>

    ${thinBanner}

    <div class="banner info small">
      <strong>How to read this:</strong> “Records” is how many properties appeared that
      month. The outcome counts come from each property's history. “Other” is anything
      the parser couldn't classify — a non-zero count there is worth a look (the source
      vocabulary may have changed). Click a month to see those properties in Search.
    </div>

    <div class="row" style="margin:12px 0;justify-content:flex-end;">
      <a href="#" id="export-archive-csv" class="small">Download archive CSV</a>
    </div>

    ${renderMonthsTable(months)}
  `
}

function statCard(value, label, note) {
  return `
    <div class="card" style="flex:1;min-width:160px;margin:0;">
      <div style="font-size:30px;font-weight:800;line-height:1;">${value}</div>
      <div class="muted small" style="margin-top:4px;">${escapeHtml(label)}</div>
      ${note ? `<div class="muted small" style="margin-top:2px;">${escapeHtml(note)}</div>` : ''}
    </div>
  `
}

function renderMonthsTable(months) {
  if (months.length === 0) {
    return `<p class="muted">No sale months yet.</p>`
  }
  const rows = months.map(renderMonthRow).join('')
  return `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid var(--color-border);">
            <th style="padding:8px 10px;">Sale month</th>
            <th style="padding:8px 10px;">Uploads</th>
            <th style="padding:8px 10px;text-align:right;">Records</th>
            <th style="padding:8px 10px;">Outcomes</th>
            <th style="padding:8px 10px;text-align:right;">Sales w/ price</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}

const CATEGORY_BADGE = {
  sold_third_party:  'background:#d1fae5;color:#065f46;border-color:#a7f3d0;',
  plaintiff_overbid: 'background:#dbeafe;color:#1e40af;border-color:#bfdbfe;',
  plaintiff_cost:    'background:#dbeafe;color:#1e40af;border-color:#bfdbfe;',
  money_made:        'background:#d1fae5;color:#065f46;border-color:#a7f3d0;',
  postponed:         'background:#fef3c7;color:#b45309;border-color:#fde68a;',
  stayed:            'background:#fee2e2;color:#991b1b;border-color:#fecaca;',
  other:             'background:#fee2e2;color:#991b1b;border-color:#fecaca;',
}

function renderMonthRow(row) {
  const isUnknown = row.month === 'Unknown'
  const label = isUnknown ? 'Unknown month' : formatMonth(row.month)

  const uploadTags = []
  if (row.hasListings) uploadTags.push(`<span class="tag listings">listings</span>`)
  if (row.hasResults) uploadTags.push(`<span class="tag results">results</span>`)
  if (uploadTags.length === 0) uploadTags.push(`<span class="muted small">none</span>`)

  // Outcome badges — only non-zero categories, in the canonical order.
  const badges = OUTCOME_CATEGORIES
    .filter(cat => row.byCategory[cat] > 0)
    .map(cat => {
      const meta = OUTCOME_META[cat]
      const style = CATEGORY_BADGE[cat] || CATEGORY_BADGE.other
      const title = cat === 'other' ? 'Status the parser could not classify — worth reviewing' : meta.label
      return `<span class="tag" style="${style}" title="${escapeAttr(title)}">${escapeHtml(meta.label)} ${row.byCategory[cat]}</span>`
    }).join(' ')

  const monthCell = isUnknown
    ? `<strong>${escapeHtml(label)}</strong>`
    : `<a href="#/search?month=${encodeURIComponent(row.month)}"><strong>${escapeHtml(label)}</strong></a>`

  return `
    <tr style="border-bottom:1px solid var(--color-border);">
      <td style="padding:8px 10px;">${monthCell}</td>
      <td style="padding:8px 10px;"><div class="row" style="gap:6px;">${uploadTags.join(' ')}</div></td>
      <td style="padding:8px 10px;text-align:right;">${row.records}</td>
      <td style="padding:8px 10px;"><div class="row" style="gap:6px;flex-wrap:wrap;">${badges || '<span class="muted small">—</span>'}</div></td>
      <td style="padding:8px 10px;text-align:right;">${row.salesWithPrice}</td>
    </tr>
  `
}

// ─── CSV export ──────────────────────────────────────────────────────────────

function buildArchiveCsv(months) {
  const headers = [
    'Sale month', 'Listings uploaded?', 'Results uploaded?', 'Records',
    ...OUTCOME_CATEGORIES.map(c => OUTCOME_META[c].label),
    'Sales with price',
  ]
  const rows = [headers]
  for (const r of months) {
    rows.push([
      r.month === 'Unknown' ? 'Unknown' : formatMonth(r.month),
      r.hasListings ? 'yes' : '',
      r.hasResults ? 'yes' : '',
      r.records,
      ...OUTCOME_CATEGORIES.map(c => r.byCategory[c]),
      r.salesWithPrice,
    ])
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
