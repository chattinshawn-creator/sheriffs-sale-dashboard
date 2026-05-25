import { stores, get, set, del, keys, values } from './db.js'

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * Save a new upload to the archive (APPEND-ONLY).
 * Metadata goes in the `uploads` store; the raw file goes in `pdf-blobs`
 * under the same id so the heavy Blob doesn't get loaded when we just
 * want to list metadata.
 *
 * upload = {
 *   id, type ('listings' | 'results'), uploadedAt, filename, size, pageCount,
 *   saleMonth ('YYYY-MM'), parsed: false, properties: []
 * }
 */
export async function saveUpload({ file, type, pageCount, saleMonth }) {
  const id = newId()
  const upload = {
    id,
    type,
    uploadedAt: Date.now(),
    filename: file.name,
    size: file.size,
    pageCount,
    saleMonth,
    parsed: false,
    properties: [],
  }
  await set(id, upload, stores.uploads)
  await set(id, file, stores.pdfBlobs)
  return upload
}

export async function listUploads() {
  return (await values(stores.uploads))
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
}

export async function countUploads() {
  return (await keys(stores.uploads)).length
}

export async function getUpload(id) {
  return get(id, stores.uploads)
}

export async function getUploadBlob(id) {
  return get(id, stores.pdfBlobs)
}

export async function deleteUpload(id) {
  await del(id, stores.uploads)
  await del(id, stores.pdfBlobs)
}

/**
 * Duplicate = same filename AND same byte size.
 * We deliberately don't hash file contents — for production-sized PDFs (few
 * MB each) that would mean reading the whole blob into memory just to check
 * for a duplicate. Filename + size is good enough for one-user use.
 */
export async function findDuplicate({ filename, size }) {
  const all = await values(stores.uploads)
  return all.find(u => u.filename === filename && u.size === size) || null
}
