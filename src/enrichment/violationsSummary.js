/**
 * Pure summarizer for PLI/DOMI/ES violation rows. Kept separate from
 * violations.js (which imports the IndexedDB layer) so it can be unit-tested
 * in plain Node without a browser environment.
 */

const CLOSED_RE = /closed/i

/** Best human-readable label for a casefile's rows. */
function pickLabel(rows) {
  for (const r of rows) {
    if (r?.violation_description && String(r.violation_description).trim()) {
      return String(r.violation_description).trim()
    }
  }
  // violation_description is frequently null in this dataset; case_file_type
  // (e.g. "Unpermitted Electrical Work") is the reliable fallback.
  for (const r of rows) {
    if (r?.case_file_type && String(r.case_file_type).trim()) {
      return String(r.case_file_type).trim()
    }
  }
  return null
}

/**
 * Summarize raw violation rows into the counts + small detail we store on the
 * property's enrichmentSummary.codeViolations.
 *
 * The raw dataset has MANY rows per casefile (one per inspection visit), so we
 * group by `casefile_number` and count CASEFILES, not rows. For each casefile
 * we keep its latest status + date.
 *
 * Risk definition (per Shawn): the headline number weights what's actually
 * live — casefiles that are still OPEN (status not "Closed") OR RECENT (latest
 * inspection within `recentYears`). We also report the all-time total so an
 * old, fully-resolved history is distinguishable from active problems.
 *
 * @param {object[]} records - raw violation rows from getViolations().data
 * @param {{ now?: number, recentYears?: number, maxDetail?: number }} [opts]
 * @returns {{ total, open, recent, headline, detail: object[] }}
 */
export function summarizeViolations(records, opts = {}) {
  const { now = Date.now(), recentYears = 3, maxDetail = 25 } = opts
  if (!Array.isArray(records) || records.length === 0) {
    return { total: 0, open: 0, recent: 0, headline: 0, detail: [] }
  }

  // Group rows by casefile. Rows with no casefile_number each count as their
  // own (rare), keyed by row _id so they aren't all collapsed into one bucket.
  const groups = new Map()
  for (const r of records) {
    const key = r?.casefile_number || `_noid:${r?._id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const recentCutoff = now - recentYears * 365.25 * 24 * 60 * 60 * 1000
  const casefiles = []
  for (const [casefile, rows] of groups) {
    const sorted = [...rows].sort((a, b) =>
      String(b.investigation_date || '').localeCompare(String(a.investigation_date || '')))
    const latest = sorted[0]
    const status = latest.status || null
    const date = latest.investigation_date || null
    const isOpen = !CLOSED_RE.test(String(status || ''))
    const parsed = date ? Date.parse(date) : NaN
    const isRecent = Number.isFinite(parsed) && parsed >= recentCutoff
    casefiles.push({
      casefile: String(casefile).startsWith('_noid:') ? null : casefile,
      label: pickLabel(rows),
      status,
      date,
      isOpen,
      isRecent,
    })
  }

  // Most-relevant first: open, then recent, then newest date.
  casefiles.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1
    if (a.isRecent !== b.isRecent) return a.isRecent ? -1 : 1
    return String(b.date || '').localeCompare(String(a.date || ''))
  })

  const total = casefiles.length
  const open = casefiles.filter(c => c.isOpen).length
  const recent = casefiles.filter(c => c.isRecent).length
  const headline = casefiles.filter(c => c.isOpen || c.isRecent).length

  return {
    total,
    open,
    recent,
    headline,
    detail: casefiles.slice(0, maxDetail).map(({ casefile, label, status, date }) =>
      ({ casefile, label, status, date })),
  }
}
