export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString()
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function formatMonth(month) {
  if (!month) return ''
  const [y, m] = month.split('-')
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`
}

const MONTH_LOOKUP = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12',
}

// Heuristic: pull month/year + doc type from a filename like
//   May-2026-results-revised.pdf       -> { month: '2026-05', type: 'results' }
//   June-2026-Sale-List.pdf            -> { month: '2026-06', type: 'listings' }
export function guessFromFilename(filename) {
  const lower = filename.toLowerCase()

  let month = null
  for (const [name, num] of Object.entries(MONTH_LOOKUP)) {
    const re = new RegExp(`\\b${name}[-_\\s]?(\\d{4})\\b`)
    const m = lower.match(re)
    if (m) {
      month = `${m[1]}-${num}`
      break
    }
  }

  let type = null
  if (/results?/.test(lower)) type = 'results'
  else if (/sale[-_]?list|listings?/.test(lower)) type = 'listings'

  return { month, type }
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
