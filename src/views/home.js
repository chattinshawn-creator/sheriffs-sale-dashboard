import { listUploads } from '../storage/uploads.js'
import { formatMonth, formatBytes, formatDate, escapeHtml } from '../ui/format.js'

export async function renderHome(el) {
  const uploads = await listUploads()

  if (uploads.length === 0) {
    el.innerHTML = `
      <h1>Home</h1>
      <div class="banner info">No properties loaded yet.</div>
      <p class="muted">
        Upload a Sheriff's Sale PDF on the <a href="#/upload">Upload</a> page to
        get started. Parsing isn't built yet — that lands in the next prompt.
      </p>
    `
    return
  }

  // Group uploads by saleMonth (newest month first).
  const byMonth = new Map()
  for (const u of uploads) {
    const month = u.saleMonth || 'Unknown'
    if (!byMonth.has(month)) byMonth.set(month, [])
    byMonth.get(month).push(u)
  }
  const sortedMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))

  let html = `
    <h1>Home</h1>
    <div class="banner info">
      ${uploads.length} upload${uploads.length === 1 ? '' : 's'} in your archive.
      Parsing isn't built yet — properties will appear here once it is.
    </div>
  `

  for (const month of sortedMonths) {
    const label = month === 'Unknown' ? 'Unknown month' : formatMonth(month)
    html += `<h2>${escapeHtml(label)}</h2>`
    for (const u of byMonth.get(month)) {
      html += `
        <div class="card">
          <div class="row">
            <span class="tag ${u.type}">${u.type}</span>
            <strong>${escapeHtml(u.filename)}</strong>
          </div>
          <div class="meta">
            ${u.pageCount} page${u.pageCount === 1 ? '' : 's'} •
            ${formatBytes(u.size)} •
            uploaded ${formatDate(u.uploadedAt)}
          </div>
        </div>
      `
    }
  }

  el.innerHTML = html
}
