/**
 * Persistence for the valuation tool's slider presets + active selection.
 * Lives in the same IndexedDB `settings` store the rest of the app's settings
 * use, under one key, so it survives reloads and rides along with the existing
 * single-user model.
 *
 * Shape stored under VALUATION_KEY:
 *   {
 *     activeName: string,
 *     presets: { [name]: { weights: {factorKey:0-100}, refPoint: string } }
 *   }
 * `refPoint` is the raw text the user typed (a ZIP or "lat,lng") — resolving it
 * to coordinates is the view's job (see zipCentroids.js).
 */
import { stores, get, set } from '../storage/db.js'
import { FACTORS } from './factors.js'

const VALUATION_KEY = 'valuation-state'
export const DEFAULT_PRESET_NAME = 'Default'

/** Default weights: every factor on at equal weight (relative, so each ~12.5%).
 *  A sensible neutral starting point the user re-weights from. */
export function defaultWeights() {
  const w = {}
  for (const f of FACTORS) w[f.key] = 50
  return w
}

function defaultState() {
  return {
    activeName: DEFAULT_PRESET_NAME,
    presets: {
      [DEFAULT_PRESET_NAME]: { weights: defaultWeights(), refPoint: '' },
    },
  }
}

/** Load the full valuation state, healing any missing/partial structure so the
 *  caller always gets a usable active preset. */
export async function loadValuationState() {
  const raw = await get(VALUATION_KEY, stores.settings)
  if (!raw || typeof raw !== 'object' || !raw.presets) return defaultState()
  // Ensure the active name points at a real preset; ensure Default exists.
  const state = {
    activeName: raw.activeName,
    presets: { ...raw.presets },
  }
  if (!state.presets[DEFAULT_PRESET_NAME]) {
    state.presets[DEFAULT_PRESET_NAME] = { weights: defaultWeights(), refPoint: '' }
  }
  if (!state.presets[state.activeName]) state.activeName = DEFAULT_PRESET_NAME
  // Backfill any newly-added factor keys onto every preset so old saved presets
  // don't leave a new slider undefined.
  for (const name of Object.keys(state.presets)) {
    const p = state.presets[name]
    p.weights = { ...defaultWeights(), ...(p.weights || {}) }
    if (typeof p.refPoint !== 'string') p.refPoint = ''
  }
  return state
}

export async function saveValuationState(state) {
  await set(VALUATION_KEY, state, stores.settings)
  return state
}

/** Convenience: the currently-active preset's weights + refPoint. */
export function activePreset(state) {
  return state.presets[state.activeName] || state.presets[DEFAULT_PRESET_NAME]
}
