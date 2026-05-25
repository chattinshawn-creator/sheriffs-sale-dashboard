import { saveUpload, findDuplicate, countUploads } from '../storage/uploads.js'
import { noteLastUpload } from '../storage/settings.js'
import { parsePdf } from '../pdf/parse.js'
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
      <div class="row">
        <button class="primary" id="parse-btn">Parse PDF</button>
        <a href="#/" class="muted small">Back to Home</a>
      </div>
      <div id="parse-status"></div>
    </div>
  `

  stagingEl.querySelector('#parse-btn').addEventListener('click', async () => {
    const res = await parsePdf(upload.id)
    stagingEl.querySelector('#parse-status').innerHTML =
      `<div class="spacer"></div><div class="banner warn">${escapeHtml(res.message)}</div>`
  })
}

/**
 * Best-effort page count without pulling in a full PDF library.
 * Strategy: read the bytes as latin-1 text and count `/Type /Page` markers
 * (excluding the container `/Type /Pages` object). This works reliably for
 * PDFs produced by CountySuite (the Sheriff's Office software).
 *
 * Performance: a 5MB PDF takes well under a second to read and scan in a
 * modern browser. Big enough to be worth showing a "Reading…" banner; small
 * enough that we don't need a progress bar.
 */
async function getPageCount(file) {
  try {
    const buf = await file.arrayBuffer()
    const text = new TextDecoder('latin1').decode(buf)
    const matches = text.match(/\/Type\s*\/Page[^s]/g)
    if (matches && matches.length > 0) return matches.length
    // Fallback: largest /Count value (usually on the root Pages object).
    const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map(m => parseInt(m[1], 10))
    if (counts.length) return Math.max(...counts)
    return 0
  } catch (e) {
    console.warn('Page count failed:', e)
    return 0
  }
}
