import { stores, get, set, del, keys, values, entries } from './db.js'

/**
 * Manual JSON backup / restore of the archive.
 *
 * The archive normally lives only in this browser's IndexedDB. This module
 * serializes it to a single portable JSON file (and reads one back) so the
 * user can keep a durable copy and move it between machines — without adding
 * a second always-on store.
 *
 * Export shape:
 *   {
 *     version: 1,
 *     exportedAt: ISO string,
 *     counts: { uploads, properties },
 *     uploads:    [ ...upload metadata... ],
 *     properties: [ ...canonical properties incl. history[] and userFields... ],
 *     pdfBlobs?:  [ { id, type, name, base64 } ]   // only when includePdfs
 *   }
 */
export const ARCHIVE_FORMAT_VERSION = 1

// ── Export ──────────────────────────────────────────────────────────────────

export async function buildArchiveExport({ includePdfs = false } = {}) {
  const [uploads, properties] = await Promise.all([
    values(stores.uploads),
    values(stores.properties),
  ])

  const out = {
    version: ARCHIVE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { uploads: uploads.length, properties: properties.length },
    uploads,
    properties,
  }

  if (includePdfs) {
    const blobEntries = await entries(stores.pdfBlobs)
    out.pdfBlobs = []
    for (const [id, blob] of blobEntries) {
      if (!blob) continue
      out.pdfBlobs.push({
        id,
        type: blob.type || 'application/pdf',
        name: blob.name || null,
        base64: await blobToBase64(blob),
      })
    }
  }

  return out
}

// ── Inspect / validate (used before any write on import) ────────────────────

/**
 * Validate the parsed JSON's shape and version WITHOUT touching the store.
 * Returns a plain-language summary on success, or { ok:false, error } on
 * anything unexpected so the caller can refuse rather than corrupt the store.
 */
export function inspectArchive(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'This file is not a Sheriff’s Sale archive (it isn’t a JSON object).' }
  }
  if (data.version !== ARCHIVE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `Unsupported archive version: ${JSON.stringify(data.version)}. ` +
        `This app understands version ${ARCHIVE_FORMAT_VERSION}.`,
    }
  }
  if (!Array.isArray(data.uploads) || !Array.isArray(data.properties)) {
    return { ok: false, error: 'Archive is missing its uploads or properties list.' }
  }

  // Sale-month range, drawn from upload metadata (falling back to history).
  const months = []
  for (const u of data.uploads) if (u && u.saleMonth) months.push(u.saleMonth)
  if (months.length === 0) {
    for (const p of data.properties) {
      for (const h of (p?.history || [])) if (h?.saleMonth) months.push(h.saleMonth)
    }
  }
  months.sort()

  const hasPdfs = Array.isArray(data.pdfBlobs) && data.pdfBlobs.length > 0
  return {
    ok: true,
    version: data.version,
    exportedAt: data.exportedAt || null,
    uploads: data.uploads.length,
    properties: data.properties.length,
    monthMin: months[0] || null,
    monthMax: months[months.length - 1] || null,
    hasPdfs,
    pdfCount: hasPdfs ? data.pdfBlobs.length : 0,
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

/**
 * Restore an archive into IndexedDB.
 *
 * mode 'merge'  — add/update records from the file but keep what's already
 *                 here. On a caseNumber collision the incoming record wins for
 *                 parser/enrichment fields, but the LOCAL userFields (notes,
 *                 max bids, flags) are never overwritten, and history entries
 *                 are unioned by uploadId so no sale months are lost.
 * mode 'replace'— wipe uploads/properties (and pdf-blobs) first, then load the
 *                 file's contents verbatim.
 *
 * Validates before writing; throws with a clear message on bad input.
 */
export async function importArchive(data, { mode } = {}) {
  const info = inspectArchive(data)
  if (!info.ok) throw new Error(info.error)
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`Unknown import mode: ${JSON.stringify(mode)}`)
  }

  const result = {
    mode,
    uploadsAdded: 0, uploadsUpdated: 0,
    propsAdded: 0, propsUpdated: 0,
    pdfsRestored: 0,
  }

  if (mode === 'replace') {
    await clearStore(stores.uploads)
    await clearStore(stores.properties)
    await clearStore(stores.pdfBlobs)
  }

  // Uploads (keyed by id).
  for (const u of data.uploads) {
    if (!u || !u.id) continue
    if (mode === 'merge') {
      const existing = await get(u.id, stores.uploads)
      if (existing) result.uploadsUpdated++
      else result.uploadsAdded++
    } else {
      result.uploadsAdded++
    }
    await set(u.id, u, stores.uploads)
  }

  // Properties (keyed by caseNumber).
  for (const incoming of data.properties) {
    if (!incoming || !incoming.caseNumber) continue
    if (mode === 'merge') {
      const existing = await get(incoming.caseNumber, stores.properties)
      if (existing) {
        await set(incoming.caseNumber, mergeProperty(existing, incoming), stores.properties)
        result.propsUpdated++
      } else {
        await set(incoming.caseNumber, incoming, stores.properties)
        result.propsAdded++
      }
    } else {
      await set(incoming.caseNumber, incoming, stores.properties)
      result.propsAdded++
    }
  }

  // PDF blobs (optional).
  if (info.hasPdfs) {
    for (const b of data.pdfBlobs) {
      if (!b || !b.id || !b.base64) continue
      await set(b.id, base64ToBlob(b.base64, b.type), stores.pdfBlobs)
      result.pdfsRestored++
    }
  }

  return result
}

/**
 * Merge an incoming property onto an existing one. Incoming wins for
 * parser/enrichment fields; local userFields are preserved; history entries
 * are unioned by uploadId (incoming wins on a shared uploadId) and re-sorted
 * newest-first.
 */
export function mergeProperty(existing, incoming) {
  const byUpload = new Map()
  for (const h of (incoming.history || [])) if (h?.uploadId) byUpload.set(h.uploadId, h)
  for (const h of (existing.history || [])) if (h?.uploadId && !byUpload.has(h.uploadId)) byUpload.set(h.uploadId, h)

  // Preserve any (rare) history entries that lack an uploadId from both sides.
  const noId = [...(existing.history || []), ...(incoming.history || [])].filter(h => h && !h.uploadId)

  const history = [...byUpload.values(), ...noId]
    .sort((a, b) => (b.saleMonth || '').localeCompare(a.saleMonth || ''))

  return {
    ...incoming,
    // Never clobber the user's own fields. Fall back to incoming's only if the
    // local record somehow has none.
    userFields: existing.userFields ?? incoming.userFields,
    history,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function clearStore(store) {
  const ks = await keys(store)
  for (const k of ks) await del(k, store)
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBlob(b64, type) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: type || 'application/pdf' })
}
