/**
 * The collapsible "Property score" controls panel: one slider per factor (with
 * a live effective-weight %), the distance reference-point box, and preset
 * save / load / delete / reset. Self-contained — it owns its own DOM, persists
 * changes to the settings store, and calls back `onChange(activePreset)` so the
 * host view can recompute + re-render scores instantly.
 *
 * Kept separate from home.js so the Home view only gains a mount call and a
 * score badge, not a second screen's worth of logic.
 */
import { FACTORS } from './factors.js'
import { effectiveWeights } from './score.js'
import {
  saveValuationState, activePreset, defaultWeights, DEFAULT_PRESET_NAME,
} from './presets.js'
import { resolveReferencePoint } from './zipCentroids.js'
import { escapeHtml, escapeAttr } from '../ui/format.js'

/**
 * Mount (or re-mount) the panel into `panelEl`.
 * @param {HTMLElement} panelEl  a container the panel fully owns
 * @param {object} state         the valuation state (mutated in place + saved)
 * @param {(activePreset:object)=>void} onChange  called after every change
 */
export function mountScorePanel(panelEl, state, onChange) {
  panelEl.innerHTML = renderControls(state)
  wire(panelEl, state, onChange)
  refreshRefStatus(panelEl)
}

function renderControls(state) {
  const preset = activePreset(state)
  const names = Object.keys(state.presets)
  const presetOpts = names.map(n =>
    `<option value="${escapeAttr(n)}" ${n === state.activeName ? 'selected' : ''}>${escapeHtml(n)}</option>`
  ).join('')

  const eff = effectiveWeights(preset.weights)
  const sliders = FACTORS.map(f => {
    const w = preset.weights[f.key] ?? 0
    const pct = eff._total > 0 ? (eff[f.key] * 100) : 0
    return `
      <div class="score-slider" data-factor-row="${escapeAttr(f.key)}">
        <div class="row" style="justify-content:space-between;align-items:baseline;">
          <label for="w-${escapeAttr(f.key)}" style="font-weight:500;">${escapeHtml(f.label)}</label>
          <span class="weight-pct muted small" data-pct="${escapeAttr(f.key)}">${fmtPct(pct, w)}</span>
        </div>
        <input type="range" id="w-${escapeAttr(f.key)}" min="0" max="100" step="1"
               value="${w}" data-weight="${escapeAttr(f.key)}" style="width:100%;" />
        <div class="muted small">${escapeHtml(f.hint)}</div>
      </div>
    `
  }).join('')

  return `
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
      <label class="small muted" for="preset-select">Preset:</label>
      <select id="preset-select" style="width:auto;">${presetOpts}</select>
      <input id="preset-name" placeholder="New preset name" style="width:auto;min-width:160px;" />
      <button id="preset-saveas" class="small">Save as new</button>
      <button id="preset-delete" class="small" ${state.activeName === DEFAULT_PRESET_NAME ? 'disabled title="The Default preset can\'t be deleted"' : ''}>Delete</button>
      <button id="preset-reset" class="small">Reset to defaults</button>
      <span id="preset-saved" class="hint"></span>
    </div>

    <div class="field" style="max-width:420px;">
      <label for="ref-point">Distance reference point (ZIP or lat,long)</label>
      <input id="ref-point" value="${escapeAttr(preset.refPoint || '')}"
             placeholder="e.g. 15210  or  40.44,-79.98" />
      <span class="hint" id="ref-point-status"></span>
    </div>

    <p class="muted small" style="margin:10px 0 6px;">
      Drag a slider to change how much each factor matters. Weights are relative —
      the percentages always add to 100%. A slider at 0 turns that factor off.
      Each factor is scored against the other properties in the same sale month.
    </p>

    <div class="score-sliders" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;">
      ${sliders}
    </div>
  `
}

function wire(panelEl, state, onChange) {
  let saveTimer = null
  const persist = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveValuationState(state), 250)
  }
  const flashSaved = () => {
    const n = panelEl.querySelector('#preset-saved')
    if (!n) return
    n.textContent = '✓ Saved'
    n.style.color = 'var(--color-ok)'
    setTimeout(() => { n.textContent = '' }, 1000)
  }

  // Sliders — live update of weights + all percentages, recompute, persist.
  panelEl.querySelectorAll('input[data-weight]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.weight
      const preset = activePreset(state)
      preset.weights[key] = Number(input.value)
      updateAllPercentages(panelEl, preset.weights)
      onChange(preset)
      persist()
    })
  })

  // Reference point — re-resolve status, recompute, persist.
  const refInput = panelEl.querySelector('#ref-point')
  refInput.addEventListener('input', () => {
    const preset = activePreset(state)
    preset.refPoint = refInput.value
    refreshRefStatus(panelEl)
    onChange(preset)
    persist()
  })

  // Preset select — switch active, re-render the controls, recompute.
  panelEl.querySelector('#preset-select').addEventListener('change', (e) => {
    state.activeName = e.target.value
    saveValuationState(state)
    mountScorePanel(panelEl, state, onChange)
    onChange(activePreset(state))
  })

  // Save as new — copy current weights+refPoint under a new name.
  panelEl.querySelector('#preset-saveas').addEventListener('click', () => {
    const nameEl = panelEl.querySelector('#preset-name')
    const name = (nameEl.value || '').trim()
    if (!name) { nameEl.focus(); return }
    const src = activePreset(state)
    state.presets[name] = {
      weights: { ...src.weights },
      refPoint: src.refPoint || '',
    }
    state.activeName = name
    saveValuationState(state)
    mountScorePanel(panelEl, state, onChange)
    onChange(activePreset(state))
  })

  // Delete — remove the active preset (never Default), fall back to Default.
  panelEl.querySelector('#preset-delete').addEventListener('click', () => {
    if (state.activeName === DEFAULT_PRESET_NAME) return
    if (!confirm(`Delete the "${state.activeName}" preset?`)) return
    delete state.presets[state.activeName]
    state.activeName = DEFAULT_PRESET_NAME
    saveValuationState(state)
    mountScorePanel(panelEl, state, onChange)
    onChange(activePreset(state))
  })

  // Reset — restore the active preset's sliders to the default weights.
  panelEl.querySelector('#preset-reset').addEventListener('click', () => {
    const preset = activePreset(state)
    preset.weights = defaultWeights()
    saveValuationState(state)
    mountScorePanel(panelEl, state, onChange)
    onChange(preset)
    flashSaved()
  })
}

/** Recompute and rewrite every factor's effective-weight % from `weights`. */
function updateAllPercentages(panelEl, weights) {
  const eff = effectiveWeights(weights)
  for (const f of FACTORS) {
    const span = panelEl.querySelector(`[data-pct="${cssEscape(f.key)}"]`)
    if (span) span.textContent = fmtPct(eff._total > 0 ? eff[f.key] * 100 : 0, weights[f.key])
  }
}

/** Update the "resolved / not found" hint under the reference-point box. */
function refreshRefStatus(panelEl) {
  const input = panelEl.querySelector('#ref-point')
  const status = panelEl.querySelector('#ref-point-status')
  if (!input || !status) return
  const text = input.value.trim()
  if (!text) {
    status.textContent = 'Not set — the distance factor scores neutral for every property until you enter one.'
    status.style.color = 'var(--color-muted)'
    return
  }
  const resolved = resolveReferencePoint(text)
  if (resolved) {
    status.textContent = `✓ Using ${resolved.label} (${resolved.lat.toFixed(4)}, ${resolved.lng.toFixed(4)})`
    status.style.color = 'var(--color-ok)'
  } else {
    status.textContent = "Couldn't read that — enter a 5-digit Allegheny ZIP or a lat,long pair like 40.44,-79.98."
    status.style.color = 'var(--color-err)'
  }
}

function fmtPct(pct, weight) {
  if (!weight || weight <= 0) return 'off'
  return `${(Math.round(pct * 10) / 10).toFixed(1)}%`
}

/** Minimal CSS.escape fallback for our factor keys (all [a-zA-Z]). */
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}
