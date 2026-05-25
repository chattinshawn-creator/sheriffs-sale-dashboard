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
 * If the input is ALREADY in the 16-char no-separator form, we pass it
 * through unchanged. If it can't be parsed, we return null and the caller
 * surfaces a clear error to the user (rather than fetching a bogus PARID).
 *
 * @param {string} raw - parcel ID as printed in the Sheriff PDF
 * @returns {string|null} normalized 16-char PARID, or null
 */
export function normalizeParcelId(raw) {
  if (!raw) return null
  const cleaned = String(raw).toUpperCase().replace(/\s+/g, '')

  // Already normalized (16-char alphanumeric, no separators)
  if (/^[0-9A-Z]{16}$/.test(cleaned)) return cleaned

  // Standard Sheriff format: digits-letter-digits[-digits]
  // Accept 1–4 digit prefix, 1 letter, 1–5 digit lot, optional 1–6 digit sub.
  const m = cleaned.match(/^(\d{1,4})-?([A-Z])-?(\d{1,5})(?:-?(\d{1,6}))?$/)
  if (!m) return null

  const [, prefix, letter, lot, sub = ''] = m
  return (
    prefix.padStart(4, '0') +
    letter +
    lot.padStart(5, '0') +
    sub.padStart(6, '0')
  )
}
