import { PDFDocument } from 'pdf-lib'

/**
 * Default chunk size in pages. 8 keeps each chunk's output well under
 * Sonnet's max_tokens, and gives ~11 chunks for a typical 85-page PDF —
 * good progress visibility without too many API round trips.
 */
export const DEFAULT_CHUNK_PAGES = 8

/**
 * Split a PDF Blob into N-page chunks. Each chunk is a fresh PDF Blob
 * containing only its pages, ready to send to the Anthropic API as a
 * `document` content block.
 *
 * @returns {Promise<Array<{ pageStart: number, pageEnd: number, blob: Blob }>>}
 *   pageStart/pageEnd are 1-indexed inclusive, for human-readable progress
 *   ("chunk 4 of 11: pages 25-32").
 */
export async function splitPdfIntoChunks(pdfBlob, chunkPages = DEFAULT_CHUNK_PAGES) {
  const sourceBytes = await pdfBlob.arrayBuffer()
  const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const totalPages = sourceDoc.getPageCount()

  const chunks = []
  for (let start = 0; start < totalPages; start += chunkPages) {
    const end = Math.min(start + chunkPages, totalPages)
    const indices = []
    for (let i = start; i < end; i++) indices.push(i)

    const chunkDoc = await PDFDocument.create()
    const copiedPages = await chunkDoc.copyPages(sourceDoc, indices)
    for (const page of copiedPages) chunkDoc.addPage(page)
    const chunkBytes = await chunkDoc.save()

    chunks.push({
      pageStart: start + 1,
      pageEnd: end,
      blob: new Blob([chunkBytes], { type: 'application/pdf' }),
    })
  }
  return chunks
}
