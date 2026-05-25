import { listUploads } from '../storage/uploads.js'
import { listProperties } from '../storage/properties.js'
import { formatMonth, formatBytes, formatDate, escapeHtml } from '../ui/format.js'

export async function renderHome(el) {
  const [uploads, properties] = await Promise.all([
    listUploads(),
    listProperties(),
  ])

  if (uploads.length === 0) {
    el.innerHTML = `
      <h1>Home</h1>
      <div class="banner info">No properties loaded yet.</div>
      <p class="muted">
        Upload a Sheriff's Sale PDF on the <a href="#/upload">Upload</a> page to
        get started.
      </p>
    `
    return
  }

  // Group uploads by saleMonth
  const uploadsByMonth = new Map()
  for (const u of uploads) {
    const m = u.saleMonth || 'Unknown'
    if (!uploadsByMonth.has(m)) uploadsByMonth.set(m, [])
    uploadsByMonth.get(m).push(u)
  }

  // Group properties by every saleMonth they appear in (a property postponed
  // across multiple sales shows up under each of those months).
  const propsByMonth = new Map()
  for (const prop of properties) {
    for (const h of prop.history) {
      const m = h.saleMonth || 'Unknown'
      if (!propsByMonth.has(m)) propsByMonth.set(m, [])
      propsByMonth.get(m).push({ prop, historyEntry: h })
    }
  }

  // Sort properties within each month by status (Active first, then Postponed,
  // then Stayed/other), then by opening bid descending for browsing.
  for (const list of propsByMonth.values()) {
    list.sort((a, b) => {
      const sa = statusRank(a.historyEntry.status)
      const sb = statusRank(b.historyEntry.status)
      if (sa !== sb) return sa - sb
      const ba = a.historyEntry.openingBid ?? 0
      const bb = b.historyEntry.openingBid ?? 0
      return bb - ba
    })
  }

  const allMonths = new Set([...uploadsByMonth.keys(), ...propsByMonth.keys()])
  const sortedMonths = [...allMonths].sort((a, b) => b.localeCompare(a))

  let html = `<h1>Home</h1>`

  if (properties.length === 0) {
    html += `
      <div class="banner info">
        ${uploads.length} upload${uploads.length === 1 ? '' : 's'} in your archive.
        No properties parsed yet — open an upload below and click <strong>Parse PDF</strong> to extract.
      </div>
    `
  } else {
    html += `
      <div class="banner info">
        ${properties.length} unique propert${properties.length === 1 ? 'y' : 'ies'}
        across ${uploads.length} upload${uploads.length === 1 ? '' : 's'}.
      </div>
    `
  }

  for (const month of sortedMonths) {
    const monthLabel = month === 'Unknown' ? 'Unknown month' : formatMonth(month)
    html += `<h2>${escapeHtml(monthLabel)}</h2>`

    // Uploads block
    for (const u of (uploadsByMonth.get(month) || [])) {
      const parsedBadge = u.parsed
        ? `<span class="indicator present">parsed</span>`
        : u.lastParsedAt
          ? `<span class="indicator absent">partially parsed</span>`
          : `<span class="indicator absent">not parsed</span>`
      html += `
        <div class="card">
          <div class="row">
            <span class="tag ${u.type}">${u.type}</span>
            <strong>${escapeHtml(u.filename)}</strong>
            ${parsedBadge}
          </div>
          <div class="meta">
            ${u.pageCount} page${u.pageCount === 1 ? '' : 's'} •
            ${formatBytes(u.size)} •
            uploaded ${formatDate(u.uploadedAt)}
          </div>
        </div>
      `
    }

    // Properties block
    const monthProps = propsByMonth.get(month) || []
    if (monthProps.length > 0) {
      html += `
        <h3 class="muted small" style="margin-top:20px;margin-bottom:8px;">
          ${monthProps.length} propert${monthProps.length === 1 ? 'y' : 'ies'}
        </h3>
      `
      for (const { prop, historyEntry } of monthProps) {
        html += renderPropertyCard(prop, historyEntry)
      }
    }
  }

  el.innerHTML = html
}

function renderPropertyCard(prop, h) {
  const bid = h.openingBid != null
    ? `$${h.openingBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  const sold = h.soldFor != null
    ? ` • <strong>Sold for $${h.soldFor.toLocaleString()}</strong> to ${escapeHtml(h.soldTo || '?')}`
    : ''
  const flagsHtml = []
  if (prop.commentsParsed?.replenishmentUnpaid) {
    flagsHtml.push(`<span class="tag" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;">replenishment unpaid</span>`)
  }
  if ((prop.commentsParsed?.bankruptcyHistory || []).length > 0) {
    flagsHtml.push(`<span class="tag" style="background:#fef3c7;color:#b45309;border-color:#fde68a;">bankruptcy history</span>`)
  }
  if (prop.tracts > 1) {
    flagsHtml.push(`<span class="tag">${prop.tracts} tracts</span>`)
  }

  return `
    <a class="card prop-card" href="#/property/${encodeURIComponent(prop.caseNumber)}">
      <div class="row" style="justify-content:space-between;">
        <div>
          <strong>${escapeHtml(prop.address || '(no address)')}</strong>
          <span class="muted small"> — ${escapeHtml(prop.municipality || '')}</span>
        </div>
        <div class="row">${flagsHtml.join('')}</div>
      </div>
      <div class="meta">
        Case ${escapeHtml(prop.caseNumber)} •
        Parcel ${escapeHtml(prop.parcelId || '?')} •
        Opening bid <strong>${bid}</strong>${sold}
      </div>
      <div class="meta">
        Status: ${escapeHtml(h.status || '?')}
      </div>
    </a>
  `
}

// Sort weight for statuses on the home view. Lower number = shown first.
function statusRank(status) {
  if (!status) return 99
  const s = status.toLowerCase()
  if (s.startsWith('sold')) return 0
  if (s.startsWith('active')) return 1
  if (s.startsWith('postponed')) return 2
  if (s.startsWith('stayed')) return 3
  return 50
}
