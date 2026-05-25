/**
 * Convert a Sheriff's-Sale-style parcel ID to the WPRDC PARID format.
 *
 * Sheriff PDFs print parcel IDs like:
 *   "556-G-276"        →  "0556G00276000000"
 *   "0033-B-00272"     →  "0033B00272000000"
 *   "1269-D-75"        →  "1269D00075000000"
 *   "131-H-244"        →  "0131H00244000000"
 *
 * The WPRDC `PARID` column uses a 16-char fixed-width format:
 *   [4-digit district][1-letter map][5-digit lot][6-digit sub-parcel]
 * For ordinary parcels, the 6-char sub-parcel suffix is "000000".
 *
 * Defensive cleanup:
 *   - Strips common label prefixes ("Parcel/Tax ID:", "PARID:", etc.) that
 *     can leak into the value when PDF parsing grabs the column header along
 *     with the cell content.
 *   - Strips all whitespace.
 *   - Uppercases.
 *
 * If the input is ALREADY in the 16-char no-separator form, we pass it
 * through unchanged. If it can't be parsed, we return null and the caller
 * surfaces a clear error to the user (rather than fetching a bogus PARID).
 *
 * @param {string} raw - parcel ID as printed in the Sheriff PDF
 * @returns {string|null} normalized 16-char PARID, or null
 */
export function normalizeParcelId(raw) {
  if (!raw) return null

  // Strip common label prefixes that PDF extraction sometimes glues onto
  // the value. Examples seen in the wild:
  //   "Parcel/Tax ID: 556-G-276"
  //   "PARID: 0033B00272000000"
  //   "Parcel: 131-H-244"
  const cleaned = String(raw)
    .replace(/^\s*(?:parcel(?:\s*\/\s*tax)?\s*(?:id|#|number)?|parid)\s*:?\s*/i, '')
    .toUpperCase()
    .replace(/\s+/g, '')

  // Already normalized (16-char alphanumeric, no separators)
  if (/^[0-9A-Z]{16}$/.test(cleaned)) return cleaned

  // Standard 3-segment Sheriff format: digits-letter-digits[-digits]
  // Accept 1–4 digit prefix, 1 letter, 1–5 digit lot, optional 1–6 digit sub.
  let m = cleaned.match(/^(\d{1,4})-?([A-Z])-?(\d{1,5})(?:-?(\d{1,6}))?$/)
  if (m) {
    const [, prefix, letter, lot, sub = ''] = m
    return (
      prefix.padStart(4, '0') +
      letter +
      lot.padStart(5, '0') +
      sub.padStart(6, '0')
    )
  }

  // 4-segment "double-letter" format sometimes seen on condos / PUDs:
  //   "234-K-100-1"  → 0234K0010000001 (?)  — best-guess: middle letter is the
  //   primary map letter; the second letter is a sub-parcel discriminator that
  //   we can't reliably encode without seeing a counter-example in WPRDC. So
  //   we strip the second letter and treat it as a 3-segment + sub.
  m = cleaned.match(/^(\d{1,4})-?([A-Z])-?[A-Z]-?(\d{1,5})(?:-?(\d{1,6}))?$/)
  if (m) {
    const [, prefix, letter, lot, sub = ''] = m
    return (
      prefix.padStart(4, '0') +
      letter +
      lot.padStart(5, '0') +
      sub.padStart(6, '0')
    )
  }

  return null
}
