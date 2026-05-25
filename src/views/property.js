import { getProperty, updateUserFields } from '../storage/properties.js'
import { getUpload, getUploadBlob } from '../storage/uploads.js'
import { getAssessor } from '../enrichment/assessor.js'
import { getViolations } from '../enrichment/violations.js'
import { getPermits } from '../enrichment/permits.js'
import { validateProperty } from '../pdf/validation.js'
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
  loadEnrichment(el, prop, current)
  loadPittsburghData(el, prop)
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

    ${renderValidationBanner(prop)}
    ${renderUserFieldsCard(prop)}
    ${renderSaleInfoCard(prop, current)}
    ${renderEnrichmentPlaceholder()}
    ${renderPittsburghPlaceholder(prop)}
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

// ─── Validation banner ─────────────────────────────────────────────────────

function renderValidationBanner(prop) {
  // Re-validate at display time so existing records pick up rule updates
  // without needing a full re-parse.
  const v = validateProperty(prop)
  if (v.ok) return ''
  const items = v.issues.map(s => `<li>${escapeHtml(s)}</li>`).join('')
  return `
    <div class="banner warn">
      <strong>This record didn't pass validation.</strong> One or more fields look wrong:
      <ul style="margin:6px 0 0 0;padding-left:20px;font-size:13px;">${items}</ul>
      <div class="spacer"></div>
      <div class="small">Use the <em>View source PDF</em> link in the history table below to compare against the original, and re-parse the upload to retry.</div>
    </div>
  `
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

// ─── Property Assessment (WPRDC enrichment) + Spread analysis ──────────────

function renderEnrichmentPlaceholder() {
  return `
    <div class="card" id="enrichment-zone">
      <h3 style="margin-top:0;">Property Assessment</h3>
      <p class="muted small">Loading assessor data from WPRDC…</p>
    </div>
  `
}

async function loadEnrichment(el, prop, current, { force = false } = {}) {
  const zone = el.querySelector('#enrichment-zone')
  if (!zone) return

  const result = await getAssessor(prop.parcelId, { force })
  zone.outerHTML = renderEnrichmentCard(prop, current, result)

  // Rewire any event handlers inside the freshly-rendered card.
  const newZone = el.querySelector('#enrichment-zone')
  const refreshBtn = newZone?.querySelector('#refresh-assessor')
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      // Replace card with loading state then re-call with force.
      newZone.outerHTML = renderEnrichmentPlaceholder()
      loadEnrichment(el, prop, current, { force: true })
    })
  }
}

function renderEnrichmentCard(prop, current, result) {
  const refreshLink = `<a href="#" id="refresh-assessor" class="small">Refresh</a>`

  if (result.status === 'normalize-failed') {
    return `
      <div class="card" id="enrichment-zone">
        <h3 style="margin-top:0;">Property Assessment</h3>
        <div class="banner warn">
          Couldn't normalize parcel ID <code>${escapeHtml(prop.parcelId || '?')}</code> to the
          WPRDC format. The Sheriff PDF may have used an unusual format. You can look this
          property up manually at
          <a href="https://www2.alleghenycounty.us/RealEstate/" target="_blank" rel="noopener">
            Allegheny County Real Estate
          </a>.
        </div>
      </div>
    `
  }

  if (result.status === 'error') {
    return `
      <div class="card" id="enrichment-zone">
        <h3 style="margin-top:0;">Property Assessment</h3>
        <div class="banner err">
          Failed to fetch assessor data: ${escapeHtml(result.error)}
        </div>
        <div class="row">${refreshLink}</div>
      </div>
    `
  }

  if (result.status === 'not-found') {
    return `
      <div class="card" id="enrichment-zone">
        <h3 style="margin-top:0;">Property Assessment</h3>
        <div class="banner warn">
          No assessor record found for parcel <code>${escapeHtml(result.parid)}</code>.
          This could mean the parcel was recently subdivided/merged, or the Sheriff PDF's parcel format doesn't match WPRDC's.
        </div>
        <div class="row">${refreshLink}</div>
      </div>
    `
  }

  // status === 'ok'
  const d = result.data
  return `
    <div class="card" id="enrichment-zone">
      <h3 style="margin-top:0;">Property Assessment</h3>

      <div class="row" style="gap:24px;flex-wrap:wrap;">
        <div style="flex:1;min-width:240px;">
          <h4 class="muted small" style="margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">Building</h4>
          ${kv('Use', d.USEDESC)}
          ${kv('Style', d.STYLEDESC)}
          ${kv('Year built', d.YEARBLT ? Math.round(d.YEARBLT) : null)}
          ${kv('Stories', d.STORIES)}
          ${kv('Finished sq ft', d.FINISHEDLIVINGAREA ? Math.round(d.FINISHEDLIVINGAREA).toLocaleString() : null)}
          ${kv('Bedrooms', d.BEDROOMS != null ? d.BEDROOMS : null)}
          ${kv('Full baths', d.FULLBATHS != null ? d.FULLBATHS : null)}
          ${kv('Half baths', d.HALFBATHS != null ? d.HALFBATHS : null)}
          ${kv('Condition', d.CONDITIONDESC)}
          ${kv('Grade', d.GRADEDESC)}
          ${kv('Lot area (sq ft)', d.LOTAREA ? Math.round(d.LOTAREA).toLocaleString() : null)}
        </div>

        <div style="flex:1;min-width:240px;">
          <h4 class="muted small" style="margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">Valuation</h4>
          ${kv('Fair market value', money(d.FAIRMARKETTOTAL))}
          ${kv('County assessed', money(d.COUNTYTOTAL))}
          ${kv('Last sale', formatSale(d.SALEDATE, d.SALEPRICE))}
          ${d.PREVSALEDATE ? kv('Prior sale', formatSale(d.PREVSALEDATE, d.PREVSALEPRICE)) : ''}
          ${kv('Owner of record', d.CHANGENOTICEADDRESS1)}
        </div>
      </div>

      <div class="spacer"></div>
      ${renderSpread(prop, current, d)}

      <div class="row" style="margin-top:12px;justify-content:space-between;">
        <span class="muted small">
          ${result.fromCache
            ? `From cache, fetched ${formatRelative(result.fetchedAt)}.`
            : `Just fetched from WPRDC.`}
        </span>
        ${refreshLink}
      </div>
    </div>
  `
}

function renderSpread(prop, current, assessorData) {
  const fairMarket = assessorData.FAIRMARKETTOTAL || null
  const openingBid = current.openingBid ?? null
  const userMaxBid = prop.userFields?.maxBid ?? null
  const userArvOverride = prop.userFields?.arvOverride ?? null

  // ARV = user's override if set, else WPRDC fair market value.
  const arv = userArvOverride ?? fairMarket
  const arvSource = userArvOverride != null ? 'your override' : 'WPRDC fair-market value'

  if (arv == null || openingBid == null) {
    return `
      <h4 class="muted small" style="margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">Spread analysis</h4>
      <p class="muted small">Need both an ARV and an opening bid to compute spread.</p>
    `
  }

  const spreadOpen = arv - openingBid
  const marginIfWon = userMaxBid != null ? arv - userMaxBid : null

  return `
    <h4 class="muted small" style="margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">Spread analysis</h4>
    <div class="row" style="gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        ${kv('Opening bid', money(openingBid))}
        ${kv('ARV (' + arvSource + ')', money(arv))}
        ${kv('Spread at opening', signedMoneyHtml(spreadOpen))}
      </div>
      <div style="flex:1;min-width:200px;">
        ${kv('Your max bid', userMaxBid != null ? money(userMaxBid) : '<span class="muted">not set</span>')}
        ${marginIfWon != null
          ? kv('Margin if won at max', signedMoneyHtml(marginIfWon))
          : kv('Margin if won at max', '<span class="muted">set a max bid above</span>')}
      </div>
    </div>
  `
}

// ─── Small formatting helpers used by the enrichment card ─────────────────

function kv(label, value) {
  return `
    <div class="row" style="padding:4px 0;font-size:14px;">
      <span class="muted small" style="min-width:140px;">${escapeHtml(label)}</span>
      <span>${value != null && value !== '' ? value : '<span class="muted">—</span>'}</span>
    </div>
  `
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return null
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function signedMoneyHtml(n) {
  if (n == null || !Number.isFinite(Number(n))) return null
  const sign = n >= 0 ? '+' : '−'
  const abs = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
  const color = n >= 0 ? 'var(--color-ok)' : 'var(--color-err)'
  return `<strong style="color:${color}">${sign}$${abs}</strong>`
}

function formatSale(date, price) {
  if (!date && price == null) return null
  const m = money(price)
  if (m && date) return `${m} on ${escapeHtml(date)}`
  if (m) return m
  return escapeHtml(date)
}

function formatRelative(ts) {
  const diffMs = Date.now() - ts
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  return `${day} day${day === 1 ? '' : 's'} ago`
}

// ─── Pittsburgh-only data (PLI Violations + Permits) ───────────────────────

function renderPittsburghPlaceholder(prop) {
  if (!prop.isPittsburghProper) {
    // Greyed-out card with explanatory tooltip — pattern Shawn picked at start.
    return `
      <div class="card" id="pgh-zone" style="opacity:0.7;">
        <h3 style="margin-top:0;">Pittsburgh data</h3>
        <div class="banner info">
          <strong>Not available for this property.</strong>
          ${escapeHtml(prop.address || 'This property')} is in
          <strong>${escapeHtml(prop.municipality || 'an unknown municipality')}</strong>,
          not Pittsburgh proper. PLI code violations and building permits are only
          published by the City of Pittsburgh through WPRDC.
        </div>
        <div style="opacity:0.5;">
          ${kv('Open code violations', '<span class="muted">— (data not available)</span>')}
          ${kv('Total PLI permits', '<span class="muted">— (data not available)</span>')}
        </div>
      </div>
    `
  }
  return `
    <div class="card" id="pgh-zone">
      <h3 style="margin-top:0;">Pittsburgh data</h3>
      <p class="muted small">Loading violations and permits from WPRDC…</p>
    </div>
  `
}

async function loadPittsburghData(el, prop, { force = false } = {}) {
  if (!prop.isPittsburghProper) return  // greyed placeholder stays as-is

  const zone = el.querySelector('#pgh-zone')
  if (!zone) return

  const [violationsResult, permitsResult] = await Promise.all([
    getViolations(prop.parcelId, { force }),
    getPermits(prop.parcelId, { force }),
  ])

  zone.outerHTML = renderPittsburghCard(prop, violationsResult, permitsResult)

  // Rewire refresh links inside the freshly rendered card.
  const newZone = el.querySelector('#pgh-zone')
  const refreshBtn = newZone?.querySelector('#refresh-pgh')
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      newZone.outerHTML = `
        <div class="card" id="pgh-zone">
          <h3 style="margin-top:0;">Pittsburgh data</h3>
          <p class="muted small">Refreshing from WPRDC…</p>
        </div>
      `
      loadPittsburghData(el, prop, { force: true })
    })
  }
}

function renderPittsburghCard(prop, vRes, pRes) {
  const violations = vRes.status === 'ok' ? vRes.data : []
  const permits = pRes.status === 'ok' ? pRes.data : []
  const refreshLink = `<a href="#" id="refresh-pgh" class="small">Refresh</a>`

  const anyError = vRes.status === 'error' || pRes.status === 'error'
  const errorBanner = anyError ? `
    <div class="banner err">
      ${vRes.status === 'error' ? `Violations: ${escapeHtml(vRes.error)}<br>` : ''}
      ${pRes.status === 'error' ? `Permits: ${escapeHtml(pRes.error)}` : ''}
    </div>
  ` : ''

  const fetchedAt = vRes.fetchedAt || pRes.fetchedAt
  const fromCache = vRes.fromCache && pRes.fromCache

  return `
    <div class="card" id="pgh-zone">
      <h3 style="margin-top:0;">Pittsburgh data</h3>
      ${errorBanner}
      ${renderViolationsSection(violations)}
      <div class="spacer"></div>
      ${renderPermitsSection(permits)}
      <div class="row" style="margin-top:12px;justify-content:space-between;">
        <span class="muted small">
          ${fetchedAt
            ? (fromCache
                ? `From cache, fetched ${formatRelative(fetchedAt)}.`
                : `Just fetched from WPRDC.`)
            : ''}
        </span>
        ${refreshLink}
      </div>
    </div>
  `
}

function renderViolationsSection(violations) {
  const total = violations.length
  const open = violations.filter(v => /open|active|investigat/i.test(v.status || '')).length
  const closed = violations.filter(v => /closed|complete|resolv/i.test(v.status || '')).length

  let summary
  if (total === 0) {
    summary = `<p class="muted small" style="margin:4px 0;">No code violations on record since June 2020 (the dataset's start date — older violations not shown).</p>`
  } else {
    summary = `
      <p style="margin:4px 0;">
        <strong>${total}</strong> total
        ${open > 0 ? ` • <strong style="color:var(--color-err)">${open} open</strong>` : ''}
        ${closed > 0 ? ` • <span class="muted">${closed} closed</span>` : ''}
      </p>
    `
  }

  // Sort newest first, then split top 10 vs rest.
  const sorted = [...violations].sort((a, b) =>
    (b.investigation_date || '').localeCompare(a.investigation_date || ''))
  const top = sorted.slice(0, 10)
  const rest = sorted.slice(10)

  const topHtml = top.length > 0 ? `
    <ul style="padding-left:18px;margin:6px 0;font-size:14px;">
      ${top.map(violationRow).join('')}
    </ul>
  ` : ''

  const expandHtml = rest.length > 0 ? `
    <details style="margin-top:6px;">
      <summary class="small muted" style="cursor:pointer;">Show ${rest.length} more</summary>
      <ul style="padding-left:18px;margin:6px 0;font-size:14px;">
        ${rest.map(violationRow).join('')}
      </ul>
    </details>
  ` : ''

  return `
    <h4 class="muted small" style="margin:0 0 4px 0;text-transform:uppercase;letter-spacing:0.04em;">
      Code violations
    </h4>
    ${summary}
    ${topHtml}
    ${expandHtml}
  `
}

function violationRow(v) {
  const date = v.investigation_date || '—'
  const type = v.case_file_type || 'Violation'
  const status = v.status || '?'
  const outcome = v.investigation_outcome ? ` (${v.investigation_outcome})` : ''
  const statusColor = /open|active|investigat/i.test(status) ? 'var(--color-err)' : 'var(--color-muted)'
  return `
    <li style="margin-bottom:4px;">
      <span class="muted">${escapeHtml(date)}</span> —
      ${escapeHtml(type)}
      <span style="color:${statusColor}">[${escapeHtml(status)}]</span>${escapeHtml(outcome)}
    </li>
  `
}

function renderPermitsSection(permits) {
  const total = permits.length

  let summary
  if (total === 0) {
    summary = `<p class="muted small" style="margin:4px 0;">No PLI permits on record since June 2019.</p>`
  } else {
    const mostRecent = permits
      .map(p => p.issue_date)
      .filter(Boolean)
      .sort()
      .pop()
    summary = `
      <p style="margin:4px 0;">
        <strong>${total}</strong> total
        ${mostRecent ? ` • most recent ${escapeHtml(mostRecent)}` : ''}
      </p>
    `
  }

  const sorted = [...permits].sort((a, b) =>
    (b.issue_date || '').localeCompare(a.issue_date || ''))
  const top = sorted.slice(0, 10)
  const rest = sorted.slice(10)

  const topHtml = top.length > 0 ? `
    <ul style="padding-left:18px;margin:6px 0;font-size:14px;">
      ${top.map(permitRow).join('')}
    </ul>
  ` : ''

  const expandHtml = rest.length > 0 ? `
    <details style="margin-top:6px;">
      <summary class="small muted" style="cursor:pointer;">Show ${rest.length} more</summary>
      <ul style="padding-left:18px;margin:6px 0;font-size:14px;">
        ${rest.map(permitRow).join('')}
      </ul>
    </details>
  ` : ''

  return `
    <h4 class="muted small" style="margin:0 0 4px 0;text-transform:uppercase;letter-spacing:0.04em;">
      PLI permits
    </h4>
    ${summary}
    ${topHtml}
    ${expandHtml}
  `
}

function permitRow(p) {
  const date = p.issue_date || '—'
  const type = [p.permit_type, p.work_type].filter(Boolean).join(': ')
  const status = p.status || '?'
  const value = p.total_project_value
    ? ` ($${Number(p.total_project_value).toLocaleString()})`
    : ''
  return `
    <li style="margin-bottom:4px;">
      <span class="muted">${escapeHtml(date)}</span> —
      ${escapeHtml(type || 'Permit')}
      <span class="muted">[${escapeHtml(status)}]</span>${value}
    </li>
  `
}
