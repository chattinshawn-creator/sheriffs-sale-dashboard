/**
 * Unit tests for classify.js. Run with:
 *     node src/pdf/classify.test.js
 */
import assert from 'node:assert/strict'
import { caseCategory, saleReadiness } from './classify.js'

let passed = 0
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('classify.js')

// ── caseCategory ─────────────────────────────────────────────────────────────
test('MG prefix → mortgage', () => {
  assert.equal(caseCategory('MG-14-000165'), 'mortgage')
  assert.equal(caseCategory('mg-22-000001'), 'mortgage')
})

test('GD and other prefixes → tax_other', () => {
  assert.equal(caseCategory('GD-16-022895'), 'tax_other')
  assert.equal(caseCategory('AR-19-000123'), 'tax_other')
  assert.equal(caseCategory('CV-20-000999'), 'tax_other')
})

test('missing case number → null', () => {
  assert.equal(caseCategory(null), null)
  assert.equal(caseCategory(''), null)
  assert.equal(caseCategory(undefined), null)
})

// ── saleReadiness (reads from property.history, newest-first) ───────────────
const prop = (...entries) => ({ history: entries })

test('OK box checked → ready (regardless of count)', () => {
  assert.equal(saleReadiness(prop({ serviceOk: true, serviceCheckedCount: 4 })), 'ready')
  assert.equal(saleReadiness(prop({ serviceOk: true, serviceCheckedCount: 1 })), 'ready')
})

test('some boxes but not OK → in_progress', () => {
  assert.equal(saleReadiness(prop({ serviceOk: false, serviceCheckedCount: 2 })), 'in_progress')
  assert.equal(saleReadiness(prop({ serviceOk: null, serviceCheckedCount: 1 })), 'in_progress')
})

test('zero boxes → not_started', () => {
  assert.equal(saleReadiness(prop({ serviceOk: false, serviceCheckedCount: 0 })), 'not_started')
})

test('unknown (no box data at all) → null', () => {
  assert.equal(saleReadiness(prop({ serviceOk: null, serviceCheckedCount: null })), null)
  assert.equal(saleReadiness(prop()), null)
  assert.equal(saleReadiness({}), null)
  assert.equal(saleReadiness(), null)
})

test('falls back to an older entry with box data when the newest has none', () => {
  // e.g. newest = results parse (no boxes), older = listings parse (has boxes)
  assert.equal(
    saleReadiness(prop(
      { saleMonth: '2026-06', serviceOk: null, serviceCheckedCount: null }, // results, newest
      { saleMonth: '2026-06', serviceOk: false, serviceCheckedCount: 2 },   // listings
    )),
    'in_progress',
  )
})

console.log(`\n${passed} passed`)
