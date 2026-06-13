import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { listProperties } from '../storage/properties.js'
import { validateProperty } from '../pdf/validation.js'
import { isHilltopProperty } from '../enrichment/hilltop.js'
import { loadCondemnedIndex, getCondemnedInfoSync } from '../enrichment/condemned.js'
import { normalizeParcelId } from '../enrichment/normalize.js'
import { caseCategory, saleReadiness, isSoldProperty, CASE_CATEGORY_META, READINESS_META } from '../pdf/classify.js'
import { escapeHtml, escapeAttr } from '../ui/format.js'

// Map state — separate from Home filter state so they don't fight each other.
const state = {
  statuses: new Set(['active', 'postponed', 'stayed', 'sold']),
  flags: new Set(['interested', 'skip', 'unflagged']),
  caseTypes: new Set(['mortgage', 'tax_other']),
  readiness: new Set(['ready', 'in_progress', 'not_started']),
  hilltopOnly: false,
  condemnedOnly: false,
  showHilltopOverlay: false,
}

const CASE_OPTIONS = [
  { key: 'mortgage',  label: CASE_CATEGORY_META.mortgage.label },
  { key: 'tax_other', label: CASE_CATEGORY_META.tax_other.label },
]
const READINESS_OPTIONS = [
  { key: 'ready',       label: READINESS_META.ready.label },
  { key: 'in_progress', label: READINESS_META.in_progress.label },
  { key: 'not_started', label: READINESS_META.not_started.label },
]

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

const STATUS_COLOR = {
  active:    '#dc2626',  // red
  postponed: '#f59e0b',  // amber
  stayed:    '#6b7280',  // grey
  sold:      '#2563eb',  // blue
  unknown:   '#9ca3af',  // muted grey
}

// Pittsburgh-ish initial view. Wide enough to show outlying boroughs too.
const INITIAL_CENTER = [40.4406, -79.9959]
const INITIAL_ZOOM = 11

let _map = null
let _markerLayer = null
let _hilltopOverlay = null

export async function renderMap(el) {
  const [properties] = await Promise.all([
    listProperties(),
    loadCondemnedIndex().catch(() => null),
  ])

  el.innerHTML = renderShell(properties)
  wireControls(el, properties)
  initMap(el)
  drawMarkers(properties)
}

function renderShell(properties) {
  const withCoords = properties.filter(hasCoords).length
  const missing = properties.length - withCoords

  const statusChips = STATUS_OPTIONS.map(o =>
    chip('status', o.key, o.label, state.statuses.has(o.key))).join('')
  const flagChips = FLAG_OPTIONS.map(o =>
    chip('flag', o.key, o.label, state.flags.has(o.key))).join('')
  const caseChips = CASE_OPTIONS.map(o =>
    chip('case', o.key, o.label, state.caseTypes.has(o.key))).join('')
  const readinessChips = READINESS_OPTIONS.map(o =>
    chip('readiness', o.key, o.label, state.readiness.has(o.key))).join('')

  return `
    <h1 style="margin-bottom:4px;">Map</h1>
    <p class="muted small" style="margin-top:0;">
      ${withCoords} of ${properties.length} properties have coordinates and appear on the map.
      ${missing > 0 ? `${missing} missing — re-run "Enrich Pittsburgh properties" on Home to backfill coordinates.` : ''}
    </p>

    <div class="filter-bar" style="margin-bottom:12px;">
      <div class="filter-row">
        <span class="filter-label">Status:</span>
        ${statusChips}
      </div>
      <div class="filter-row">
        <span class="filter-label">Flag:</span>
        ${flagChips}
      </div>
      <div class="filter-row">
        <span class="filter-label">Case type:</span>
        ${caseChips}
      </div>
      <div class="filter-row">
        <span class="filter-label" title="Read from the service-of-notice checkboxes. 'Ready' = OK box checked.">Readiness:</span>
        ${readinessChips}
      </div>
      <div class="filter-row">
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="map-hilltop" ${state.hilltopOnly ? 'checked' : ''} />
          Hilltop only
        </label>
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-left:16px;">
          <input type="checkbox" id="map-condemned" ${state.condemnedOnly ? 'checked' : ''} />
          Condemned only
        </label>
        <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-left:16px;">
          <input type="checkbox" id="map-overlay" ${state.showHilltopOverlay ? 'checked' : ''} />
          Show Hilltop neighborhood overlay
        </label>
      </div>
    </div>

    <div id="map-container" style="height:70vh; min-height:480px; border:1px solid var(--color-border); border-radius:6px; overflow:hidden;"></div>

    <div class="row" style="margin-top:8px;justify-content:space-between;font-size:13px;">
      <div id="map-count" class="muted"></div>
      <div class="row" style="gap:12px;">
        ${legendDot(STATUS_COLOR.active, 'Active')}
        ${legendDot(STATUS_COLOR.postponed, 'Postponed')}
        ${legendDot(STATUS_COLOR.stayed, 'Stayed')}
        ${legendDot(STATUS_COLOR.sold, 'Sold')}
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

function legendDot(color, label) {
  return `<span class="muted" style="display:inline-flex;align-items:center;gap:4px;">
    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};border:1px solid rgba(0,0,0,0.2);"></span>
    ${escapeHtml(label)}
  </span>`
}

function wireControls(el, properties) {
  el.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      const group = c.dataset.filterGroup
      const key = c.dataset.filterKey
      const target = {
        status: state.statuses,
        flag: state.flags,
        case: state.caseTypes,
        readiness: state.readiness,
      }[group]
      if (target.has(key)) target.delete(key)
      else target.add(key)
      c.classList.toggle('active')
      drawMarkers(properties)
    })
  })
  el.querySelector('#map-hilltop').addEventListener('change', e => {
    state.hilltopOnly = e.target.checked
    drawMarkers(properties)
  })
  el.querySelector('#map-condemned').addEventListener('change', e => {
    state.condemnedOnly = e.target.checked
    drawMarkers(properties)
  })
  el.querySelector('#map-overlay').addEventListener('change', e => {
    state.showHilltopOverlay = e.target.checked
    toggleHilltopOverlay()
  })
}

function initMap(el) {
  // Destroy any previous map instance (navigating away and back).
  if (_map) {
    _map.remove()
    _map = null
  }
  _map = L.map(el.querySelector('#map-container'), {
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
  })
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(_map)
  _markerLayer = L.layerGroup().addTo(_map)
}

function drawMarkers(properties) {
  if (!_markerLayer) return
  _markerLayer.clearLayers()

  const filtered = properties.filter(p => hasCoords(p) && passesFilters(p))
  document.getElementById('map-count').textContent =
    `Showing ${filtered.length} markers`

  for (const p of filtered) {
    const status = statusKey(p)
    const color = STATUS_COLOR[status] || STATUS_COLOR.unknown
    const condemned = lookupCondemned(p)
    const marker = L.circleMarker(
      [p.enrichmentSummary.latitude, p.enrichmentSummary.longitude],
      {
        radius: condemned ? 7 : 5,
        weight: condemned ? 2 : 1,
        color: condemned ? '#7f1d1d' : '#1f2937',
        fillColor: color,
        fillOpacity: 0.85,
      }
    )
    marker.bindPopup(popupHtml(p, status, condemned))
    _markerLayer.addLayer(marker)
  }
}

function popupHtml(p, status, condemned) {
  const flag = p.userFields?.flag
  const flagTag = flag === 'interested'
    ? '<span class="tag" style="background:#d1fae5;color:#065f46;">interested</span>'
    : flag === 'skip'
      ? '<span class="tag">skip</span>'
      : ''
  const tags = []
  if (condemned) tags.push('<span class="tag" style="background:#991b1b;color:white;">CONDEMNED</span>')
  if (isHilltopProperty(p)) tags.push('<span class="tag" style="background:#fed7aa;color:#9a3412;">Hilltop</span>')
  if (isSoldProperty(p)) {
    const amt = p.history[0]?.soldFor != null ? ` $${p.history[0].soldFor.toLocaleString()}` : ''
    tags.push(`<span class="tag" style="background:#dbeafe;color:#1e40af;">SOLD${amt}</span>`)
  }
  const readyKey = saleReadiness(p)
  if (readyKey) {
    const rs = { ready: 'background:#d1fae5;color:#065f46;', in_progress: 'background:#fef3c7;color:#b45309;', not_started: 'background:#e5e7eb;color:#374151;' }
    tags.push(`<span class="tag" style="${rs[readyKey]}">${escapeHtml(READINESS_META[readyKey].label)}</span>`)
  }
  const caseKey = caseCategory(p.caseNumber)
  if (caseKey) tags.push(`<span class="tag">${escapeHtml(CASE_CATEGORY_META[caseKey].label)}</span>`)
  if (flagTag) tags.push(flagTag)

  const bid = p.history[0]?.openingBid != null
    ? '$' + p.history[0].openingBid.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : '—'

  return `
    <div style="font-size:13px;min-width:220px;">
      <div style="font-weight:600;">${escapeHtml(p.address || '(no address)')}</div>
      <div class="muted small">${escapeHtml(p.municipality || '')}</div>
      <div style="margin-top:6px;">${tags.join(' ')}</div>
      <div style="margin-top:6px;">
        Case ${escapeHtml(p.caseNumber)}<br>
        Opening bid <strong>${bid}</strong><br>
        Status: ${escapeHtml(p.history[0]?.status || '?')}
      </div>
      <div style="margin-top:8px;">
        <a href="#/property/${encodeURIComponent(p.caseNumber)}">Open property page →</a>
      </div>
    </div>
  `
}

async function toggleHilltopOverlay() {
  if (!_map) return
  if (state.showHilltopOverlay) {
    if (_hilltopOverlay) {
      _hilltopOverlay.addTo(_map)
    } else {
      try {
        const url = `${import.meta.env.BASE_URL}neighborhoods.geojson`
        const data = await (await fetch(url)).json()
        const { HILLTOP_LIST_LABEL } = await import('../enrichment/hilltop.js')
        const hilltopSet = new Set(HILLTOP_LIST_LABEL.map(s => s.toLowerCase().replace(/[.,]/g, '').replace(/\bmt\b/g, 'mount')))
        _hilltopOverlay = L.geoJSON(data, {
          filter: f => {
            const h = String(f?.properties?.hood || '').toLowerCase().replace(/[.,]/g, '').replace(/\bmt\b/g, 'mount')
            return hilltopSet.has(h) || [...hilltopSet].some(c => h.startsWith(c))
          },
          style: {
            color: '#9a3412', weight: 1, fillColor: '#fed7aa', fillOpacity: 0.25,
          },
        }).addTo(_map)
      } catch (e) {
        console.warn('[map] Hilltop overlay failed:', e)
      }
    }
  } else if (_hilltopOverlay) {
    _map.removeLayer(_hilltopOverlay)
  }
}

// ─── Filter helpers ────────────────────────────────────────────────────────

function hasCoords(p) {
  const lat = p.enrichmentSummary?.latitude
  const lng = p.enrichmentSummary?.longitude
  return Number.isFinite(lat) && Number.isFinite(lng)
}

function statusKey(p) {
  const s = String(p.history[0]?.status || '').toLowerCase()
  if (s.startsWith('active'))    return 'active'
  if (s.startsWith('postponed')) return 'postponed'
  if (s.startsWith('stayed'))    return 'stayed'
  if (s.startsWith('sold'))      return 'sold'
  return 'unknown'
}

function passesFilters(p) {
  const sk = statusKey(p)
  if (sk !== 'unknown' && !state.statuses.has(sk)) return false

  const flag = p.userFields?.flag
  const fk = flag === 'interested' ? 'interested' : flag === 'skip' ? 'skip' : 'unflagged'
  if (!state.flags.has(fk)) return false

  const caseKey = caseCategory(p.caseNumber)
  if (caseKey && !state.caseTypes.has(caseKey)) return false

  const readyKey = saleReadiness(p)
  if (readyKey && !state.readiness.has(readyKey)) return false
  if (!readyKey && state.readiness.size < READINESS_OPTIONS.length) return false

  if (state.hilltopOnly && !isHilltopProperty(p)) return false
  if (state.condemnedOnly && !lookupCondemned(p)) return false

  return true
}

function lookupCondemned(prop) {
  const parid = normalizeParcelId(prop.parcelId)
  if (!parid) return null
  return getCondemnedInfoSync(parid)
}
