import { listProperties } from '../storage/properties.js'
import { loadCondemnedIndex, getCondemnedInfoSync } from '../enrichment/condemned.js'
import { normalizeParcelId } from '../enrichment/normalize.js'
import { isHilltopProperty } from '../enrichment/hilltop.js'
import { OUTCOME_CATEGORIES, OUTCOME_META } from '../pdf/outcome.js'
import { propertiesToCsv, downloadCsv, exportFilename } from '../export/csv.js'
import { formatMonth, escapeHtml, escapeAttr } from '../ui/format.js'

/**
 * Archive-wide search — find any property across every month, by typing
 * (forgiving free text) and/or by combinable filters (AND logic). Built on
 * the same enrichment accessors the rest of the app uses, so results stay
 * consistent with Home and Trends. Plain in-memory filtering: all properties
 * are loaded once and filtered as you type — instant for the archive's size.
 *
 * Does NOT touch Home's status buckets; this is a separate, additive view.
 */

// In-memory filter state. Survives navigation within the session, resets on a
// full page refresh — same convention as Home.
const state = {
  text: '',
  neighborhood: '',   // '' = any
  municipality: '',
  hilltop: 'any',     // 'any' | 'yes' | 'no'
  condemned: 'any',   // 'any' | 'yes' | 'no'
  saleType: '',
  outcome: '',        // '' = any; one of OUTCOME_CATEGORIES (matches ANY history entry)
  month: '',          // '' = any (matches ANY history entry)
  priceMin: null,
  priceMax: null,
}

export async function renderSearch(el, params) {
  const [properties] = await Promise.all([
    listProperties(),
    // Needed so the condemned filter's synchronous lookups have data.
    loadCondemnedIndex().catch(err => {
      console.warn('[search] condemned index failed to load:', err)
      return null
    }),
  ])

  // Deep link from the Archive overview: #/search?month=YYYY-MM preselects the
  // sale-month filter.
  const linkedMonth = params?.query?.month
  if (linkedMonth) state.month = linkedMonth

  if (properties.length === 0) {
    el.innerHTML = `
      <h1>Search</h1>
      <div class="banner info">No properties to search yet.</div>
      <p class="muted">
        Upload and parse a Sheriff's Sale PDF on the <a href="#/upload">Upload</a>
        page and it'll be searchable here.
      </p>
    `
    return
  }

  const options = buildOptions(properties)
  el.innerHTML = renderShell(options)
  wireControls(el, properties)
  renderResults(el, properties)
}

// ─── Option lists for the dropdowns ────────────────────────────────────────

function buildOptions(properties) {
  const neighborhoods = new Set()
  const municipalities = new Set()
  const saleTypes = new Set()
  const months = new Set()

  for (const p of properties) {
    if (p.enrichmentSummary?.neighborhood) neighborhoods.add(p.enrichmentSummary.neighborhood)
    if (p.municipality) municipalities.add(p.municipality)
    if (p.saleType) saleTypes.add(p.saleType)
    for (const h of (p.history || [])) {
      if (h.saleMonth) months.add(h.saleMonth)
    }
  }

  return {
    neighborhoods: [...neighborhoods].sort((a, b) => a.localeCompare(b)),
    municipalities: [...municipalities].sort((a, b) => a.localeCompare(b)),
    saleTypes: [...saleTypes].sort((a, b) => a.localeCompare(b)),
    months: [...months].sort((a, b) => b.localeCompare(a)),
  }
}

// ─── Shell + filter controls ───────────────────────────────────────────────

function renderShell(options) {
  return `
    <h1 style="margin-bottom:4px;">Search</h1>
    <p class="muted" style="margin-top:0;">
      Find any property across every archived month. Type to search, and combine
      the filters below — they all apply together.
    </p>

    <div class="filter-bar">
      <div class="row" style="gap:8px;align-items:center;">
        <input type="search" id="search-text"
               placeholder="Address, parcel, case #, sale #, plaintiff, defendant, area…"
               value="${escapeAttr(state.text)}"
               style="flex:1;min-width:260px;max-width:none;" />
      </div>

      <div class="filter-row" style="gap:12px;flex-wrap:wrap;">
        ${selectControl('flt-neighborhood', 'Neighborhood', options.neighborhoods, state.neighborhood)}
        ${selectControl('flt-municipality', 'Municipality', options.municipalities, state.municipality)}
        ${selectControl('flt-saletype', 'Sale type', options.saleTypes, state.saleType)}
        ${selectControl('flt-month', 'Sale month', options.months, state.month, formatMonth)}
        ${outcomeControl()}
        ${triStateControl('flt-hilltop', 'Hilltop', state.hilltop)}
        ${triStateControl('flt-condemned', 'Condemned', state.condemned)}
      </div>

      <div class="filter-row" style="gap:8px;align-items:center;">
        <span class="filter-label" title="Filters on the sold price of the property's most recent sale (its current state).">Sold price range ($):</span>
        <input type="number" id="flt-price-min" placeholder="min" step="1000"
               value="${state.priceMin ?? ''}" style="width:120px;" />
        <span class="muted">to</span>
        <input type="number" id="flt-price-max" placeholder="max" step="1000"
               value="${state.priceMax ?? ''}" style="width:120px;" />
      </div>
    </div>

    <div class="row" style="margin:12px 0;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
      <div id="search-summary" class="muted small"></div>
      <div class="row" style="gap:16px;">
        <a href="#" id="export-search-csv" class="small">Download CSV</a>
        <a href="#" id="clear-search" class="small">Clear filters</a>
      </div>
    </div>

    <div id="search-results"></div>
  `
}

function selectControl(id, label, values, selected, fmt) {
  const opts = [`<option value="">${escapeHtml(label)}: any</option>`]
    .concat(values.map(v =>
      `<option value="${escapeAttr(v)}" ${selected === v ? 'selected' : ''}>${escapeHtml(fmt ? fmt(v) : v)}</option>`))
    .join('')
  return `<select id="${id}" style="width:auto;" aria-label="${escapeAttr(label)}">${opts}</select>`
}

function outcomeControl() {
  const opts = [`<option value="">Status: any</option>`]
    .concat(OUTCOME_CATEGORIES.map(c =>
      `<option value="${escapeAttr(c)}" ${state.outcome === c ? 'selected' : ''}>${escapeHtml(OUTCOME_META[c].label)}</option>`))
    .join('')
  return `<select id="flt-outcome" style="width:auto;" aria-label="Status">${opts}</select>`
}

function triStateControl(id, label, value) {
  const opt = (v, text) => `<option value="${v}" ${value === v ? 'selected' : ''}>${escapeHtml(text)}</option>`
  return `
    <select id="${id}" style="width:auto;" aria-label="${escapeAttr(label)}">
      ${opt('any', `${label}: any`)}
      ${opt('yes', `${label}: yes`)}
      ${opt('no', `${label}: no`)}
    </select>
  `
}

// ─── Wiring ────────────────────────────────────────────────────────────────

function wireControls(el, properties) {
  const rerun = () => renderResults(el, properties)

  el.querySelector('#search-text').addEventListener('input', (e) => {
    state.text = e.target.value
    rerun()
  })

  const bind = (id, key, transform = (v) => v) => {
    el.querySelector(id)?.addEventListener('change', (e) => {
      state[key] = transform(e.target.value)
      rerun()
    })
  }
  bind('#flt-neighborhood', 'neighborhood')
  bind('#flt-municipality', 'municipality')
  bind('#flt-saletype', 'saleType')
  bind('#flt-month', 'month')
  bind('#flt-outcome', 'outcome')
  bind('#flt-hilltop', 'hilltop')
  bind('#flt-condemned', 'condemned')

  const numOrNull = (v) => {
    const s = String(v).trim()
    if (s === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  el.querySelector('#flt-price-min').addEventListener('input', (e) => { state.priceMin = numOrNull(e.target.value); rerun() })
  el.querySelector('#flt-price-max').addEventListener('input', (e) => { state.priceMax = numOrNull(e.target.value); rerun() })

  el.querySelector('#clear-search').addEventListener('click', (e) => {
    e.preventDefault()
    Object.assign(state, {
      text: '', neighborhood: '', municipality: '', hilltop: 'any',
      condemned: 'any', saleType: '', outcome: '', month: '',
      priceMin: null, priceMax: null,
    })
    renderSearch(el, {}) // full re-render to reset all controls
  })

  el.querySelector('#export-search-csv').addEventListener('click', (e) => {
    e.preventDefault()
    const matches = applyFilters(properties)
    const csv = propertiesToCsv(matches)
    downloadCsv(csv, exportFilename({ filterSummary: filterSlug() }))
  })
}

// ─── Filtering ─────────────────────────────────────────────────────────────

function applyFilters(properties) {
  return properties.filter(p => {
    if (!matchesText(p, state.text)) return false
    if (state.neighborhood && p.enrichmentSummary?.neighborhood !== state.neighborhood) return false
    if (state.municipality && p.municipality !== state.municipality) return false
    if (state.saleType && p.saleType !== state.saleType) return false

    if (state.hilltop !== 'any') {
      const isHt = isHilltopProperty(p)
      if (state.hilltop === 'yes' && !isHt) return false
      if (state.hilltop === 'no' && isHt) return false
    }

    if (state.condemned !== 'any') {
      const isCon = isCondemned(p)
      if (state.condemned === 'yes' && !isCon) return false
      if (state.condemned === 'no' && isCon) return false
    }

    // Sale month matches ANY history entry, i.e. "appeared in that month".
    // This keeps the Archive overview's month link consistent with its record
    // count (the same property the archive counts for July is the one the link
    // surfaces), and lets you find a property by a month it merely appeared in.
    if (state.month && !(p.history || []).some(h => h.saleMonth === state.month)) return false

    // Status and price match the LATEST history entry — i.e. the property's
    // CURRENT state — consistent with how Home reads status. A property
    // postponed in May but sold in July reads as a July sale, not a May
    // postponement.
    const latest = (p.history || [])[0] || {}
    if (state.outcome && latest.outcomeCategory !== state.outcome) return false

    if (state.priceMin != null || state.priceMax != null) {
      const sold = latest.soldFor
      if (typeof sold !== 'number' || !Number.isFinite(sold)) return false
      if (state.priceMin != null && sold < state.priceMin) return false
      if (state.priceMax != null && sold > state.priceMax) return false
    }

    return true
  })
}

/**
 * Forgiving free-text match: case-insensitive, partial, across address, case
 * number, sale number, plaintiff, defendant, municipality and neighborhood —
 * plus parcel IDs with separators ignored (so "0033-D-00320" and "0033D00320"
 * both hit, against either the raw or normalized parcel form).
 */
function matchesText(p, raw) {
  const needle = String(raw || '').trim().toLowerCase()
  if (!needle) return true

  const hay = [
    p.address, p.caseNumber, p.saleNumber, p.plaintiff, p.defendant,
    p.municipality, p.enrichmentSummary?.neighborhood,
  ].filter(Boolean).join(' ').toLowerCase()
  if (hay.includes(needle)) return true

  const needleParcel = needle.replace(/[^a-z0-9]/g, '')
  if (needleParcel) {
    const rawParcel = String(p.parcelId || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const normParcel = String(normalizeParcelId(p.parcelId) || '').toLowerCase()
    if (rawParcel.includes(needleParcel) || normParcel.includes(needleParcel)) return true
  }
  return false
}

/** Pittsburgh-only condemned lookup against the in-memory index. */
function isCondemned(p) {
  if (!p.isPittsburghProper) return false
  const parid = normalizeParcelId(p.parcelId)
  if (!parid) return false
  return !!getCondemnedInfoSync(parid)
}

// ─── Results ─────────────────────────────────────────────────────────────────

function renderResults(el, properties) {
  const matches = applyFilters(properties)

  const summaryEl = el.querySelector('#search-summary')
  if (summaryEl) {
    const active = activeFilterLabels()
    summaryEl.innerHTML =
      `Showing <strong>${matches.length}</strong> of ${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}` +
      (active.length ? ` · filters: ${active.map(a => `<span class="tag">${escapeHtml(a)}</span>`).join(' ')}` : '')
  }

  const listEl = el.querySelector('#search-results')
  if (matches.length === 0) {
    listEl.innerHTML = `
      <div class="banner info">
        No properties match — try clearing a filter.
        <a href="#" id="empty-clear">Clear all filters</a>.
      </div>
    `
    listEl.querySelector('#empty-clear').addEventListener('click', (e) => {
      e.preventDefault()
      el.querySelector('#clear-search').click()
    })
    return
  }

  listEl.innerHTML = renderResultsTable(matches)
}

function renderResultsTable(matches) {
  const rows = matches.map(p => {
    const h = p.history?.[0] || {}
    const area = p.enrichmentSummary?.neighborhood || p.municipality || '—'
    const bid = h.openingBid != null
      ? '$' + h.openingBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—'
    const sold = h.soldFor != null ? '$' + h.soldFor.toLocaleString() : '—'
    return `
      <tr style="border-bottom:1px solid var(--color-border);">
        <td style="padding:8px 10px;">
          <a href="#/property/${encodeURIComponent(p.caseNumber)}"><strong>${escapeHtml(p.address || '(no address)')}</strong></a>
        </td>
        <td style="padding:8px 10px;">${escapeHtml(area)}</td>
        <td style="padding:8px 10px;">${escapeHtml(p.caseNumber)}</td>
        <td style="padding:8px 10px;">${escapeHtml(p.parcelId || '—')}</td>
        <td style="padding:8px 10px;">${escapeHtml(formatMonth(h.saleMonth))}</td>
        <td style="padding:8px 10px;">${escapeHtml(h.status || '—')}</td>
        <td style="padding:8px 10px;text-align:right;">${bid}</td>
        <td style="padding:8px 10px;text-align:right;">${sold}</td>
      </tr>
    `
  }).join('')

  return `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid var(--color-border);">
            <th style="padding:8px 10px;">Address</th>
            <th style="padding:8px 10px;">Area</th>
            <th style="padding:8px 10px;">Case #</th>
            <th style="padding:8px 10px;">Parcel</th>
            <th style="padding:8px 10px;">Latest month</th>
            <th style="padding:8px 10px;">Latest status</th>
            <th style="padding:8px 10px;text-align:right;">Opening bid</th>
            <th style="padding:8px 10px;text-align:right;">Sold for</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}

// ─── Active-filter labels + export filename slug ────────────────────────────

function activeFilterLabels() {
  const out = []
  if (state.text) out.push(`“${state.text}”`)
  if (state.neighborhood) out.push(state.neighborhood)
  if (state.municipality) out.push(state.municipality)
  if (state.saleType) out.push(state.saleType)
  if (state.month) out.push(formatMonth(state.month))
  if (state.outcome) out.push(OUTCOME_META[state.outcome]?.label || state.outcome)
  if (state.hilltop !== 'any') out.push(`Hilltop: ${state.hilltop}`)
  if (state.condemned !== 'any') out.push(`Condemned: ${state.condemned}`)
  if (state.priceMin != null || state.priceMax != null) {
    out.push(`price ${state.priceMin ?? '0'}–${state.priceMax ?? '∞'}`)
  }
  return out
}

function filterSlug() {
  const parts = []
  if (state.text) parts.push(state.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30))
  if (state.month) parts.push(state.month)
  if (state.neighborhood) parts.push(state.neighborhood.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  if (state.outcome) parts.push(state.outcome)
  if (state.hilltop === 'yes') parts.push('hilltop')
  if (state.condemned === 'yes') parts.push('condemned')
  return parts.join('-').replace(/^-|-$/g, '').slice(0, 60)
}
