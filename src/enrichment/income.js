/**
 * ZIP-code median household income lookup, county-wide.
 *
 * Powers the valuation tool's "median income" factor. Source is the U.S.
 * Census American Community Survey (ACS) 5-year, table B19013 (median
 * household income), by ZCTA (ZIP Code Tabulation Area — the Census's
 * polygon approximation of a USPS ZIP).
 *
 * We BUNDLE a tiny `zip → median income` JSON (~100 Allegheny ZIPs) rather
 * than calling the Census API at runtime: it's small, static, and avoids a
 * network dependency. Refresh it by re-running scripts/build-zip-income.mjs
 * when a new ACS vintage drops. The file header records the table + year +
 * pull date. See README "Bundled data vintages".
 *
 * The app never stores a standalone ZIP field — the ZIP lives inside the
 * address string ("STREET, CITY, PA ZIP") — so we parse it out here.
 *
 * Returns null (not 0) when the ZIP can't be parsed or isn't in the table,
 * so the valuation tool treats it as neutral.
 */

let _mapPromise = null
let _map = null
let _meta = null

/**
 * Parse the 5-digit ZIP from a Sheriff-format address. The ZIP is the LAST
 * 5-digit group in "STREET, CITY, PA ZIP" — taking the last one avoids
 * matching a 5-digit street number at the start.
 *
 * @param {string} address
 * @returns {string|null}
 */
export function parseZipFromAddress(address) {
  if (!address) return null
  const groups = String(address).match(/\b\d{5}\b/g)
  if (!groups || groups.length === 0) return null
  return groups[groups.length - 1]
}

/**
 * Load + cache the bundled ZIP→income table. If the file is missing (e.g. it
 * hasn't been built yet) we resolve to an empty map so lookups return null
 * rather than throwing — enrichment still completes, income is just neutral.
 */
export function loadIncomeIndex() {
  if (_mapPromise) return _mapPromise
  const url = `${import.meta.env.BASE_URL}zip_median_income.json`
  _mapPromise = fetch(url)
    .then(r => {
      if (!r.ok) {
        // Not built yet / not deployed — treat as "no data", not an error.
        _map = {}
        return _map
      }
      return r.json().then(json => {
        _map = json?.data || {}
        _meta = { table: json?._table, year: json?._year, pulled: json?._pulled, source: json?._source }
        return _map
      })
    })
    .catch(() => {
      _map = {} // network failure → neutral, never blocks enrichment
      return _map
    })
  return _mapPromise
}

/** Median income for a ZIP string, or null. Caller must have loaded the index. */
export function getZipMedianIncomeSync(zip) {
  if (!_map || !zip) return null
  const v = _map[String(zip)]
  return Number.isFinite(Number(v)) ? Number(v) : null
}

/** Async convenience: parse ZIP from an address, await the index, look it up. */
export async function getZipMedianIncome(address) {
  await loadIncomeIndex()
  return getZipMedianIncomeSync(parseZipFromAddress(address))
}

/** Bundled-file provenance (table/year/pull date), once loaded. */
export function getIncomeMeta() {
  return _meta
}
