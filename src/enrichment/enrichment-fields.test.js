/**
 * Unit tests for the four new valuation enrichment fields. Run with:
 *     node src/enrichment/enrichment-fields.test.js
 *
 * Covers the PURE pieces (no network / no IndexedDB):
 *   - assessorFields: combineBaths / extractSizeFields (Part A)
 *   - violationsSummary: summarizeViolations (Part B)
 *   - pointInPolygon: the shared QOZ/neighborhood geometry test (Part C)
 *   - income: parseZipFromAddress (Part D)
 *   - normalize: violations-style PARID passes through unchanged
 */
import assert from 'node:assert/strict'
import { combineBaths, extractSizeFields } from './assessorFields.js'
import { summarizeViolations } from './violationsSummary.js'
import { pointInFeature } from './pointInPolygon.js'
import { parseZipFromAddress } from './income.js'
import { normalizeParcelId } from './normalize.js'

let passed = 0
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('enrichment-fields')

// ── Part A: bathrooms = full + 0.5×half ──────────────────────────────────────
test('combineBaths: 2 full + 1 half = 2.5', () => {
  assert.equal(combineBaths(2, 1), 2.5)
})
test('combineBaths: full only', () => {
  assert.equal(combineBaths(1, 0), 1)
  assert.equal(combineBaths(3, null), 3)
})
test('combineBaths: half only', () => {
  assert.equal(combineBaths(0, 1), 0.5)
})
test('combineBaths: nothing recorded → null (not 0)', () => {
  assert.equal(combineBaths(0, 0), null)
  assert.equal(combineBaths(null, null), null)
  assert.equal(combineBaths('', ''), null)
})
test('extractSizeFields: residential record', () => {
  const r = { FINISHEDLIVINGAREA: 1686, BEDROOMS: 4, FULLBATHS: 2, HALFBATHS: 0 }
  assert.deepEqual(extractSizeFields(r),
    { squareFeet: 1686, bedrooms: 4, bathrooms: 2, fullBaths: 2, halfBaths: 0 })
})
test('extractSizeFields: vacant/commercial blanks → null', () => {
  const r = { FINISHEDLIVINGAREA: 0, BEDROOMS: 0, FULLBATHS: 0, HALFBATHS: 0 }
  assert.deepEqual(extractSizeFields(r),
    { squareFeet: null, bedrooms: null, bathrooms: null, fullBaths: 0, halfBaths: 0 })
})
test('extractSizeFields: null record → all null', () => {
  assert.deepEqual(extractSizeFields(null),
    { squareFeet: null, bedrooms: null, bathrooms: null, fullBaths: null, halfBaths: null })
})

// ── Part B: violation risk summary ───────────────────────────────────────────
const NOW = Date.parse('2026-06-13')

test('summarizeViolations: empty → all zero', () => {
  assert.deepEqual(summarizeViolations([]), { total: 0, open: 0, recent: 0, headline: 0, detail: [] })
  assert.deepEqual(summarizeViolations(null), { total: 0, open: 0, recent: 0, headline: 0, detail: [] })
})

test('summarizeViolations: counts CASEFILES not rows', () => {
  // Mirror the real Carrick parcel: 5 casefiles spread across many rows.
  const rows = [
    { casefile_number: 'CF-1', case_file_type: 'Unpermitted Electrical Work', status: 'Closed', investigation_date: '2024-03-26' },
    { casefile_number: 'CF-1', case_file_type: 'Unpermitted Electrical Work', status: 'Closed', investigation_date: '2024-06-10' },
    { casefile_number: 'CF-2', case_file_type: 'High Grass', status: 'In Court', investigation_date: '2025-09-01' },
    { casefile_number: 'CF-3', case_file_type: 'Refuse', status: 'Closed', investigation_date: '2015-01-01' },
  ]
  const s = summarizeViolations(rows, { now: NOW })
  assert.equal(s.total, 3)                 // 3 distinct casefiles, not 4 rows
  assert.equal(s.open, 1)                  // CF-2 "In Court"
  assert.equal(s.recent, 2)                // CF-1 (2024) + CF-2 (2025) within 3y
  assert.equal(s.headline, 2)              // open OR recent = CF-1, CF-2
})

test('summarizeViolations: open casefile sorts first + label fallback', () => {
  const rows = [
    { casefile_number: 'CF-OLD', violation_description: null, case_file_type: 'Refuse', status: 'Closed', investigation_date: '2016-01-01' },
    { casefile_number: 'CF-OPEN', violation_description: 'Structure unsafe', status: 'Open', investigation_date: '2026-01-01' },
  ]
  const s = summarizeViolations(rows, { now: NOW })
  assert.equal(s.detail[0].casefile, 'CF-OPEN')
  assert.equal(s.detail[0].label, 'Structure unsafe')      // prefers description
  assert.equal(s.detail[1].label, 'Refuse')                // falls back to type
})

test('summarizeViolations: old closed-only → headline 0 but total > 0', () => {
  const rows = [{ casefile_number: 'CF-X', case_file_type: 'Refuse', status: 'Closed', investigation_date: '2014-01-01' }]
  const s = summarizeViolations(rows, { now: NOW })
  assert.equal(s.total, 1)
  assert.equal(s.headline, 0)   // not open, not recent
})

// ── Part C: point-in-polygon (shared geometry) ───────────────────────────────
const SQUARE = {
  type: 'Feature',
  properties: { geoid: '42003TEST' },
  geometry: { type: 'Polygon', coordinates: [[[-80, 40], [-79, 40], [-79, 41], [-80, 41], [-80, 40]]] },
}
test('pointInFeature: inside / outside', () => {
  assert.equal(pointInFeature(40.5, -79.5, SQUARE), true)
  assert.equal(pointInFeature(42.0, -79.5, SQUARE), false)
})

// ── Part D: ZIP parsing from the address string ──────────────────────────────
test('parseZipFromAddress: takes the trailing ZIP', () => {
  assert.equal(parseZipFromAddress('148 MADELINE ST, PITTSBURGH, PA 15210'), '15210')
})
test('parseZipFromAddress: ignores a 5-digit street number', () => {
  assert.equal(parseZipFromAddress('10000 FRANKSTOWN RD, PITTSBURGH, PA 15235'), '15235')
})
test('parseZipFromAddress: ZIP+4 keeps the 5-digit ZIP', () => {
  assert.equal(parseZipFromAddress('1 MAIN ST, MUNHALL, PA 15120-1234'), '15120')
})
test('parseZipFromAddress: no zip → null', () => {
  assert.equal(parseZipFromAddress('SOMEWHERE, PA'), null)
  assert.equal(parseZipFromAddress(null), null)
})

// ── normalize: violations carry already-PARID parcel ids ─────────────────────
test('normalizeParcelId: 16-char violations PARID passes through', () => {
  assert.equal(normalizeParcelId('0095D00083000000'), '0095D00083000000')
  // and the Sheriff form for the same kind of parcel still normalizes:
  assert.equal(normalizeParcelId('95-D-83'), '0095D00083000000')
})

console.log(`\n${passed} passed`)
