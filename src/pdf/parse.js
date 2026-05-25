/**
 * STUB — the real PDF parser lands in the NEXT prompt.
 *
 * Future behavior:
 *   1. Read the raw PDF Blob from the `pdf-blobs` store via getUploadBlob(uploadId).
 *   2. Extract text (likely pdf.js or a hand-rolled byte parser, no paid services).
 *   3. Send extracted text to the Anthropic API (using the stored key) to
 *      structure each property entry.
 *   4. For each parsed property, upsert into the `properties` store keyed by
 *      caseNumber — appending to `history[]` rather than overwriting, so
 *      cross-month duplicates collapse into one canonical record.
 *   5. Mark the upload as `parsed: true` and update its `properties` list.
 */
export async function parsePdf(uploadId) {
  console.log('[parsePdf] called for upload', uploadId)
  return {
    ok: false,
    todo: true,
    message: 'PDF parsing is not yet implemented — this is a stub for the next prompt.',
  }
}
