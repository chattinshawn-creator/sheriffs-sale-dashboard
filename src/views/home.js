import { listUploads } from '../storage/uploads.js'
import { listProperties } from '../storage/properties.js'
import { validateProperty } from '../pdf/validation.js'
import { isHilltopProperty, HILLTOP_LIST_LABEL } from '../enrichment/hilltop.js'
import { enrichAllProperties, cancelBulkEnrichment } from '../enrichment/bulk.js'
import { loadCondemnedIndex, getCondemnedInfoSync } from '../enrichment/condemned.js'
import { normalizeParcelId } from '../enrichment/normalize.js'
import { propertiesToCsv, downloadCsv, exportFilename } from '../export/csv.js'
import { formatMonth, formatBytes, formatDate, escapeHtml, escapeAttr } from '../ui/format.js'

// In-memory filter/sort state. Survives navigation within the session but
// resets on full page refresh — that's fine for V1; we can persist to URL
// hash later if you want shareable filtered views.
const state = {
  search: '',
  sort: 'sale-month',
  statuses: new Set(['active', 'postponed', 'stayed', 'sold']),
  flags: new Set(['interested', 'skip', 'unflagged']),
  needsReviewOnly: false,
  hilltopOnly: false,
  condemnedOnly: false,
}

const STATUS_OPTIONS = [
  { key: 'active',    label: 'Active' },
  { key: 'postponed', label: 'Postponed' },
  { key: 'stayed',    label: 'Stayed' },
  { key: 'sold',      label: 'Sold' },
]
const FLAG_OPTIONS = [
  { key: 'interested', label: 'Interested' },
  { key: 'skip',       label: 'Skip' },
  { key: 'unflagged',  label: 'Unflagged' },
]
const SORT_OPTIONS = [
  { key: 'sale-month',  label: 'Sale month (grouped)' },
  { key: 'spread-desc', label: 'Spread (best deals first)' },
  { key: 'bid-desc',    label: 'Opening bid (high → low)' },
  { key: 'bid-asc',     label: 'Opening bid (low → high)' },
  { key: 'status',      label: 'Status priority' },
  { key: 'case',        label: 'Case number' },
  { key: 'address',     label: 'Address' },
]

export async function renderHome(el) {
  // Pre-load the condemned index so the synchronous lookups in card render
  // have data to work with. Cached after first load — subsequent renders
  // resolve immediately.
  const [uploads, properties] = await Promise.all([
    listUploads(),
    listProperties(),
    loadCondemnedIndex().catch(err => {
      console.warn('[home] condemned index failed to load:', err)
      return null
    }),
  ])

  if (uploads.length === 0) {
    el.innerHTML = `
      <h1>Home</h1>
      <div class="banner info">No properties loaded yet.</div>
      <p class="muted">
        Upload a Sheriff's Sale PDF on the <a href="#/upload">Upload</a> page to
        get started.
      </p>
    `
    return
  }

  el.innerHTML = renderShell(uploads, properties)
  wireControls(el, properties)
  renderPropertyList(el, properties)
}

// ─── Top-level shell ───────────────────────────────────────────────────────

function renderShell(uploads, properties) {
  const propsTotal = properties.length
  return `
    <h1 style="margin-bottom:4px;">Home</h1>
    <p class="muted" style="margin-top:0;">
      ${propsTotal} propert${propsTotal === 1 ? 'y' : 'ies'} across
      ${uploads.length} upload${uploads.length === 1 ? '' : 's'}.
    </p>

    <details style="margin-bottom:20px;">
      <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--color-muted);">
        Uploads archive (${uploads.length})
      </summary>
      <div style="margin-top:8px;">
        ${renderUploadsArchive(uploads)}
      </div>
    </details>

    ${renderFilterBar()}

    ${renderBulkEnrichBar(properties)}

    <div class="row" style="margin:12px 0;justify-content:space-between;">
      <div id="property-count" class="muted small"></div>
      <div class="row" style="gap:16px;">
        <a href="#" id="export-csv" class="small">Download CSV</a>
        <a href="#" id="clear-filters" class="small">Clear filters</a>
      </div>
    </div>

    <div id="property-list"></div>
  `
}

// ─── Bulk enrichment bar (only shown when there's work to do) ──────────────

function isEnriched(p) {
  // "Enriched" means we've attempted it AND have usable coordinates (so it
  // can appear on the map). Pure-numeric neighborhood values are the old
  // assessor-code bug and don't count.
  const s = p.enrichmentSummary || {}
  if (!s.attemptedAt) return false
  if (s.latitude == null || s.longitude == null) return false
  if (s.neighborhood && /^\d+$/.test(String(s.neighborhood).trim())) return false
  return true
}

function renderBulkEnrichBar(properties) {
  const targets = properties.filter(p => p.parcelId || p.address)
  if (targets.length === 0) return ''
  const enriched = targets.filter(isEnriched).length
  const remaining = targets.length - enriched
  if (remaining === 0) {
    return `
      <div class="small muted" style="margin-top:8px;">
        All ${targets.length} properties enriched. <a href="#" id="bulk-enrich-btn">Re-run anyway</a>
      </div>
    `
  }
  const minutes = Math.max(1, Math.ceil((remaining * 0.4) / 60))
  return `
    <div class="card" id="bulk-enrich-card" style="margin-top:12px;background:#fff7ed;border-color:#fed7aa;">
      <strong>Enrich properties for map coordinates, neighborhood + Hilltop tagging</strong>
      <p class="small" style="margin:4px 0;">
        ${remaining} of ${targets.length} properties haven't been enriched yet.
        Fetches assessor data (fair-market value, year built) countywide, plus
        neighborhood + condemnation data and map coordinates. Free, takes ~${minutes} minute${minutes === 1 ? '' : 's'}.
      </p>
      <button class="primary" id="bulk-enrich-btn">Enrich ${remaining} properties</button>
    </div>
  `
}

async function runBulkEnrich(el, properties) {
  const card = el.querySelector('#bulk-enrich-card')
  if (!card) return

  card.innerHTML = `
    <strong>Enriching properties…</strong>
    <div id="bulk-status" class="small" style="margin:6px 0;">Starting…</div>
    <div class="progress" style="margin:6px 0;"><div id="bulk-bar" style="width:0%"></div></div>
    <button id="bulk-cancel">Cancel</button>
  `
  el.querySelector('#bulk-cancel').addEventListener('click', () => {
    cancelBulkEnrichment()
    el.querySelector('#bulk-status').textContent = 'Cancelling…'
  })

  const statusEl = el.querySelector('#bulk-status')
  const barEl = el.querySelector('#bulk-bar')

  try {
    await enrichAllProperties((info) => {
      const pct = info.total > 0 ? Math.round((info.processed / info.total) * 100) : 0
      barEl.style.width = `${pct}%`
      if (info.status === 'running') {
        const addr = info.currentAddress ? escapeHtml(info.currentAddress.slice(0, 60)) : ''
        const nh = info.neighborhood ? ` — <em>${escapeHtml(info.neighborhood)}</em>` : ''
        statusEl.innerHTML =
          `Enriching ${info.processed + 1} of ${info.total} • ` +
          `${info.hilltopSoFar} Hilltop so far${info.errors > 0 ? ` • ${info.errors} errors` : ''}<br>` +
          `<span class="muted">${addr}${nh}</span>`
      } else if (info.status === 'cancelled') {
        statusEl.innerHTML = `<strong>Cancelled</strong> after ${info.processed} of ${info.total} properties. Click the button again later to resume.`
      } else if (info.status === 'done') {
        statusEl.innerHTML =
          `<strong>Done.</strong> Enriched ${info.processed} properties • ` +
          `${info.hilltopSoFar} flagged as Hilltop${info.errors > 0 ? ` • ${info.errors} errors` : ''}.`
      }
    })
  } catch (e) {
    // Surface the error instead of freezing on "Starting…".
    console.error('[bulk] enrichment crashed:', e)
    statusEl.innerHTML = `<span style="color:var(--color-err);"><strong>Enrichment failed:</strong> ${escapeHtml(String(e?.message || e))}</span>`
    return
  }

  // Re-render the home view so the new neighborhood data shows up everywhere.
  setTimeout(() => renderHome(el), 1500)
}

function renderUploadsArchive(uploads) {
  const byMonth = new Map()
  for (const u of uploads) {
    const m = u.saleMonth || 'Unknown'
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(u)
  }
  const months = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))
  return months.map(month => {
    const label = month === 'Unknown' ? 'Unknown month' : formatMonth(month)
    const cards = byMonth.get(month).map(u => {
      const parsedBadge = u.parsed
        ? `<span class="indicator present">parsed</span>`
        : u.lastParsedAt
          ? `<span class="indicator absent">partially parsed</span>`
          : `<span class="indicator absent">not parsed</span>`
      const reparseLabel = u.lastParsedAt ? 'Re-parse' : 'Parse'
      return `
        <div class="card">
          <div class="row" style="justify-content:space-between;">
            <div class="row">
              <span class="tag ${u.type}">${u.type}</span>
              <strong>${escapeHtml(u.filename)}</strong>
              ${parsedBadge}
            </div>
            <a href="#/upload/${encodeURIComponent(u.id)}" class="small">${reparseLabel}</a>
          </div>
          <div class="meta">
            ${u.pageCount} page${u.pageCount === 1 ? '' : 's'} •
            ${formatBytes(u.size)} •
            uploaded ${formatDate(u.uploadedAt)}
          </div>
        </div>
      `
    }).join('')
    return `<h3 class="muted small" style="margin:12px 0 6px 0;">${escapeHtml(label)}</h3>${cards}`
  }).join('')
}

// ─── Filter bar ────────────────────────────────────────────────────────────

function renderFilterBar() {
  const sortOpts = SORT_OPTIONS.map(o =>
    `<option value="${escapeAttr(o.key)}" ${state.sort === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('')

  const statusChips = STATUS_OPTIONS.map(o =>
    chip('status', o.key, o.label, state.statuses.has(o.key))
  ).join('')
  const flagChips = FLAG_OPTIONS.map(o =>
    chip('flag', o.key, o.label, state.flags.has(o.key))
  ).join('')

  return `
    <div class="filter-bar">
      <div class="row" style="gap:8px;align-items:center;">
        <input type="search" id="search-input" placeholder="Search address, case, defendant, parcel…"
               value="${escapeAttr(state.search)}"
               style="flex:1;min-width:240px;max-width:none;" />
        <label class="small muted" for="sort-select">Sort:</label>
        <select id="sort-select" style="width:auto;">${sortOpts}</select>
      </div>

      <div class="filter-row">
        <span class="filter-label">Status:</span>
        ${statusChips}
      </div>

      <div class="filter-row">
        <span class="filter-label">Flag:</span>
        ${flagChips}
      </div>

      <div class="filter-row">
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="needs-review-toggle" ${state.needsReviewOnly ? 'checked' : ''} />
          Only show "needs review"
        </label>
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-left:16px;"
               title="Hilltop neighborhoods: ${escapeAttr(HILLTOP_LIST_LABEL.join(', '))}">
          <input type="checkbox" id="hilltop-toggle" ${state.hilltopOnly ? 'checked' : ''} />
          Hilltop only
        </label>
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-left:16px;"
               title="From the Pittsburgh PLI condemned/dead-end property list. Pittsburgh only.">
          <input type="checkbox" id="condemned-toggle" ${state.condemnedOnly ? 'checked' : ''} />
          Condemned only
        </label>
      </div>
    </div>
  `
}

function chip(group, key, label, active) {
  return `
    <button type="button" class="chip ${active ? 'active' : ''}"
            data-filter-group="${escapeAttr(group)}" data-filter-key="${escapeAttr(key)}">
      ${escapeHtml(label)}
    </button>
  `
}

// ─── Wire interactivity ────────────────────────────────────────────────────

function wireControls(el, properties) {
  el.querySelector('#search-input').addEventListener('input', (e) => {
    state.search = e.target.value
    renderPropertyList(el, properties)
  })

  el.querySelector('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value
    renderPropertyList(el, properties)
  })

  el.querySelector('#needs-review-toggle').addEventListener('change', (e) => {
    state.needsReviewOnly = e.target.checked
    renderPropertyList(el, properties)
  })

  el.querySelector('#hilltop-toggle').addEventListener('change', (e) => {
    state.hilltopOnly = e.target.checked
    renderPropertyList(el, properties)
  })

  el.querySelector('#condemned-toggle').addEventListener('change', (e) => {
    state.condemnedOnly = e.target.checked
    renderPropertyList(el, properties)
  })

  const bulkBtn = el.querySelector('#bulk-enrich-btn')
  if (bulkBtn) {
    bulkBtn.addEventListener('click', () => runBulkEnrich(el, properties))
  }

  el.querySelectorAll('.chip').forEach(chipEl => {
    chipEl.addEventListener('click', () => {
      const group = chipEl.dataset.filterGroup
      const key = chipEl.dataset.filterKey
      const targetSet = group === 'status' ? state.statuses : state.flags
      if (targetSet.has(key)) targetSet.delete(key)
      else targetSet.add(key)
      chipEl.classList.toggle('active')
      renderPropertyList(el, properties)
    })
  })

  el.querySelector('#clear-filters').addEventListener('click', (e) => {
    e.preventDefault()
    state.search = ''
    state.sort = 'sale-month'
    state.statuses = new Set(['active', 'postponed', 'stayed', 'sold'])
    state.flags = new Set(['interested', 'skip', 'unflagged'])
    state.needsReviewOnly = false
    // Full re-render to reset all the controls.
    renderHome(el)
  })

  el.querySelector('#export-csv').addEventListener('click', (e) => {
    e.preventDefault()
    const sorted = applySort(applyFilters(properties))
    const csv = propertiesToCsv(sorted)
    const summary = currentFilterSummary()
    downloadCsv(csv, exportFilename({ filterSummary: summary }))
  })
}

/**
 * Compact slug describing the active filter state, used in the export
 * filename. Empty string when no filters are applied so the filename
 * stays clean for "everything" exports.
 */
function currentFilterSummary() {
  const parts = []
  if (state.search) parts.push(state.search.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30))
  if (state.statuses.size < STATUS_OPTIONS.length) {
    parts.push([...state.statuses].sort().join('+'))
  }
  if (state.flags.size < FLAG_OPTIONS.length) {
    parts.push('flag-' + [...state.flags].sort().join('+'))
  }
  if (state.needsReviewOnly) parts.push('needs-review')
  if (state.hilltopOnly) parts.push('hilltop')
  if (state.condemnedOnly) parts.push('condemned')
  return parts.join('-').slice(0, 60)
}

// ─── Filter + sort + render the property list ──────────────────────────────

function renderPropertyList(el, allProperties) {
  const visible = applyFilters(allProperties)
  const sorted = applySort(visible)

  el.querySelector('#property-count').textContent =
    `Showing ${sorted.length} of ${allProperties.length} propert${allProperties.length === 1 ? 'y' : 'ies'}`

  const listEl = el.querySelector('#property-list')
  if (sorted.length === 0) {
    listEl.innerHTML = `
      <div class="banner info">No properties match your filters.
        <a href="#" id="empty-clear">Clear filters</a> to see all ${allProperties.length}.
      </div>
    `
    listEl.querySelector('#empty-clear').addEventListener('click', (e) => {
      e.preventDefault()
      el.querySelector('#clear-filters').click()
    })
    return
  }

  if (state.sort === 'sale-month') {
    listEl.innerHTML = renderGroupedByMonth(sorted)
  } else {
    listEl.innerHTML = sorted.map(p => renderPropertyCard(p, p.history[0] || {})).join('')
  }
}

function applyFilters(properties) {
  const q = state.search.trim().toLowerCase()
  return properties.filter(p => {
    // Substring search across multiple text fields
    if (q) {
      const hay = [p.address, p.caseNumber, p.defendant, p.parcelId, p.municipality, p.plaintiff]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }

    // Status filter — match against CURRENT status (most recent history entry)
    const status = String(p.history[0]?.status || '').toLowerCase()
    const statusKey =
      /^active/.test(status)    ? 'active' :
      /^postponed/.test(status) ? 'postponed' :
      /^stayed/.test(status)    ? 'stayed' :
      /^sold/.test(status)      ? 'sold' : null
    if (statusKey && !state.statuses.has(statusKey)) return false
    if (!statusKey && state.statuses.size < STATUS_OPTIONS.length) {
      // Unknown status — only show if all status filters are on
      return false
    }

    // Flag filter
    const flag = p.userFields?.flag
    const flagKey = flag === 'interested' ? 'interested'
                  : flag === 'skip'       ? 'skip'
                  : 'unflagged'
    if (!state.flags.has(flagKey)) return false

    // Needs-review filter
    if (state.needsReviewOnly) {
      const v = validateProperty(p)
      if (v.ok) return false
    }

    // Hilltop filter
    if (state.hilltopOnly && !isHilltopProperty(p)) return false

    // Condemned filter
    if (state.condemnedOnly && !lookupCondemned(p)) return false

    return true
  })
}

/** Synchronous condemned lookup against the in-memory index. */
function lookupCondemned(prop) {
  const parid = normalizeParcelId(prop.parcelId)
  if (!parid) return null
  return getCondemnedInfoSync(parid)
}

function applySort(properties) {
  const sorted = [...properties]
  switch (state.sort) {
    case 'spread-desc':
      // Best deals first. Properties with unknown spread sort to the bottom
      // (use -Infinity so they're "smaller" than every known value).
      sorted.sort((a, b) => (getSpread(b) ?? -Infinity) - (getSpread(a) ?? -Infinity))
      break
    case 'bid-asc':
      sorted.sort((a, b) =>
        (a.history[0]?.openingBid ?? Number.POSITIVE_INFINITY) -
        (b.history[0]?.openingBid ?? Number.POSITIVE_INFINITY))
      break
    case 'bid-desc':
      sorted.sort((a, b) =>
        (b.history[0]?.openingBid ?? Number.NEGATIVE_INFINITY) -
        (a.history[0]?.openingBid ?? Number.NEGATIVE_INFINITY))
      break
    case 'status':
      sorted.sort((a, b) => statusRank(a.history[0]?.status) - statusRank(b.history[0]?.status))
      break
    case 'case':
      sorted.sort((a, b) => (a.caseNumber || '').localeCompare(b.caseNumber || ''))
      break
    case 'address':
      sorted.sort((a, b) => (a.address || '').localeCompare(b.address || ''))
      break
    case 'sale-month':
    default:
      sorted.sort((a, b) => {
        const ma = a.history[0]?.saleMonth || ''
        const mb = b.history[0]?.saleMonth || ''
        if (mb !== ma) return mb.localeCompare(ma)
        const sa = statusRank(a.history[0]?.status)
        const sb = statusRank(b.history[0]?.status)
        if (sa !== sb) return sa - sb
        return (b.history[0]?.openingBid ?? 0) - (a.history[0]?.openingBid ?? 0)
      })
  }
  return sorted
}

function renderGroupedByMonth(properties) {
  const byMonth = new Map()
  for (const p of properties) {
    const m = p.history[0]?.saleMonth || 'Unknown'
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(p)
  }
  const months = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))

  return months.map(month => {
    const label = month === 'Unknown' ? 'Unknown month' : formatMonth(month)
    const cards = byMonth.get(month)
      .map(p => renderPropertyCard(p, p.history[0] || {}))
      .join('')
    return `
      <h2>${escapeHtml(label)} <span class="muted small" style="font-weight:normal;">(${byMonth.get(month).length})</span></h2>
      ${cards}
    `
  }).join('')
}

// ─── Property card ─────────────────────────────────────────────────────────

function renderPropertyCard(prop, h) {
  const bid = h.openingBid != null
    ? `$${h.openingBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  const sold = h.soldFor != null
    ? ` • <strong>Sold for $${h.soldFor.toLocaleString()}</strong> to ${escapeHtml(h.soldTo || '?')}`
    : ''

  const liveValidation = validateProperty(prop)
  const condemned = lookupCondemned(prop)
  const flagsHtml = []
  if (condemned) {
    const tip = `Condemned/Dead End — ${condemned.inspectionStatus || '?'} • last inspection ${condemned.createDate || '?'}: ${condemned.latestInspectionResult || 'no result'}`
    flagsHtml.push(`<span class="tag" style="background:#991b1b;color:white;border-color:#7f1d1d;font-weight:600;" title="${escapeAttr(tip)}">CONDEMNED</span>`)
  }
  if (!liveValidation.ok) {
    flagsHtml.push(`<span class="tag" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;" title="${escapeHtml(liveValidation.issues.join('; '))}">needs review</span>`)
  }
  if (prop.userFields?.flag === 'interested') {
    flagsHtml.push(`<span class="tag" style="background:#d1fae5;color:#065f46;border-color:#a7f3d0;">interested</span>`)
  }
  if (prop.userFields?.flag === 'skip') {
    flagsHtml.push(`<span class="tag" style="background:#e5e7eb;color:#374151;border-color:#d1d5db;">skip</span>`)
  }
  if (isHilltopProperty(prop)) {
    const nh = prop.enrichmentSummary?.neighborhood || 'Hilltop'
    flagsHtml.push(`<span class="tag" style="background:#fed7aa;color:#9a3412;border-color:#fdba74;" title="${escapeAttr(nh)}">Hilltop</span>`)
  }
  if (prop.commentsParsed?.replenishmentUnpaid) {
    flagsHtml.push(`<span class="tag" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;">replenishment unpaid</span>`)
  }
  if ((prop.commentsParsed?.bankruptcyHistory || []).length > 0) {
    flagsHtml.push(`<span class="tag" style="background:#fef3c7;color:#b45309;border-color:#fde68a;">bankruptcy</span>`)
  }
  if (prop.tracts > 1) {
    flagsHtml.push(`<span class="tag">${prop.tracts} tracts</span>`)
  }

  const spread = getSpread(prop)
  const spreadHtml = spread != null ? (() => {
    const color = spread >= 0 ? 'var(--color-ok)' : 'var(--color-err)'
    const sign = spread >= 0 ? '+' : '−'
    const abs = Math.abs(spread).toLocaleString(undefined, { maximumFractionDigits: 0 })
    const source = prop.userFields?.arvOverride != null ? 'your ARV' : 'WPRDC FMV'
    return `<div class="meta">Spread: <strong style="color:${color}">${sign}$${abs}</strong> <span class="muted">(${source} − opening bid)</span></div>`
  })() : ''

  return `
    <a class="card prop-card" href="#/property/${encodeURIComponent(prop.caseNumber)}">
      <div class="row" style="justify-content:space-between;">
        <div>
          <strong>${escapeHtml(prop.address || '(no address)')}</strong>
          <span class="muted small"> — ${escapeHtml(prop.municipality || '')}</span>
        </div>
        <div class="row">${flagsHtml.join('')}</div>
      </div>
      <div class="meta">
        Case ${escapeHtml(prop.caseNumber)} •
        Parcel ${escapeHtml(prop.parcelId || '?')} •
        Opening bid <strong>${bid}</strong>${sold}
      </div>
      <div class="meta">
        Status: ${escapeHtml(h.status || '?')}
      </div>
      ${spreadHtml}
    </a>
  `
}

function statusRank(status) {
  if (!status) return 99
  const s = status.toLowerCase()
  if (s.startsWith('sold')) return 0
  if (s.startsWith('active')) return 1
  if (s.startsWith('postponed')) return 2
  if (s.startsWith('stayed')) return 3
  return 50
}

/**
 * ARV − opening bid. ARV is the user's override if set, else the WPRDC
 * fair-market value from bulk enrichment. Returns null if either side is
 * unknown — caller should treat null as "no spread to show / sort to bottom."
 */
function getSpread(p) {
  const bid = p.history[0]?.openingBid
  const arv = p.userFields?.arvOverride ?? p.enrichmentSummary?.fairMarketValue ?? null
  if (bid == null || arv == null) return null
  return arv - bid
}

function isHumanReadableNeighborhood(name) {
  if (!name) return false
  // Old bug stored assessor codes like "13001" or "11102" — pure digits
  // aren't real Pittsburgh neighborhood names.
  return !/^\d+$/.test(String(name).trim())
}
