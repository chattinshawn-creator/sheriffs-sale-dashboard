/**
 * Two small, pure classifiers derived from already-parsed property fields.
 * Both feed Home/Map filter chips and card badges. Kept dependency-free and
 * unit-tested (see classify.test.js).
 *
 *   1. caseCategory  — Mortgage (MG) vs Tax/Other (GD and everything else),
 *                      read straight from the case-number prefix. Works on
 *                      existing data with no re-parse.
 *
 *   2. saleReadiness — How ready a property is to actually go to sale, read
 *                      from the service-of-notice checkboxes:
 *                        ready        — the "OK" box is checked (cleared to sell)
 *                        in_progress  — some boxes checked, but not OK yet
 *                        not_started  — zero boxes checked (unlikely to sell soon)
 *                        null         — unknown (e.g. data parsed before this
 *                                       field existed). Requires a re-parse.
 */

// ── 1. Case category ─────────────────────────────────────────────────────────

export const CASE_CATEGORY_META = {
  mortgage:  { label: 'Mortgage',   hint: 'Mortgage foreclosure (MG)' },
  tax_other: { label: 'Tax / Other', hint: 'Tax/municipal lien or other (GD, etc.)' },
}

/**
 * @param {string|null|undefined} caseNumber e.g. "MG-14-000165", "GD-16-022895"
 * @returns {'mortgage'|'tax_other'|null}
 */
export function caseCategory(caseNumber) {
  if (!caseNumber) return null
  const prefix = String(caseNumber).trim().split('-')[0].toUpperCase()
  return prefix === 'MG' ? 'mortgage' : 'tax_other'
}

// ── 2. Sale readiness (from service checkboxes) ─────────────────────────────

export const READINESS_META = {
  ready:       { label: 'Ready',       hint: 'OK box checked — cleared to go to sale' },
  in_progress: { label: 'In progress', hint: 'Some service boxes checked, but not OK yet' },
  not_started: { label: 'Not started', hint: 'No service boxes checked — unlikely to sell soon' },
}

/**
 * Pick the service-box state to judge readiness by: the most recent history
 * entry that actually carries box data. Service info lives on the LISTINGS
 * sale, so this lets a later results parse (which has no meaningful box state)
 * sit on top without wiping the readiness the listings parse found.
 *
 * History is stored newest-first, so we take the first entry with data.
 *
 * @param {object} property - a canonical property with a history[] array
 * @returns {{ serviceOk: boolean|null, serviceCheckedCount: number|null }}
 */
export function serviceStateForProperty(property) {
  for (const h of (property?.history || [])) {
    if (h.serviceOk != null || typeof h.serviceCheckedCount === 'number') {
      return {
        serviceOk: h.serviceOk ?? null,
        serviceCheckedCount: typeof h.serviceCheckedCount === 'number' ? h.serviceCheckedCount : null,
      }
    }
  }
  return { serviceOk: null, serviceCheckedCount: null }
}

/**
 * @param {object} property - a canonical property with a history[] array
 * @returns {'ready'|'in_progress'|'not_started'|null}
 */
export function saleReadiness(property) {
  const { serviceOk, serviceCheckedCount } = serviceStateForProperty(property)
  if (serviceOk === true) return 'ready'
  if (typeof serviceCheckedCount === 'number') {
    return serviceCheckedCount > 0 ? 'in_progress' : 'not_started'
  }
  return null
}
