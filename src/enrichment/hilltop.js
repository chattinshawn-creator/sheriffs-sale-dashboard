/**
 * Hilltop neighborhood detection for Pittsburgh properties.
 *
 * The "Hilltop" is a loose term for the cluster of Pittsburgh neighborhoods
 * south of the Monongahela River and adjacent to Mt. Oliver Borough.
 * Shawn (Carrick Community Council) defines the list below.
 *
 * Neighborhood names come from the WPRDC assessor's `NEIGHDESC` field,
 * which is populated for every parcel inside Pittsburgh city limits.
 * For properties outside Pittsburgh, NEIGHDESC isn't meaningful, so this
 * always returns false.
 */

// Canonical (normalized) list of Hilltop neighborhood names.
// Matching is normalize-and-prefix so variants like "Mt. Oliver Neighborhood"
// or "Mount Oliver" both match "mount oliver".
const HILLTOP_NEIGHBORHOODS = [
  'allentown',
  'arlington',
  'beltzhoover',
  'bon air',
  'carrick',
  'knoxville',
  'mount oliver',
  'st clair',
  'hays',
  'lincoln place',
  'south side slopes',
  'mount washington',
  'duquesne heights',
]

/**
 * Normalize a neighborhood name for comparison:
 *  - lowercase
 *  - strip dots/commas
 *  - "Mt" → "Mount", "Saint" → "St", "Southside" → "South Side"
 *  - collapse whitespace
 */
function normalize(s) {
  if (!s) return ''
  return String(s)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmt\b/g, 'mount')
    .replace(/\bsouthside\b/g, 'south side')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True if the given neighborhood name (typically WPRDC NEIGHDESC) matches
 * one of the Hilltop neighborhoods. Returns false for null/empty input.
 *
 * Uses prefix matching so e.g. "Mount Oliver Neighborhood" matches the
 * canonical "mount oliver" entry.
 */
export function isHilltopNeighborhood(name) {
  if (!name) return false
  const n = normalize(name)
  return HILLTOP_NEIGHBORHOODS.some(h => n === h || n.startsWith(h + ' '))
}

/**
 * Pittsburgh wards whose neighborhoods are predominantly Hilltop.
 * Confirmed by Shawn (Carrick Community Council).
 *
 * NOTE: this list is intentionally conservative. With the GeoJSON +
 * geocoder fallback in place, nearly every Pittsburgh property gets a
 * real neighborhood name and this ward heuristic almost never fires.
 * When it does, false positives hurt more than false negatives.
 *
 * Wards intentionally excluded:
 *   - 19: actually Brookline / Beechview (NOT Hilltop)
 *   - 20: mostly Crafton Heights / Westwood / Sheraden
 *   - 31: covers Lincoln Place / Hays (which ARE Hilltop), but also spans
 *     non-Hilltop areas. Properties in Lincoln Place / Hays get caught by
 *     the precise neighborhood-name lookup instead.
 */
const HILLTOP_WARDS = new Set(['16', '17', '18', '29', '30', '32'])

/**
 * True if the property is in a Hilltop neighborhood. Prefers the precise
 * neighborhood name (from violations/permits) when available, falls back to
 * the ward number (from assessor's MUNIDESC) when not.
 */
export function isHilltopProperty(prop) {
  const nh = prop?.enrichmentSummary?.neighborhood
  if (isHilltopNeighborhood(nh)) return true
  // Fallback: ward-based — catches Pittsburgh properties with no PLI history.
  const ward = prop?.enrichmentSummary?.ward
  if (ward && HILLTOP_WARDS.has(String(ward))) return true
  return false
}

export { HILLTOP_WARDS }

/** Exposed for UI labeling / tooltips. */
export const HILLTOP_LIST_LABEL = [
  'Allentown', 'Arlington', 'Beltzhoover', 'Bon Air', 'Carrick',
  'Knoxville', 'Mt. Oliver Neighborhood', 'St. Clair', 'Hays',
  'Lincoln Place', 'South Side Slopes', 'Mt. Washington', 'Duquesne Heights',
]
