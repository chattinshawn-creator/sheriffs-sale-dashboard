/**
 * Unit tests for classify.js. Run with:
 *     node src/pdf/classify.test.js
 */
import assert from 'node:assert/strict'
import { caseCategory, saleReadiness, isSoldProperty, serviceStateForProperty } from './classify.js'

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

test('a SOLD property has no readiness (SOLD supersedes READY)', () => {
  // newest entry = the sale; older listing still has the OK box checked.
  assert.equal(
    saleReadiness(prop(
      { saleMonth: '2026-06', outcomeCategory: 'sold_third_party', soldFor: 30000 },
      { saleMonth: '2026-06', serviceOk: true, serviceCheckedCount: 4 },
    )),
    null,
  )
})

// ── serviceStateForProperty (per-box) ───────────────────────────────────────
test('derives ok + count from a per-box array (Svs/3129.2/3129.3/OK, 3 checked)', () => {
  const boxes = [
    { label: 'Svs', checked: true },
    { label: '3129.2', checked: true },
    { label: '3129.3', checked: false },
    { label: 'OK', checked: true },
  ]
  const s = serviceStateForProperty(prop({ saleMonth: '2025-11', serviceBoxes: boxes }))
  assert.equal(s.serviceCheckedCount, 3)
  assert.equal(s.serviceOk, true)
  assert.equal(s.serviceBoxes.length, 4)
})

test('readiness is "ready" from a boxes-only entry with OK checked', () => {
  const boxes = [
    { label: 'Svs', checked: true },
    { label: '3129.2', checked: true },
    { label: 'OK', checked: true },
  ]
  assert.equal(saleReadiness(prop({ serviceBoxes: boxes })), 'ready')
})

test('readiness is "in_progress" when boxes are checked but OK is not', () => {
  const boxes = [
    { label: 'Svs', checked: true },
    { label: 'OK', checked: false },
  ]
  assert.equal(saleReadiness(prop({ serviceBoxes: boxes })), 'in_progress')
})

// ── isSoldProperty ───────────────────────────────────────────────────────────
test('isSoldProperty reads the current outcome', () => {
  assert.equal(isSoldProperty(prop({ outcomeCategory: 'sold_third_party' })), true)
  assert.equal(isSoldProperty(prop({ outcomeCategory: 'plaintiff_overbid' })), true)
  assert.equal(isSoldProperty(prop({ outcomeCategory: 'money_made' })), true)
  assert.equal(isSoldProperty(prop({ outcomeCategory: 'postponed' })), false)
  assert.equal(isSoldProperty(prop({ status: 'Sold' })), true)   // back-compat via raw status
  assert.equal(isSoldProperty(prop({ status: 'Active' })), false)
  assert.equal(isSoldProperty(prop()), false)
})

console.log(`\n${passed} passed`)
