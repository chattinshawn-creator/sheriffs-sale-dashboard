/**
 * Unit tests for trends/aggregate.js. Run with:
 *     node src/trends/aggregate.test.js
 */
import assert from 'node:assert/strict'
import {
  extractSales, median, summarize, groupBy, buildBreakdown, distinctMonths,
} from './aggregate.js'

let passed = 0
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('trends/aggregate.js')

// A small fixture covering the cases that matter.
const properties = [
  {
    caseNumber: 'GD-1', municipality: 'Pittsburgh', isPittsburghProper: true,
    saleType: 'Real Estate Sale - Municipal Lien',
    enrichmentSummary: { neighborhood: 'Carrick' },
    history: [
      { saleMonth: '2026-06', outcomeCategory: 'sold_third_party', soldFor: 30000 },
      { saleMonth: '2026-05', outcomeCategory: 'postponed', soldFor: null },
    ],
  },
  {
    caseNumber: 'GD-2', municipality: 'Pittsburgh', isPittsburghProper: true,
    enrichmentSummary: { neighborhood: 'Carrick' },
    history: [{ saleMonth: '2026-06', outcomeCategory: 'plaintiff_overbid', soldFor: 50000 }],
  },
  {
    caseNumber: 'GD-3', municipality: 'Penn Hills', isPittsburghProper: false,
    enrichmentSummary: {},
    history: [{ saleMonth: '2026-06', outcomeCategory: 'sold_third_party', soldFor: 10000 }],
  },
  {
    caseNumber: 'GD-4', municipality: 'Pittsburgh', isPittsburghProper: true,
    enrichmentSummary: { neighborhood: 'Carrick' },
    // money_made is NOT a priced sale category → excluded
    history: [{ saleMonth: '2026-06', outcomeCategory: 'money_made', soldFor: 99999 }],
  },
  {
    caseNumber: 'GD-5', municipality: 'Pittsburgh', isPittsburghProper: true,
    enrichmentSummary: { neighborhood: 'Carrick' },
    // sale category but soldFor missing → excluded
    history: [{ saleMonth: '2026-06', outcomeCategory: 'sold_third_party', soldFor: null }],
  },
]

test('extractSales keeps only priced sale outcomes with numeric soldFor', () => {
  const sales = extractSales(properties)
  assert.equal(sales.length, 3) // GD-1, GD-2, GD-3
  const cases = sales.map(s => s.caseNumber).sort()
  assert.deepEqual(cases, ['GD-1', 'GD-2', 'GD-3'])
})

test('extractSales flags third-party as market, plaintiff as not', () => {
  const sales = extractSales(properties)
  assert.equal(sales.find(s => s.caseNumber === 'GD-1').isMarket, true)
  assert.equal(sales.find(s => s.caseNumber === 'GD-2').isMarket, false)
})

test('extractSales applies injected condemned/hilltop classifiers', () => {
  const sales = extractSales(properties, {
    isCondemned: p => p.caseNumber === 'GD-1',
    isHilltop: p => p.municipality === 'Pittsburgh',
  })
  assert.equal(sales.find(s => s.caseNumber === 'GD-1').condemned, true)
  assert.equal(sales.find(s => s.caseNumber === 'GD-3').condemned, false)
  assert.equal(sales.find(s => s.caseNumber === 'GD-3').hilltop, false)
})

test('median handles odd and even lengths', () => {
  assert.equal(median([10000]), 10000)
  assert.equal(median([10000, 30000, 50000]), 30000)
  assert.equal(median([10000, 30000]), 20000)
  assert.equal(median([]), null)
})

test('summarize reports count/median/min/max', () => {
  const s = summarize(extractSales(properties))
  assert.equal(s.count, 3)
  assert.equal(s.min, 10000)
  assert.equal(s.max, 50000)
  assert.equal(s.median, 30000)
})

test('groupBy skips null keys', () => {
  const sales = extractSales(properties)
  const g = groupBy(sales, s => s.neighborhood)
  assert.equal(g.has('Carrick'), true)
  assert.equal(g.get('Carrick').length, 2) // GD-1, GD-2
  assert.equal([...g.keys()].includes(null), false) // GD-3 has no neighborhood
})

test('buildBreakdown separates third-party from plaintiff', () => {
  const sales = extractSales(properties)
  const rows = buildBreakdown(sales, s => s.neighborhood)
  const carrick = rows.find(r => r.key === 'Carrick')
  assert.equal(carrick.total.count, 2)
  assert.equal(carrick.thirdParty.count, 1)
  assert.equal(carrick.thirdParty.median, 30000)
  assert.equal(carrick.plaintiff.count, 1)
  assert.equal(carrick.plaintiff.median, 50000)
})

test('distinctMonths counts unique sale months', () => {
  assert.equal(distinctMonths(extractSales(properties)), 1) // all sales in 2026-06
})

console.log(`\n${passed} passed`)
