import { getUpload, getUploadBlob } from '../storage/uploads.js'
import { stores, set } from '../storage/db.js'
import { upsertProperty } from '../storage/properties.js'
import { splitPdfIntoChunks, DEFAULT_CHUNK_PAGES } from './chunking.js'
import { extractFromChunk, estimateCost } from './claude.js'

/**
 * Parse a previously-uploaded PDF: chunk it, send each chunk to Claude,
 * upsert each property into IndexedDB. Reports progress via callback.
 *
 * @param {string} uploadId
 * @param {{
 *   onProgress?: (info: {
 *     phase: 'chunking' | 'parsing' | 'done',
 *     chunkIdx: number, totalChunks: number,
 *     pageStart: number, pageEnd: number,
 *     savedSoFar: number, costSoFar: number,
 *     lastError?: string,
 *   }) => void,
 *   onlyChunks?: number[],   // chunk indices to run (default: all). Used for retry.
 * }} [options]
 * @returns {Promise<{
 *   savedCount: number,
 *   totalCost: number,
 *   failedChunks: Array<{ idx: number, pageStart: number, pageEnd: number, error: string }>,
 *   totalChunks: number,
 *   usage: object,
 * }>}
 */
export async function parsePdf(uploadId, options = {}) {
  const { onProgress = () => {}, onlyChunks = null } = options

  const upload = await getUpload(uploadId)
  if (!upload) throw new Error(`Upload not found: ${uploadId}`)
  const blob = await getUploadBlob(uploadId)
  if (!blob) throw new Error(`PDF blob missing for upload ${uploadId}`)

  onProgress({
    phase: 'chunking', chunkIdx: 0, totalChunks: 0,
    pageStart: 0, pageEnd: 0, savedSoFar: 0, costSoFar: 0,
  })

  const chunks = await splitPdfIntoChunks(blob, DEFAULT_CHUNK_PAGES)
  const totalChunks = chunks.length

  const failedChunks = []
  const aggregateUsage = {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }
  let savedCount = 0
  let costSoFar = 0

  const chunkIndicesToRun = onlyChunks ?? chunks.map((_, i) => i)

  for (const idx of chunkIndicesToRun) {
    const chunk = chunks[idx]
    onProgress({
      phase: 'parsing', chunkIdx: idx, totalChunks,
      pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
      savedSoFar: savedCount, costSoFar,
    })

    try {
      const { properties, usage, cost } = await extractFromChunk(chunk.blob)

      for (const parsed of properties) {
        if (!parsed.caseNumber) continue  // chunk-boundary cut-off, per prompt rule
        await upsertProperty(parsed, {
          uploadId,
          saleMonth: upload.saleMonth,
        })
        savedCount++
      }

      costSoFar += cost
      aggregateUsage.input_tokens               += usage.input_tokens               || 0
      aggregateUsage.output_tokens              += usage.output_tokens              || 0
      aggregateUsage.cache_read_input_tokens    += usage.cache_read_input_tokens    || 0
      aggregateUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0
    } catch (e) {
      console.error(`[parsePdf] chunk ${idx} (pages ${chunk.pageStart}-${chunk.pageEnd}) failed:`, e)
      failedChunks.push({
        idx,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        error: String(e?.message || e),
      })
      onProgress({
        phase: 'parsing', chunkIdx: idx, totalChunks,
        pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
        savedSoFar: savedCount, costSoFar,
        lastError: String(e?.message || e),
      })
    }
  }

  // Mark the upload as parsed (or partially parsed) so the UI can reflect it.
  const updated = {
    ...upload,
    parsed: failedChunks.length === 0,
    lastParsedAt: Date.now(),
    lastParseStats: {
      savedCount,
      totalCost: costSoFar,
      failedChunkCount: failedChunks.length,
      usage: aggregateUsage,
    },
  }
  await set(uploadId, updated, stores.uploads)

  onProgress({
    phase: 'done', chunkIdx: totalChunks, totalChunks,
    pageStart: 0, pageEnd: 0,
    savedSoFar: savedCount, costSoFar,
  })

  return {
    savedCount,
    totalCost: costSoFar,
    failedChunks,
    totalChunks,
    usage: aggregateUsage,
  }
}

// Re-export for convenience so the upload view can show pre-parse estimates.
export { estimateCost }
