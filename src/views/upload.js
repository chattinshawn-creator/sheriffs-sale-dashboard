import { saveUpload, findDuplicate, countUploads } from '../storage/uploads.js'
import { noteLastUpload, getApiKey } from '../storage/settings.js'
import { parsePdf, estimateCost } from '../pdf/parse.js'
import { DEFAULT_CHUNK_PAGES } from '../pdf/chunking.js'
import { formatBytes, formatMonth, guessFromFilename, escapeHtml } from '../ui/format.js'

export async function renderUpload(el) {
  el.innerHTML = `
    <h1>Upload a PDF</h1>
    <p class="muted">
      Upload one PDF at a time — either a monthly listings document or a monthly
      results document. Each upload is added to your archive (it doesn't replace
      previous uploads).
    </p>

    <div class="dropzone" id="dropzone">
      <p><strong>Drop a Sheriff's Sale PDF here</strong></p>
      <p>or</p>
      <p><button class="primary" id="pick-btn">Choose a file</button></p>
      <input type="file" id="file-input" accept="application/pdf,.pdf" hidden />
      <p class="small muted">PDFs only — expected size: a few MB, ~80–90 pages.</p>
    </div>

    <div id="staging"></div>
  `

  const dz = el.querySelector('#dropzone')
  const input = el.querySelector('#file-input')
  const stagingEl = el.querySelector('#staging')

  el.querySelector('#pick-btn').addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0], stagingEl)
  })

  dz.addEventListener('dragover', e => {
    e.preventDefault()
    dz.classList.add('dragover')
  })
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'))
  dz.addEventListener('drop', e => {
    e.preventDefault()
    dz.classList.remove('dragover')
    const f = e.dataTransfer?.files?.[0]
    if (f) handleFile(f, stagingEl)
  })
}

async function handleFile(file, stagingEl) {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    stagingEl.innerHTML = `<div class="banner err">That's not a PDF. Try again.</div>`
    return
  }

  stagingEl.innerHTML = `
    <div class="banner info">
      Reading <strong>${escapeHtml(file.name)}</strong> (${formatBytes(file.size)})…
    </div>
  `

  const [pageCount, duplicate] = await Promise.all([
    getPageCount(file),
    findDuplicate({ filename: file.name, size: file.size }),
  ])
  const guess = guessFromFilename(file.name)

  renderStagingCard(stagingEl, { file, pageCount, guess, duplicate })
}

function renderStagingCard(stagingEl, { file, pageCount, guess, duplicate }) {
  const dupWarning = duplicate ? `
    <div class="banner warn">
      <strong>Looks like a duplicate.</strong> You uploaded a file named
      "${escapeHtml(duplicate.filename)}" with the same size on
      ${new Date(duplicate.uploadedAt).toLocaleDateString()}.
      Only add it again if you're sure this is a different file (e.g. a revised version).
    </div>
  ` : ''

  stagingEl.innerHTML = `
    ${dupWarning}
    <div class="card">
      <h3>Confirm upload</h3>

      <div class="field">
        <label>Filename</label>
        <div>${escapeHtml(file.name)}</div>
      </div>

      <div class="field">
        <label>Size / pages</label>
        <div>${formatBytes(file.size)} • ${pageCount || '?'} page${pageCount === 1 ? '' : 's'}</div>
      </div>

      <div class="field">
        <label for="doc-type">Document type</label>
        <select id="doc-type">
          <option value="listings" ${guess.type === 'listings' ? 'selected' : ''}>Listings (pre-sale)</option>
          <option value="results" ${guess.type === 'results' ? 'selected' : ''}>Results (post-sale)</option>
        </select>
        <span class="hint">
          ${guess.type
            ? `Guessed from the filename ("${guess.type}"). Change if wrong.`
            : `Couldn't tell from the filename — please pick one.`}
        </span>
      </div>

      <div class="field">
        <label for="sale-month">Sale month</label>
        <input type="month" id="sale-month" value="${guess.month || ''}" />
        <span class="hint">
          ${guess.month
            ? `Guessed from the filename (${formatMonth(guess.month)}). Change if wrong.`
            : `Couldn't tell from the filename — please pick the sale month.`}
        </span>
      </div>

      <div class="row">
        <button class="primary" id="confirm-upload">Add to archive</button>
        <button id="cancel-upload">Cancel</button>
      </div>
    </div>
  `

  stagingEl.querySelector('#cancel-upload').addEventListener('click', () => {
    stagingEl.innerHTML = ''
  })

  stagingEl.querySelector('#confirm-upload').addEventListener('click', async () => {
    const type = stagingEl.querySelector('#doc-type').value
    const saleMonth = stagingEl.querySelector('#sale-month').value || null
    if (!saleMonth) {
      alert('Please pick a sale month before adding to the archive.')
      return
    }
    const btn = stagingEl.querySelector('#confirm-upload')
    btn.disabled = true
    btn.textContent = 'Saving…'

    const upload = await saveUpload({ file, type, pageCount, saleMonth })
    await noteLastUpload(type)
    const total = await countUploads()
    renderSavedCard(stagingEl, { upload, total })
  })
}

function renderSavedCard(stagingEl, { upload, total }) {
  stagingEl.innerHTML = `
    <div class="banner ok">
      <strong>Added.</strong> "${escapeHtml(upload.filename)}" is upload #${total} in your archive.
    </div>
    <div class="card">
      <div class="row">
        <span class="tag ${upload.type}">${upload.type}</span>
        <strong>${escapeHtml(upload.filename)}</strong>
      </div>
      <div class="meta">
        ${upload.pageCount} page${upload.pageCount === 1 ? '' : 's'} •
        ${formatBytes(upload.size)} •
        Sale: ${formatMonth(upload.saleMonth)}
      </div>
      <div class="spacer"></div>
      <div id="parse-zone"></div>
    </div>
  `
  renderParseInitial(stagingEl.querySelector('#parse-zone'), upload)
}

// ---- Parse flow ----------------------------------------------------------

function renderParseInitial(zone, upload) {
  zone.innerHTML = `
    <div class="row">
      <button class="primary" id="parse-btn">Parse PDF</button>
      <a href="#/" class="muted small">Back to Home</a>
    </div>
  `
  zone.querySelector('#parse-btn').addEventListener('click', async () => {
    const apiKey = await getApiKey()
    if (!apiKey) {
      zone.innerHTML = `
        <div class="banner err">
          No Anthropic API key saved. <a href="#/settings">Add one in Settings</a> first.
        </div>
        <div class="row">
          <button id="back-after-no-key">Back</button>
        </div>
      `
      zone.querySelector('#back-after-no-key').addEventListener('click', () => renderParseInitial(zone, upload))
      return
    }
    renderParseEstimate(zone, upload)
  })
}

function renderParseEstimate(zone, upload) {
  const chunkSize = DEFAULT_CHUNK_PAGES
  const chunks = Math.ceil(upload.pageCount / chunkSize)
  const estimate = estimateCost({ pageCount: upload.pageCount, chunkSize })

  zone.innerHTML = `
    <div class="banner info">
      This PDF has <strong>${upload.pageCount} pages</strong> →
      <strong>${chunks} chunks</strong> → estimated cost
      <strong>~$${estimate.toFixed(2)}</strong>.
      <div class="small" style="opacity:0.8;margin-top:4px;">
        Estimate uses ~$0.02/page Sonnet pricing. Actual cost is shown after parsing.
        The first chunk pays full price; later chunks reuse the cached system prompt at ~10%.
      </div>
    </div>
    <div class="row">
      <button class="primary" id="confirm-parse-btn">Parse PDF (~$${estimate.toFixed(2)})</button>
      <button id="cancel-parse-btn">Cancel</button>
    </div>
  `
  zone.querySelector('#cancel-parse-btn').addEventListener('click', () => renderParseInitial(zone, upload))
  zone.querySelector('#confirm-parse-btn').addEventListener('click', () => {
    runParse(zone, upload, {})
  })
}

async function runParse(zone, upload, opts) {
  zone.innerHTML = `
    <div class="banner info">
      <div id="parse-status-text">Preparing PDF…</div>
      <div class="spacer"></div>
      <div class="progress"><div id="parse-progress-bar" style="width:0%"></div></div>
      <div class="small muted" style="margin-top:8px;">
        Stay on this page — navigating away cancels progress reporting (the parse continues but you lose the live status).
      </div>
    </div>
  `
  const statusEl = zone.querySelector('#parse-status-text')
  const barEl = zone.querySelector('#parse-progress-bar')

  const onProgress = (info) => {
    if (info.phase === 'chunking') {
      statusEl.textContent = 'Splitting PDF into chunks…'
      barEl.style.width = '3%'
    } else if (info.phase === 'parsing') {
      const denom = Math.max(info.totalChunks, 1)
      const pct = Math.max(5, Math.round((info.chunkIdx / denom) * 100))
      barEl.style.width = `${pct}%`
      const errSuffix = info.lastError ? ` • last error on previous chunk: ${info.lastError.slice(0, 80)}…` : ''
      statusEl.textContent =
        `Parsing chunk ${info.chunkIdx + 1} of ${info.totalChunks} ` +
        `(pages ${info.pageStart}–${info.pageEnd}) • ` +
        `${info.savedSoFar} saved • ${info.repairedSoFar || 0} repaired • ` +
        `$${info.costSoFar.toFixed(2)} spent${errSuffix}`
    } else if (info.phase === 'repairing') {
      statusEl.textContent =
        `Repairing flagged records in chunk ${info.chunkIdx + 1} of ${info.totalChunks} ` +
        `(pages ${info.pageStart}–${info.pageEnd}) • ` +
        `$${info.costSoFar.toFixed(2)} spent so far…`
    } else if (info.phase === 'done') {
      barEl.style.width = '100%'
      statusEl.textContent = 'Done.'
    }
  }

  try {
    const result = await parsePdf(upload.id, { ...opts, onProgress })
    renderParseResult(zone, upload, result)
  } catch (e) {
    zone.innerHTML = `
      <div class="banner err">
        <strong>Parsing failed before any chunks ran.</strong>
        <pre style="white-space:pre-wrap;font-size:12px;margin-top:8px;">${escapeHtml(String(e?.message || e))}</pre>
      </div>
      <div class="row">
        <button id="back-after-error">Back</button>
      </div>
    `
    zone.querySelector('#back-after-error').addEventListener('click', () => renderParseInitial(zone, upload))
  }
}

function renderParseResult(zone, upload, result) {
  const failedCount = result.failedChunks.length
  const u = result.usage
  const totalInput = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  const cacheHitPct = totalInput > 0
    ? Math.round(100 * (u.cache_read_input_tokens || 0) / totalInput)
    : 0

  let failedHtml = ''
  if (failedCount > 0) {
    const pages = result.failedChunks.map(c => `${c.pageStart}–${c.pageEnd}`).join(', ')
    failedHtml = `
      <div class="banner warn">
        <strong>${failedCount} chunk${failedCount === 1 ? '' : 's'} failed:</strong> pages ${escapeHtml(pages)}.
        <div class="small" style="margin-top:4px;">First error: ${escapeHtml(result.failedChunks[0].error.slice(0, 240))}</div>
        <div class="spacer"></div>
        <button id="retry-btn">Retry failed pages</button>
      </div>
    `
  }

  const repaired = result.repairedCount || 0
  const flagged = result.flaggedCount || 0
  const qualityLine =
    `${result.savedCount} saved` +
    (repaired > 0 ? ` • ${repaired} repaired` : '') +
    (flagged > 0 ? ` • <strong style="color:var(--color-warn)">${flagged} still flagged</strong>` : '')

  zone.innerHTML = `
    <div class="banner ${failedCount === 0 && flagged === 0 ? 'ok' : 'info'}">
      <strong>Parse complete.</strong> ${qualityLine} from ${upload.pageCount} pages.
      <div class="small" style="margin-top:4px;opacity:0.8;">
        Cost: <strong>$${result.totalCost.toFixed(3)}</strong> •
        ${(u.input_tokens || 0).toLocaleString()} new input +
        ${(u.cache_read_input_tokens || 0).toLocaleString()} cached input +
        ${(u.output_tokens || 0).toLocaleString()} output tokens •
        ${cacheHitPct}% cache hit
      </div>
      ${flagged > 0 ? `
        <div class="small" style="margin-top:6px;">
          Flagged records have a "needs review" badge on Home — open them to see what went wrong.
        </div>
      ` : ''}
    </div>
    ${failedHtml}
    <div class="row">
      <button class="primary" id="go-home-btn">View on Home</button>
      <button id="parse-again-btn">Parse again</button>
    </div>
  `

  zone.querySelector('#go-home-btn').addEventListener('click', () => {
    window.location.hash = '#/'
  })
  zone.querySelector('#parse-again-btn').addEventListener('click', () => renderParseInitial(zone, upload))
  if (failedCount > 0) {
    zone.querySelector('#retry-btn').addEventListener('click', () => {
      runParse(zone, upload, { onlyChunks: result.failedChunks.map(c => c.idx) })
    })
  }
}

/**
 * Best-effort page count without a full PDF library. Counts `/Type /Page`
 * markers (excluding the container `/Type /Pages` object). Reliable for
 * PDFs produced by CountySuite (the Sheriff's software). Falls back to the
 * largest `/Count` value if the primary scan finds nothing.
 */
async function getPageCount(file) {
  try {
    const buf = await file.arrayBuffer()
    const text = new TextDecoder('latin1').decode(buf)
    const matches = text.match(/\/Type\s*\/Page[^s]/g)
    if (matches && matches.length > 0) return matches.length
    const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map(m => parseInt(m[1], 10))
    if (counts.length) return Math.max(...counts)
    return 0
  } catch (e) {
    console.warn('Page count failed:', e)
    return 0
  }
}
