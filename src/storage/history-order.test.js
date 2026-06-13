/**
 * Unit tests for history-order.js. Run with:
 *     node src/storage/history-order.test.js
 */
import assert from 'node:assert/strict'
import { compareHistoryEntries } from './history-order.js'

let passed = 0
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('history-order.js')

// Helper: sort a copy and return the saleMonth/uploadType of the first entry.
const firstOf = (...entries) => [...entries].sort(compareHistoryEntries)[0]

test('newer month sorts first', () => {
  const f = firstOf(
    { saleMonth: '2026-05', uploadType: 'results' },
    { saleMonth: '2026-06', uploadType: 'listings' },
  )
  assert.equal(f.saleMonth, '2026-06')
})

test('same month: results outranks listings regardless of input order', () => {
  const listing = { saleMonth: '2026-06', uploadType: 'listings', uploadedAt: 200 }
  const result  = { saleMonth: '2026-06', uploadType: 'results',  uploadedAt: 100 }
  // results wins even though it was uploaded earlier
  assert.equal(firstOf(listing, result).uploadType, 'results')
  assert.equal(firstOf(result, listing).uploadType, 'results')
})

test('same month: an untagged (legacy) entry outranks a tagged listing', () => {
  // The real scenario: results entry written before uploadType existed (legacy,
  // rank 0) vs a freshly re-parsed listings entry (rank 1). Results must win so
  // a sold property doesn\'t revert to its pre-sale listing status.
  const legacyResult = { saleMonth: '2026-06' } // no uploadType
  const newListing   = { saleMonth: '2026-06', uploadType: 'listings', uploadedAt: 999 }
  assert.equal(firstOf(legacyResult, newListing).uploadType, undefined)
})

test('same month, same type: later upload time wins', () => {
  const older = { saleMonth: '2026-06', uploadType: 'results', uploadedAt: 100 }
  const newer = { saleMonth: '2026-06', uploadType: 'results', uploadedAt: 500 }
  assert.equal(firstOf(older, newer).uploadedAt, 500)
})

test('comparator is a valid (antisymmetric) ordering', () => {
  const a = { saleMonth: '2026-06', uploadType: 'results', uploadedAt: 100 }
  const b = { saleMonth: '2026-06', uploadType: 'listings', uploadedAt: 200 }
  assert.equal(Math.sign(compareHistoryEntries(a, b)), -Math.sign(compareHistoryEntries(b, a)))
})

console.log(`\n${passed} passed`)
