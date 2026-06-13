/**
 * Unit tests for outcome.js. No test framework — runnable with plain Node:
 *
 *     node src/pdf/outcome.test.js
 *
 * Exits non-zero on the first failure so it can gate a future CI step.
 */
import assert from 'node:assert/strict'
import {
  deriveOutcomeCategory,
  parseStatusAmount,
  statusBucketFor,
  SALE_CATEGORIES,
} from './outcome.js'

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('outcome.js')

// ── deriveOutcomeCategory ──────────────────────────────────────────────────
test('Third Party → sold_third_party', () => {
  assert.equal(deriveOutcomeCategory('Third Party - $12,500'), 'sold_third_party')
  assert.equal(deriveOutcomeCategory('THIRD PARTY - $1'), 'sold_third_party')
})

test('PLTF Overbid → plaintiff_overbid', () => {
  assert.equal(deriveOutcomeCategory('PLTF Overbid - $9,001.50'), 'plaintiff_overbid')
  assert.equal(deriveOutcomeCategory('Plaintiff Overbid - $5'), 'plaintiff_overbid')
})

test('PLTF Cost and PLTF Cost & Tax → plaintiff_cost', () => {
  assert.equal(deriveOutcomeCategory('PLTF Cost - $8,104.17'), 'plaintiff_cost')
  assert.equal(deriveOutcomeCategory('PLTF Cost & Tax - $8,104.17'), 'plaintiff_cost')
})

test('Money Made → money_made', () => {
  assert.equal(deriveOutcomeCategory('Money Made'), 'money_made')
  assert.equal(deriveOutcomeCategory('Money Made - $40,000'), 'money_made')
})

test('Postponed variants → postponed', () => {
  assert.equal(deriveOutcomeCategory('Postponed to 7/6/2026'), 'postponed')
  assert.equal(deriveOutcomeCategory('Postponed (Waived) to 8/3/2026'), 'postponed')
  assert.equal(deriveOutcomeCategory('PP Generally'), 'postponed')
  assert.equal(deriveOutcomeCategory('PP'), 'postponed')
})

test('Stayed → stayed', () => {
  assert.equal(deriveOutcomeCategory('Stayed'), 'stayed')
  assert.equal(deriveOutcomeCategory('STAYED ON 5/22/26'), 'stayed')
})

test('Active / blank / unknown → other', () => {
  assert.equal(deriveOutcomeCategory('Active'), 'other')
  assert.equal(deriveOutcomeCategory(''), 'other')
  assert.equal(deriveOutcomeCategory(null), 'other')
  assert.equal(deriveOutcomeCategory(undefined), 'other')
  assert.equal(deriveOutcomeCategory('Continued indefinitely'), 'other')
})

test('Unicode dash and extra whitespace are tolerated', () => {
  assert.equal(deriveOutcomeCategory('Third Party – $12,500'), 'sold_third_party')
  assert.equal(deriveOutcomeCategory('   PLTF   Overbid - $5  '), 'plaintiff_overbid')
})

// ── parseStatusAmount ──────────────────────────────────────────────────────
test('parses dollar amounts with commas and decimals', () => {
  assert.equal(parseStatusAmount('Third Party - $12,500'), 12500)
  assert.equal(parseStatusAmount('PLTF Cost & Tax - $8,104.17'), 8104.17)
  assert.equal(parseStatusAmount('Third Party - $1'), 1)
})

test('returns null when no amount present', () => {
  assert.equal(parseStatusAmount('Money Made'), null)
  assert.equal(parseStatusAmount('Stayed'), null)
  assert.equal(parseStatusAmount(null), null)
})

// ── statusBucketFor ────────────────────────────────────────────────────────
test('sale categories all map to the sold bucket', () => {
  for (const c of ['sold_third_party', 'plaintiff_overbid', 'plaintiff_cost', 'money_made']) {
    assert.equal(statusBucketFor(c, 'whatever'), 'sold')
  }
})

test('postponed/stayed categories map straight through', () => {
  assert.equal(statusBucketFor('postponed', 'Postponed to 7/6/2026'), 'postponed')
  assert.equal(statusBucketFor('stayed', 'Stayed'), 'stayed')
})

test('other/undefined falls back to raw-status classification (back-compat)', () => {
  assert.equal(statusBucketFor('other', 'Active'), 'active')
  assert.equal(statusBucketFor(undefined, 'Postponed to 7/6/2026'), 'postponed')
  assert.equal(statusBucketFor(undefined, 'Sold'), 'sold')
  assert.equal(statusBucketFor(undefined, 'Stayed'), 'stayed')
  assert.equal(statusBucketFor('other', 'Gibberish'), null)
})

// ── invariants ─────────────────────────────────────────────────────────────
test('SALE_CATEGORIES holds exactly the three priced outcomes', () => {
  assert.deepEqual(
    [...SALE_CATEGORIES].sort(),
    ['plaintiff_cost', 'plaintiff_overbid', 'sold_third_party'],
  )
})

console.log(`\n${passed} passed`)
