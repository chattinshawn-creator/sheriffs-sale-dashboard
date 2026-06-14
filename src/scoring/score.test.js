/**
 * Unit tests for the weighted valuation engine. Run with:
 *     node src/scoring/score.test.js
 *
 * Pure math only — no IndexedDB, no network. Builds tiny synthetic property
 * records carrying just the fields the factors read.
 */
import assert from 'node:assert/strict'
import { computeScores, effectiveWeights, buildValueMedians } from './score.js'
import {
  haversineMiles, postponementCount, estimatedValue, sizeSubScore, FACTORS,
} from './factors.js'

let passed = 0
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('scoring/score')

// Helper: a property in sale month 2026-06 with the given enrichment + bits.
function prop(caseNumber, { enrich = {}, openingBid = null, postponed = 0, muni = 'Pittsburgh', pgh = true } = {}) {
  const history = [{ saleMonth: '2026-06', openingBid, outcomeCategory: 'active' }]
  for (let i = 0; i < postponed; i++) history.push({ saleMonth: '2026-0' + (5 - i), outcomeCategory: 'postponed' })
  return {
    caseNumber,
    municipality: muni,
    isPittsburghProper: pgh,
    history,
    commentsParsed: { postponementHistory: [] },
    userFields: {},
    enrichmentSummary: enrich,
  }
}

// Weights helper: only the named factors on (others 0).
function onlyWeights(...keys) {
  const w = {}
  for (const f of FACTORS) w[f.key] = keys.includes(f.key) ? 100 : 0
  return w
}

// ── effectiveWeights ─────────────────────────────────────────────────────────
test('effectiveWeights: normalizes to sum 1', () => {
  const eff = effectiveWeights(onlyWeights('income', 'size'))
  assert.equal(Math.round((eff.income + eff.size) * 1000) / 1000, 1)
  assert.equal(eff.distance, 0)
})
test('effectiveWeights: all zero -> total 0, all fractions 0', () => {
  const eff = effectiveWeights(onlyWeights())
  assert.equal(eff._total, 0)
  assert.equal(eff.income, 0)
})

// ── min-max relative scaling (income, direction high) ────────────────────────
test('income: best in month = 100, worst = 0, middle interpolates', () => {
  const props = [
    prop('A', { enrich: { zipMedianIncome: 40000 } }),
    prop('B', { enrich: { zipMedianIncome: 60000 } }),
    prop('C', { enrich: { zipMedianIncome: 80000 } }),
  ]
  const r = computeScores(props, { weights: onlyWeights('income') })
  assert.equal(r.get('A').final, 1)   // lowest -> 0 -> floored to 1
  assert.equal(r.get('C').final, 100) // highest
  assert.equal(r.get('B').final, 50)  // midpoint
})

// ── direction low (postponement: fewer = higher) ─────────────────────────────
test('postponement: fewest postponements scores highest', () => {
  const props = [
    prop('A', { postponed: 0 }),
    prop('B', { postponed: 4 }),
  ]
  const r = computeScores(props, { weights: onlyWeights('postponement') })
  assert.equal(r.get('A').final, 100)
  assert.equal(r.get('B').final, 1)
})

// ── boolean (opportunity zone) ───────────────────────────────────────────────
test('opportunityZone: inside=100, outside=1(floored), null=50 flagged', () => {
  const props = [
    prop('IN', { enrich: { inOpportunityZone: true } }),
    prop('OUT', { enrich: { inOpportunityZone: false } }),
    prop('UNK', { enrich: { inOpportunityZone: null } }),
  ]
  const r = computeScores(props, { weights: onlyWeights('opportunityZone') })
  assert.equal(r.get('IN').final, 100)
  assert.equal(r.get('OUT').final, 1)
  assert.equal(r.get('UNK').final, 50)
  const unkFactor = r.get('UNK').factors.find(f => f.key === 'opportunityZone')
  assert.equal(unkFactor.estimated, true)
})

// ── categorical (lien type) ──────────────────────────────────────────────────
test('lienType: tax/other (GD) = 100, mortgage (MG) = 0->1', () => {
  const tax = prop('GD-16-1', {})
  const mortgage = prop('MG-16-1', {})
  const r = computeScores([tax, mortgage], { weights: onlyWeights('lienType') })
  assert.equal(r.get('GD-16-1').final, 100)
  assert.equal(r.get('MG-16-1').final, 1)
})

// ── missing data -> neutral 50, flagged ──────────────────────────────────────
test('missing factor data -> sub-score 50, estimated flag set', () => {
  const props = [prop('A', { enrich: {} })] // no codeViolations
  const r = computeScores(props, { weights: onlyWeights('risk') })
  const f = r.get('A').factors.find(x => x.key === 'risk')
  assert.equal(f.score, 50)
  assert.equal(f.estimated, true)
  assert.equal(r.get('A').anyEstimated, true)
})

// ── weight 0 turns a factor off (no influence on final) ──────────────────────
test('weight 0 excludes a factor from the final score', () => {
  const props = [
    prop('A', { enrich: { zipMedianIncome: 40000, inOpportunityZone: true } }),
    prop('B', { enrich: { zipMedianIncome: 80000, inOpportunityZone: false } }),
  ]
  // Only income weighted -> A (low income) loses despite being in an OZ.
  const r = computeScores(props, { weights: onlyWeights('income') })
  assert.ok(r.get('B').final > r.get('A').final)
})

// ── per-month isolation: a property is scaled within its own month ───────────
test('min-max is per sale-month, not across the whole archive', () => {
  const may = prop('MAY', { enrich: { zipMedianIncome: 100000 } })
  may.history[0].saleMonth = '2026-05'
  const juneLo = prop('JUNE_LO', { enrich: { zipMedianIncome: 30000 } })
  const juneHi = prop('JUNE_HI', { enrich: { zipMedianIncome: 50000 } })
  const r = computeScores([may, juneLo, juneHi], { weights: onlyWeights('income') })
  // May is alone in its month -> degenerate range -> neutral 50 (not 100),
  // proving it isn't pooled with June's lower incomes.
  assert.equal(r.get('MAY').final, 50)
  assert.equal(r.get('JUNE_HI').final, 100)
  assert.equal(r.get('JUNE_LO').final, 1)
})

// ── all-weights-zero -> final null ───────────────────────────────────────────
test('no factor weighted -> final is null', () => {
  const r = computeScores([prop('A', {})], { weights: onlyWeights() })
  assert.equal(r.get('A').final, null)
})

// ── price factor: value/cost ratio, FMV preferred ────────────────────────────
test('price: higher value-to-cost ratio scores higher', () => {
  const good = prop('GOOD', { enrich: { fairMarketValue: 200000 }, openingBid: 20000 }) // 10x
  const meh = prop('MEH', { enrich: { fairMarketValue: 120000 }, openingBid: 100000 })  // 1.2x
  const r = computeScores([good, meh], { weights: onlyWeights('price') })
  assert.equal(r.get('GOOD').final, 100)
  assert.equal(r.get('MEH').final, 1)
})

test('price: missing value AND cost -> neutral 50 flagged', () => {
  const r = computeScores([prop('A', { enrich: {} })], { weights: onlyWeights('price') })
  const f = r.get('A').factors.find(x => x.key === 'price')
  assert.equal(f.estimated, true)
})

// ── size: fixed diminishing-returns curve (NOT month-relative) ───────────────
test('sizeSubScore: matches the calibration anchors for real specs', () => {
  const round = v => Math.round(sizeSubScore(v))
  // {beds, baths, sqft} → expected sub-score from the anchor table.
  assert.equal(round({ beds: 2, baths: 1, sqft: 750 }), 10)   // tiny
  assert.equal(round({ beds: 3, baths: 1, sqft: 1250 }), 40)  // below average
  assert.equal(round({ beds: 4, baths: 2, sqft: 2000 }), 62)
  assert.equal(round({ beds: 4, baths: 4, sqft: 3500 }), 90)  // ideal rental
  assert.equal(round({ beds: 6, baths: 4, sqft: 5000 }), 96)  // bigger: gentle climb
  assert.equal(round({ beds: 0, baths: 0, sqft: 8000 }), 44)  // commercial: lands low
})

test('sizeSubScore: huge sqft with no beds/baths cannot top the curve', () => {
  // The bug the rework fixes: a warehouse riding square footage alone. Missing
  // beds/baths count as 0, so it stays mid-low, never near 100.
  assert.equal(Math.round(sizeSubScore({ sqft: 8000, beds: null, baths: null })), 44)
  assert.ok(sizeSubScore({ sqft: 8000, beds: null, baths: null }) <
            sizeSubScore({ beds: 4, baths: 4, sqft: 3500 }))
})

test('sizeSubScore: all three components absent → null (engine flags estimated)', () => {
  assert.equal(sizeSubScore({ sqft: null, beds: null, baths: null }), null)
  assert.equal(sizeSubScore(null), null)
})

test('size: is absolute, not month-relative (a lone property still scores on the curve)', () => {
  // Old min-max gave a single-property month a degenerate neutral 50. The fixed
  // curve gives it its true score regardless of what else is listed that month.
  const solo = prop('SOLO', { enrich: { squareFeet: 3500, bedrooms: 4, bathrooms: 4 } })
  const r = computeScores([solo], { weights: onlyWeights('size') })
  assert.equal(r.get('SOLO').final, 90)
})

test('size: missing all size fields → neutral 50, flagged', () => {
  const r = computeScores([prop('A', { enrich: {} })], { weights: onlyWeights('size') })
  const f = r.get('A').factors.find(x => x.key === 'size')
  assert.equal(f.score, 50)
  assert.equal(f.estimated, true)
})

// ── value medians fallback (pure) ────────────────────────────────────────────
test('buildValueMedians: excludes nominal sales, medians by neighborhood', () => {
  const properties = [
    { caseNumber: '1', municipality: 'Pittsburgh', isPittsburghProper: true,
      enrichmentSummary: { neighborhood: 'Carrick' },
      history: [{ outcomeCategory: 'sold_third_party', soldFor: 100000, saleMonth: '2026-01' }] },
    { caseNumber: '2', municipality: 'Pittsburgh', isPittsburghProper: true,
      enrichmentSummary: { neighborhood: 'Carrick' },
      history: [{ outcomeCategory: 'sold_third_party', soldFor: 1, saleMonth: '2026-01' }] }, // nominal, excluded
    { caseNumber: '3', municipality: 'Pittsburgh', isPittsburghProper: true,
      enrichmentSummary: { neighborhood: 'Carrick' },
      history: [{ outcomeCategory: 'sold_third_party', soldFor: 140000, saleMonth: '2026-02' }] },
  ]
  const m = buildValueMedians(properties)
  assert.equal(m.byNeighborhood.get('Carrick'), 120000) // median of 100k & 140k
})

test('estimatedValue: FMV beats medians beats ARV', () => {
  const ctx = { valueMedians: { byNeighborhood: new Map([['Carrick', 90000]]), byMunicipality: new Map() } }
  const withFmv = { enrichmentSummary: { fairMarketValue: 150000, neighborhood: 'Carrick' }, isPittsburghProper: true, userFields: { arvOverride: 200000 } }
  assert.equal(estimatedValue(withFmv, ctx), 150000)
  const noFmv = { enrichmentSummary: { neighborhood: 'Carrick' }, isPittsburghProper: true, userFields: { arvOverride: 200000 } }
  assert.equal(estimatedValue(noFmv, ctx), 90000)
  const onlyArv = { enrichmentSummary: {}, municipality: 'X', isPittsburghProper: false, userFields: { arvOverride: 200000 } }
  assert.equal(estimatedValue(onlyArv, ctx), 200000)
})

// ── helpers ──────────────────────────────────────────────────────────────────
test('haversineMiles: Pittsburgh downtown to airport ~ 11-13 mi', () => {
  const d = haversineMiles(40.4406, -79.9959, 40.4915, -80.2329)
  assert.ok(d > 11 && d < 14, `got ${d}`)
})
test('postponementCount: max of chain length and postponed history', () => {
  assert.equal(postponementCount({ commentsParsed: { postponementHistory: ['a', 'b'] }, history: [] }), 2)
  assert.equal(postponementCount({ commentsParsed: {}, history: [{ outcomeCategory: 'postponed' }, { outcomeCategory: 'postponed' }, { outcomeCategory: 'active' }] }), 2)
})

console.log(`\n${passed} passed`)
