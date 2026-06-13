import { getUpload, getUploadBlob } from '../storage/uploads.js'
import { stores, set } from '../storage/db.js'
import { upsertProperty } from '../storage/properties.js'
import { splitPdfIntoChunks, DEFAULT_CHUNK_PAGES } from './chunking.js'
import { extractFromChunk, repairChunk, estimateCost } from './claude.js'
import { validateProperty } from './validation.js'

/**
 * Parse a previously-uploaded PDF: chunk it, send each chunk to Claude,
 * VALIDATE each returned record, REPAIR flagged records with a follow-up
 * targeted call, then upsert into IndexedDB.
 *
 * @param {string} uploadId
 * @param {{
 *   onProgress?: (info: {
 *     phase: 'chunking' | 'parsing' | 'repairing' | 'done',
 *     chunkIdx: number, totalChunks: number,
 *     pageStart: number, pageEnd: number,
 *     savedSoFar: number, repairedSoFar: number, flaggedSoFar: number,
 *     costSoFar: number,
 *     lastError?: string,
 *   }) => void,
 *   onlyChunks?: number[],
 * }} [options]
 * @returns {Promise<{
 *   savedCount: number,
 *   repairedCount: number,
 *   flaggedCount: number,
 *   totalCost: number,
 *   failedChunks: Array,
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
    pageStart: 0, pageEnd: 0,
    savedSoFar: 0, repairedSoFar: 0, flaggedSoFar: 0, costSoFar: 0,
  })

  const chunks = await splitPdfIntoChunks(blob, DEFAULT_CHUNK_PAGES)
  const totalChunks = chunks.length

  const failedChunks = []
  const aggregateUsage = {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }
  let savedCount = 0
  let repairedCount = 0
  let flaggedCount = 0
  let costSoFar = 0

  const chunkIndicesToRun = onlyChunks ?? chunks.map((_, i) => i)

  for (const idx of chunkIndicesToRun) {
    const chunk = chunks[idx]
    onProgress({
      phase: 'parsing', chunkIdx: idx, totalChunks,
      pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
      savedSoFar: savedCount, repairedSoFar: repairedCount,
      flaggedSoFar: flaggedCount, costSoFar,
    })

    let properties
    try {
      const { properties: props, usage, cost } = await extractFromChunk(chunk.blob)
      properties = props
      addUsage(aggregateUsage, usage)
      costSoFar += cost
    } catch (e) {
      console.error(`[parsePdf] extract failed for chunk ${idx}:`, e)
      failedChunks.push({
        idx, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
        error: String(e?.message || e),
      })
      onProgress({
        phase: 'parsing', chunkIdx: idx, totalChunks,
        pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
        savedSoFar: savedCount, repairedSoFar: repairedCount,
        flaggedSoFar: flaggedCount, costSoFar,
        lastError: String(e?.message || e),
      })
      continue
    }

    // Validate every record before considering whether to repair.
    for (const p of properties) {
      p._validation = validateProperty(p)
    }

    // Run a repair pass on any flagged records in this chunk.
    const flaggedIndices = properties
      .map((p, i) => (p._validation.ok ? -1 : i))
      .filter(i => i >= 0)

    if (flaggedIndices.length > 0) {
      onProgress({
        phase: 'repairing', chunkIdx: idx, totalChunks,
        pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
        savedSoFar: savedCount, repairedSoFar: repairedCount,
        flaggedSoFar: flaggedCount, costSoFar,
      })

      try {
        const flaggedSnippets = flaggedIndices.map(i => ({
          caseNumber: properties[i].caseNumber,
          address: properties[i].address,
          issues: properties[i]._validation.issues,
        }))
        const { repairs, usage, cost } = await repairChunk(chunk.blob, flaggedSnippets)
        addUsage(aggregateUsage, usage)
        costSoFar += cost

        // Apply repairs WITHOUT duplicating: each original is either kept
        // or replaced exactly once. Unmatched repairs are appended at the end.
        const replacements = new Map() // origIndex -> repaired record
        const unmatched = []

        for (const repair of repairs) {
          const repaired = repair.record
          if (!repaired) continue
          repaired._validation = validateProperty(repaired)

          const origIdx = findBestMatch(properties, flaggedIndices, repair, repaired, replacements)
          if (origIdx >= 0) {
            replacements.set(origIdx, repaired)
          } else {
            unmatched.push(repaired)
          }
        }

        // Rebuild properties: replace where we have a repair, otherwise keep.
        properties = properties.map((p, i) => replacements.get(i) || p)
        for (const r of unmatched) properties.push(r)

        repairedCount += replacements.size + unmatched.length
      } catch (e) {
        console.warn(`[parsePdf] repair failed for chunk ${idx}:`, e)
        // Keep the originals with their _validation flags.
      }
    }

    // Save all properties (originals + repaired) with their validation stamps.
    for (const p of properties) {
      if (!p.caseNumber) continue
      await upsertProperty(p, {
        uploadId,
        saleMonth: upload.saleMonth,
        uploadType: upload.type,
        uploadedAt: upload.uploadedAt,
      })
      savedCount++
      if (p._validation && !p._validation.ok) flaggedCount++
    }
  }

  // Stamp the upload with parse stats so the UI can show parse quality at a glance.
  const updated = {
    ...upload,
    parsed: failedChunks.length === 0,
    lastParsedAt: Date.now(),
    lastParseStats: {
      savedCount,
      repairedCount,
      flaggedCount,
      totalCost: costSoFar,
      failedChunkCount: failedChunks.length,
      usage: aggregateUsage,
    },
  }
  await set(uploadId, updated, stores.uploads)

  onProgress({
    phase: 'done', chunkIdx: totalChunks, totalChunks,
    pageStart: 0, pageEnd: 0,
    savedSoFar: savedCount, repairedSoFar: repairedCount,
    flaggedSoFar: flaggedCount, costSoFar,
  })

  return {
    savedCount,
    repairedCount,
    flaggedCount,
    totalCost: costSoFar,
    failedChunks,
    totalChunks,
    usage: aggregateUsage,
  }
}

function addUsage(agg, u) {
  agg.input_tokens                += u.input_tokens                || 0
  agg.output_tokens               += u.output_tokens               || 0
  agg.cache_read_input_tokens     += u.cache_read_input_tokens     || 0
  agg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0
}

/**
 * Find the best flagged original to replace with this repair. Tries four
 * matching strategies in order. Skips originals that have already been
 * replaced by a previous repair (so two repairs targeting the same original
 * don't collide — the second one falls through to "unmatched" and gets
 * appended, which is the right behavior if the model returned the same
 * entry twice or extracted a genuinely new one).
 *
 * Only considers flagged originals — we never replace a clean record.
 */
function findBestMatch(properties, flaggedIndices, repair, repaired, alreadyReplaced) {
  const candidates = flaggedIndices.filter(i => !alreadyReplaced.has(i))
  if (candidates.length === 0) return -1

  // 1. The repair's stated originalCaseNumber matches a flagged original.
  if (repair.originalCaseNumber) {
    const hit = candidates.find(i => properties[i].caseNumber === repair.originalCaseNumber)
    if (hit !== undefined) return hit
  }
  // 2. The repair's stated matchedByAddress substring-matches a flagged original's address.
  if (repair.matchedByAddress) {
    const needle = String(repair.matchedByAddress).toUpperCase()
    const hit = candidates.find(i => {
      const a = String(properties[i].address || '').toUpperCase()
      return a && (a.includes(needle) || needle.includes(a))
    })
    if (hit !== undefined) return hit
  }
  // 3. The repaired record's OWN caseNumber matches a flagged original
  //    (catches the case where Claude returns the corrected case# in both
  //    fields).
  if (repaired.caseNumber) {
    const hit = candidates.find(i => properties[i].caseNumber === repaired.caseNumber)
    if (hit !== undefined) return hit
  }
  // 4. The repaired record's address substring-matches a flagged original.
  if (repaired.address) {
    const needle = String(repaired.address).slice(0, 20).toUpperCase()
    const hit = candidates.find(i => {
      const a = String(properties[i].address || '').toUpperCase()
      return a && a.includes(needle)
    })
    if (hit !== undefined) return hit
  }
  return -1
}

export { estimateCost }
