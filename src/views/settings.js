import { getApiKey, setApiKey, clearApiKey } from '../storage/settings.js'
import { escapeAttr, escapeHtml, formatMonth } from '../ui/format.js'
import { buildArchiveExport, inspectArchive, importArchive } from '../storage/archive.js'

export async function renderSettings(el) {
  const currentKey = await getApiKey()
  const hasKey = !!currentKey

  el.innerHTML = `
    <h1>Settings</h1>

    <div class="banner warn">
      <strong>Heads up:</strong> Your API key is stored in this browser's local
      database on this device. It never leaves your machine, but anyone with
      access to this computer could read it. Don't use this app on a shared
      computer.
    </div>

    <div class="field">
      <label for="api-key">Anthropic API key</label>
      <input
        type="password"
        id="api-key"
        value="${escapeAttr(currentKey)}"
        placeholder="sk-ant-..."
        autocomplete="off"
      />
      <span class="hint">
        Status:
        <span class="indicator ${hasKey ? 'present' : 'absent'}">
          ${hasKey ? 'Key present' : 'Key not set'}
        </span>
      </span>
    </div>

    <div class="row">
      <button class="primary" id="save-key">Save</button>
      <button class="danger" id="clear-key" ${hasKey ? '' : 'disabled'}>Clear API key</button>
      <span id="save-status" class="muted small"></span>
    </div>

    <div class="spacer"></div>
    <p class="muted small">
      The Anthropic API is not yet called from this app — saving the key here
      just stores it for use in the next prompt's parser.
    </p>

    <hr style="margin:28px 0;border:none;border-top:1px solid var(--color-border, #e5e7eb);" />

    <h2>Archive backup</h2>
    <p class="muted small" style="margin-top:0;">
      Your uploads, parsed properties, sale history, and your own notes/flags
      live only in this browser. Export a JSON file to keep a durable copy or
      move everything to another computer.
    </p>

    <div class="card" style="margin-bottom:16px;">
      <strong>Export archive (JSON)</strong>
      <p class="small" style="margin:4px 0 8px;">
        Saves a single <code>.json</code> file with all uploads, properties
        (including history and your notes), and a format version + timestamp.
      </p>
      <label class="small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:8px;"
             title="Original PDFs are several MB each. Without them you can still restore everything you see, but you can't re-run the AI parse on a past month from scratch.">
        <input type="checkbox" id="export-include-pdfs" />
        Include original PDFs (larger file — full backup)
      </label>
      <div class="row">
        <button class="primary" id="export-archive">Export archive</button>
        <span id="export-status" class="muted small"></span>
      </div>
    </div>

    <div class="card">
      <strong>Import archive (JSON)</strong>
      <p class="small" style="margin:4px 0 8px;">
        Restore from a previously exported file. You'll see a summary and choose
        Merge or Replace before anything is written.
      </p>
      <div class="row">
        <button id="import-pick">Choose archive file…</button>
        <input type="file" id="import-file" accept="application/json,.json" style="display:none;" />
        <span id="import-filename" class="muted small"></span>
      </div>
      <div id="import-panel" style="margin-top:12px;"></div>
    </div>
  `

  el.querySelector('#save-key').addEventListener('click', async () => {
    const v = el.querySelector('#api-key').value.trim()
    await setApiKey(v)
    el.querySelector('#save-status').textContent = 'Saved.'
    setTimeout(() => renderSettings(el), 600)
  })

  el.querySelector('#clear-key').addEventListener('click', async () => {
    if (!confirm('Clear the saved API key from this browser?')) return
    await clearApiKey()
    renderSettings(el)
  })

  wireExport(el)
  wireImport(el)
}

// ── Export ──────────────────────────────────────────────────────────────────

function wireExport(el) {
  el.querySelector('#export-archive').addEventListener('click', async () => {
    const statusEl = el.querySelector('#export-status')
    const includePdfs = el.querySelector('#export-include-pdfs').checked
    statusEl.textContent = includePdfs ? 'Building full backup (this can take a moment)…' : 'Building…'
    try {
      const data = await buildArchiveExport({ includePdfs })
      const date = new Date().toISOString().slice(0, 10)
      downloadJson(data, `sheriffs-sale-archive-${date}.json`)
      statusEl.textContent =
        `Exported ${data.counts.uploads} uploads, ${data.counts.properties} properties` +
        (includePdfs ? ` + ${data.pdfBlobs?.length ?? 0} PDFs.` : '.')
    } catch (e) {
      console.error('[settings] export failed:', e)
      statusEl.innerHTML = `<span style="color:var(--color-err);">Export failed: ${escapeHtml(String(e?.message || e))}</span>`
    }
  })
}

// ── Import ──────────────────────────────────────────────────────────────────

function wireImport(el) {
  const fileInput = el.querySelector('#import-file')
  el.querySelector('#import-pick').addEventListener('click', () => fileInput.click())

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    const panel = el.querySelector('#import-panel')
    const nameEl = el.querySelector('#import-filename')
    if (!file) return
    nameEl.textContent = file.name
    panel.innerHTML = '<span class="muted small">Reading file…</span>'

    let data
    try {
      data = JSON.parse(await file.text())
    } catch (e) {
      panel.innerHTML = `<div class="banner err">Couldn't read that file as JSON: ${escapeHtml(String(e?.message || e))}</div>`
      fileInput.value = ''
      return
    }

    const info = inspectArchive(data)
    if (!info.ok) {
      panel.innerHTML = `<div class="banner err">${escapeHtml(info.error)}</div>`
      fileInput.value = ''
      return
    }

    const range = info.monthMin
      ? (info.monthMin === info.monthMax
          ? formatMonth(info.monthMin)
          : `${formatMonth(info.monthMin)} – ${formatMonth(info.monthMax)}`)
      : 'unknown range'
    const pdfNote = info.hasPdfs ? ` It also contains ${info.pdfCount} original PDF${info.pdfCount === 1 ? '' : 's'}.` : ''
    const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString() : 'unknown date'

    panel.innerHTML = `
      <div class="banner info">
        This file has <strong>${info.uploads}</strong> upload${info.uploads === 1 ? '' : 's'} and
        <strong>${info.properties}</strong> propert${info.properties === 1 ? 'y' : 'ies'}
        from sale months <strong>${escapeHtml(range)}</strong>.${pdfNote}
        <div class="small muted" style="margin-top:4px;">Exported ${escapeHtml(when)}.</div>
      </div>
      <p class="small" style="margin:8px 0 4px;">Choose how to apply it:</p>
      <div class="row">
        <button class="primary" id="import-merge">Merge (keep my data)</button>
        <button class="danger" id="import-replace">Replace everything</button>
        <button id="import-cancel">Cancel</button>
      </div>
      <p class="small muted" style="margin-top:8px;">
        <strong>Merge</strong> adds and updates records from the file but keeps anything already here,
        and never overwrites your own notes, max bids, or flags.
        <strong>Replace</strong> wipes the current archive first — use only to restore onto an empty
        or outdated browser.
      </p>
      <div id="import-result" style="margin-top:10px;"></div>
    `

    panel.querySelector('#import-cancel').addEventListener('click', () => {
      panel.innerHTML = ''
      nameEl.textContent = ''
      fileInput.value = ''
    })

    panel.querySelector('#import-merge').addEventListener('click', () =>
      runImport(panel, data, 'merge'))

    panel.querySelector('#import-replace').addEventListener('click', () => {
      if (!confirm('REPLACE wipes everything currently in this browser (uploads, properties, your notes) and loads the file instead. This cannot be undone. Continue?')) return
      if (!confirm('Are you absolutely sure? Your current archive will be permanently deleted and replaced.')) return
      runImport(panel, data, 'replace')
    })

    // Reset so re-picking the same file fires 'change' again.
    fileInput.value = ''
  })
}

async function runImport(panel, data, mode) {
  const resultEl = panel.querySelector('#import-result')
  resultEl.innerHTML = '<span class="muted small">Importing…</span>'
  try {
    const r = await importArchive(data, { mode })
    const parts = [
      `${r.propsAdded} propert${r.propsAdded === 1 ? 'y' : 'ies'} added`,
      `${r.propsUpdated} updated`,
      `${r.uploadsAdded} upload${r.uploadsAdded === 1 ? '' : 's'} added`,
      `${r.uploadsUpdated} updated`,
    ]
    if (r.pdfsRestored) parts.push(`${r.pdfsRestored} PDFs restored`)
    resultEl.innerHTML = `
      <div class="banner ok">
        <strong>Import complete (${mode}).</strong> ${escapeHtml(parts.join(' • '))}.
        <div class="small" style="margin-top:4px;">Reload the Home page to see the restored data.</div>
      </div>
    `
  } catch (e) {
    console.error('[settings] import failed:', e)
    resultEl.innerHTML = `<div class="banner err">Import failed: ${escapeHtml(String(e?.message || e))}</div>`
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}
