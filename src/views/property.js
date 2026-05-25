import { getProperty, updateUserFields } from '../storage/properties.js'
import { getUpload, getUploadBlob } from '../storage/uploads.js'
import { formatMonth, escapeHtml, escapeAttr } from '../ui/format.js'

export async function renderProperty(el, params) {
  const caseNumber = params.caseNumber
  if (!caseNumber) {
    el.innerHTML = `<div class="banner err">No case number in URL.</div>`
    return
  }

  const prop = await getProperty(caseNumber)
  if (!prop) {
    el.innerHTML = `
      <div class="banner warn">
        No property found for case <code>${escapeHtml(caseNumber)}</code>.
        It may not have been parsed yet, or the case number is wrong.
      </div>
      <p><a href="#/">← Back to Home</a></p>
    `
    return
  }

  // Most recent history entry — that's the "current" snapshot.
  const current = prop.history[0] || {}
  // Look up the upload filename for each history entry's source-PDF link.
  const uploadsByHistory = await Promise.all(
    prop.history.map(h => getUpload(h.uploadId).catch(() => null))
  )

  el.innerHTML = renderShell(prop, current, uploadsByHistory)

  wireUserFieldsAutoSave(el, prop)
  wireSourcePdfLinks(el)
}

// ─── Top-level shell ───────────────────────────────────────────────────────

function renderShell(prop, current, uploadsByHistory) {
  const flags = collectFlags(prop, current)
  const sold = current.soldFor != null
    ? `<span class="tag" style="background:#d1fae5;color:#065f46;border-color:#a7f3d0;">SOLD $${current.soldFor.toLocaleString()}</span>`
    : ''

  return `
    <div class="row" style="justify-content:space-between;margin-bottom:8px;">
      <a href="#/" class="small">← Back to Home</a>
    </div>

    <h1 style="margin-bottom:4px;">${escapeHtml(prop.address || '(no address)')}</h1>
    <div class="row" style="margin-bottom:12px;">
      <span class="muted">${escapeHtml(prop.municipality || '')}</span>
      <span class="muted small">•</span>
      <span class="muted small">Case ${escapeHtml(prop.caseNumber)}</span>
      <span class="muted small">•</span>
      <span class="muted small">Parcel ${escapeHtml(prop.parcelId || '?')}</span>
      ${sold}
      ${flags.join('')}
    </div>

    ${renderUserFieldsCard(prop)}
    ${renderSaleInfoCard(prop, current)}
    ${prop.tracts > 1 ? renderMultiTractCard(prop) : ''}
    ${renderHistoryCard(prop, uploadsByHistory)}
    ${renderCommentsCard(prop)}
  `
}

function collectFlags(prop, current) {
  const out = []
  if (prop.commentsParsed?.replenishmentUnpaid) {
    out.push(`<span class="tag" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;">replenishment unpaid</span>`)
  }
  if ((prop.commentsParsed?.bankruptcyHistory || []).length > 0) {
    out.push(`<span class="tag" style="background:#fef3c7;color:#b45309;border-color:#fde68a;">bankruptcy history</span>`)
  }
  if (prop.tracts > 1) {
    out.push(`<span class="tag">${prop.tracts} tracts</span>`)
  }
  const postponements = prop.commentsParsed?.postponementHistory?.length || 0
  if (postponements >= 5) {
    out.push(`<span class="tag">${postponements} postponements</span>`)
  }
  return out
}

// ─── Your notes & bids (auto-save on blur) ─────────────────────────────────

function renderUserFieldsCard(prop) {
  const u = prop.userFields || {}
  const flagBtn = (val, label) => `
    <button type="button" class="flag-btn ${u.flag === val ? 'primary' : ''}" data-flag="${val}">${label}</button>
  `
  return `
    <div class="card">
      <h3 style="margin-top:0;">Your notes & bids</h3>

      <div class="field">
        <label>Flag</label>
        <div class="row" id="flag-group">
          ${flagBtn('interested', 'Interested')}
          ${flagBtn('skip', 'Skip')}
          ${flagBtn('', 'None')}
        </div>
        <span class="hint" id="flag-saved"></span>
      </div>

      <div class="field">
        <label for="max-bid">Max bid ($)</label>
        <input type="number" id="max-bid" step="100"
               value="${u.maxBid != null ? u.maxBid : ''}"
               placeholder="What you're willing to pay" />
        <span class="hint" id="max-bid-saved"></span>
      </div>

      <div class="field">
        <label for="arv-override">ARV override ($)</label>
        <input type="number" id="arv-override" step="100"
               value="${u.arvOverride != null ? u.arvOverride : ''}"
               placeholder="Your estimate of after-repair value" />
        <span class="hint" id="arv-override-saved"></span>
      </div>

      <div class="field">
        <label for="notes">Notes</label>
        <textarea id="notes" rows="4"
                  placeholder="Anything worth remembering about this property…">${escapeHtml(u.notes || '')}</textarea>
        <span class="hint" id="notes-saved"></span>
      </div>
    </div>
  `
}

function wireUserFieldsAutoSave(el, prop) {
  const caseNumber = prop.caseNumber
  const flash = (sel) => {
    const node = el.querySelector(sel)
    if (!node) return
    node.textContent = '✓ Saved'
    node.style.color = 'var(--color-ok)'
    setTimeout(() => { node.textContent = '' }, 1200)
  }

  // Flag — click handlers
  el.querySelectorAll('.flag-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const flag = btn.dataset.flag || null
      el.querySelectorAll('.flag-btn').forEach(b => b.classList.remove('primary'))
      btn.classList.add('primary')
      await updateUserFields(caseNumber, { flag })
      flash('#flag-saved')
    })
  })

  // Max bid — save on blur
  el.querySelector('#max-bid').addEventListener('blur', async (e) => {
    const v = e.target.value.trim()
    const num = v === '' ? null : Number(v)
    if (v !== '' && !Number.isFinite(num)) return
    await updateUserFields(caseNumber, { maxBid: num })
    flash('#max-bid-saved')
  })

  // ARV — save on blur
  el.querySelector('#arv-override').addEventListener('blur', async (e) => {
    const v = e.target.value.trim()
    const num = v === '' ? null : Number(v)
    if (v !== '' && !Number.isFinite(num)) return
    await updateUserFields(caseNumber, { arvOverride: num })
    flash('#arv-override-saved')
  })

  // Notes — save on blur
  el.querySelector('#notes').addEventListener('blur', async (e) => {
    await updateUserFields(caseNumber, { notes: e.target.value })
    flash('#notes-saved')
  })
}

// ─── Sale info ─────────────────────────────────────────────────────────────

function renderSaleInfoCard(prop, current) {
  const bid = current.openingBid != null
    ? `$${current.openingBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  return `
    <div class="card">
      <h3 style="margin-top:0;">Sale info</h3>
      ${field('Current status', current.status)}
      ${field('Opening bid (current)', bid)}
      ${field('Sale type', prop.saleType)}
      ${field('Plaintiff', prop.plaintiff)}
      ${field('Plaintiff attorney', prop.plaintiffAttorney)}
      ${field('Defendant', prop.defendant)}
      ${field('Service flags', prop.serviceFlags)}
      ${field('Sale number', prop.saleNumber)}
    </div>
  `
}

function field(label, value) {
  return `
    <div class="row" style="padding:6px 0;border-bottom:1px solid var(--color-border);">
      <span class="muted small" style="min-width:160px;">${escapeHtml(label)}</span>
      <span>${value != null && value !== '' ? escapeHtml(String(value)) : '<span class="muted">—</span>'}</span>
    </div>
  `
}

// ─── Multi-tract addresses ─────────────────────────────────────────────────

function renderMultiTractCard(prop) {
  const items = (prop.addresses || []).map(a => `
    <li>
      <strong>${escapeHtml(a.address || '?')}</strong>
      <span class="muted small">— parcel ${escapeHtml(a.parcelId || '?')}</span>
    </li>
  `).join('')
  return `
    <div class="card">
      <h3 style="margin-top:0;">All ${prop.tracts} addresses on this case</h3>
      <ul style="padding-left:20px;">${items}</ul>
    </div>
  `
}

// ─── History table with per-row source PDF links ───────────────────────────

function renderHistoryCard(prop, uploadsByHistory) {
  const rows = prop.history.map((h, i) => {
    const up = uploadsByHistory[i]
    const sourceLink = up
      ? `<a href="#" class="source-pdf-link small" data-upload-id="${escapeAttr(up.id)}">View source PDF</a>`
      : `<span class="muted small">source missing</span>`
    const isCurrent = i === 0
    return `
      <tr style="${isCurrent ? 'background:#fef9c3;' : ''}">
        <td>${escapeHtml(formatMonth(h.saleMonth))}</td>
        <td>${escapeHtml(h.status || '—')}</td>
        <td style="text-align:right;">${h.openingBid != null ? '$' + h.openingBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
        <td style="text-align:right;">${h.soldFor != null ? '$' + h.soldFor.toLocaleString() : '—'}</td>
        <td>${escapeHtml(h.soldTo || '—')}</td>
        <td>${sourceLink}</td>
      </tr>
    `
  }).join('')

  return `
    <div class="card">
      <h3 style="margin-top:0;">History across sales</h3>
      <p class="muted small" style="margin-top:0;">
        The highlighted row is the most recent appearance and the source of the
        top-level "current" values above.
      </p>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--color-border);">
              <th style="padding:6px 8px;">Sale month</th>
              <th style="padding:6px 8px;">Status</th>
              <th style="padding:6px 8px;text-align:right;">Opening bid</th>
              <th style="padding:6px 8px;text-align:right;">Sold for</th>
              <th style="padding:6px 8px;">Sold to</th>
              <th style="padding:6px 8px;">Source</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `
}

function wireSourcePdfLinks(el) {
  el.querySelectorAll('.source-pdf-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault()
      const uploadId = link.dataset.uploadId
      const blob = await getUploadBlob(uploadId)
      if (!blob) {
        alert('Source PDF not found in storage (the upload may have been deleted).')
        return
      }
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      // Browser cleans up the object URL when this tab navigates away.
    })
  })
}

// ─── Comments (structured + raw) ───────────────────────────────────────────

function renderCommentsCard(prop) {
  const c = prop.commentsParsed || {}

  const postSection = (c.postponementHistory || []).length > 0 ? `
    <div class="field">
      <label>Postponement chain (${c.postponementHistory.length})</label>
      <div class="small muted">${c.postponementHistory.map(d => escapeHtml(d)).join(' • ')}</div>
    </div>
  ` : ''

  const bkSection = (c.bankruptcyHistory || []).length > 0 ? `
    <div class="field">
      <label>Bankruptcy history (${c.bankruptcyHistory.length})</label>
      <ul style="padding-left:20px;margin:4px 0;" class="small">
        ${c.bankruptcyHistory.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
      </ul>
    </div>
  ` : ''

  const replSection = `
    <div class="field">
      <label>Replenishment</label>
      <div class="small">
        ${c.replenishmentUnpaid
          ? `<span class="tag" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;">UNPAID — case cannot go to sale</span>`
          : `<span class="muted">No issue flagged</span>`}
      </div>
    </div>
  `

  const stayedSection = (c.stayedNotes || []).length > 0 ? `
    <div class="field">
      <label>Stayed notes</label>
      <ul style="padding-left:20px;margin:4px 0;" class="small">
        ${c.stayedNotes.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
      </ul>
    </div>
  ` : ''

  const soldSection = (c.soldNotes || []).length > 0 ? `
    <div class="field">
      <label>Sold / deed notes</label>
      <ul style="padding-left:20px;margin:4px 0;" class="small">
        ${c.soldNotes.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
      </ul>
    </div>
  ` : ''

  return `
    <div class="card">
      <h3 style="margin-top:0;">Comments</h3>
      ${postSection}
      ${bkSection}
      ${replSection}
      ${stayedSection}
      ${soldSection}

      <div class="field" style="margin-bottom:0;">
        <label>Raw comments block (verbatim from the PDF)</label>
        <pre style="white-space:pre-wrap;background:var(--color-bg);padding:12px;border-radius:6px;border:1px solid var(--color-border);font-size:13px;margin:0;">${escapeHtml(prop.commentsRaw || '(no comments)')}</pre>
      </div>
    </div>
  `
}
