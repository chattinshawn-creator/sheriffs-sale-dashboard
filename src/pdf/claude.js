import { getApiKey } from '../storage/settings.js'
import { SYSTEM_PROMPT, USER_PROMPT, REPAIR_SYSTEM_PROMPT, REPAIR_USER_PROMPT } from './prompts.js'

// IMPORTANT: update this when a newer Sonnet model is released. The API
// returns a clear 404 error if the model name doesn't exist, so a bad value
// won't fail silently. Find current model IDs at:
// https://docs.anthropic.com/en/docs/about-claude/models
export const MODEL = 'claude-sonnet-4-5-20250929'

// Pricing in dollars per token. Cache reads are ~10% of input pricing; cache
// writes are ~125% of input pricing. Values may drift — verify at:
// https://www.anthropic.com/pricing
const PRICING = {
  input:        3.00 / 1_000_000,
  output:      15.00 / 1_000_000,
  cacheRead:    0.30 / 1_000_000,
  cacheWrite:   3.75 / 1_000_000,
}

const API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Send one PDF chunk to Claude and get back structured properties.
 *
 * @param {Blob} pdfChunk - the chunk to send (a small PDF, usually ~8 pages)
 * @returns {Promise<{properties: object[], usage: object, cost: number}>}
 */
export async function extractFromChunk(pdfChunk) {
  const apiKey = await getApiKey()
  if (!apiKey) {
    throw new Error('No Anthropic API key saved. Add one on the Settings page.')
  }

  const base64Pdf = await blobToBase64(pdfChunk)

  const body = {
    model: MODEL,
    // 16384 fits comment-heavy chunks of ~15 properties without truncation.
    // Sonnet 4+ supports much higher if needed; bump further if you ever see
    // "stop_reason: max_tokens" errors on larger chunks.
    max_tokens: 16384,
    // Lowest temperature for structured extraction — we want the same
    // parser output every time, not creativity.
    temperature: 0,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Cache the system prompt so chunks 2..N read it at ~10% of full cost.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Pdf,
            },
          },
          { type: 'text', text: USER_PROMPT },
        ],
      },
    ],
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for browser-direct API calls. The "dangerous" naming reflects
      // that the API key is visible to anyone with browser access — Shawn
      // accepted this tradeoff in Settings.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${text}`)
  }

  const data = await res.json()

  // Claude returns one or more content blocks. We want the text block.
  const textBlock = data.content?.find(b => b.type === 'text')
  if (!textBlock) {
    throw new Error('No text block in API response: ' + JSON.stringify(data))
  }

  // Detect output-token truncation BEFORE trying to parse, so the user sees
  // a useful error instead of "non-JSON output."
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      `Response truncated: hit max_tokens limit of ${body.max_tokens}. ` +
      `Try reducing the chunk size in src/pdf/chunking.js (DEFAULT_CHUNK_PAGES), ` +
      `or raising max_tokens in src/pdf/claude.js.`
    )
  }

  const properties = parseJsonResponse(textBlock.text)

  const usage = data.usage || {}
  const cost = computeCost(usage)

  return { properties, usage, cost }
}

/**
 * Repair pass: re-extract records that failed validation, using the SAME PDF
 * chunk plus the list of bad records and their detected issues.
 *
 * @param {Blob} pdfChunk - the original chunk PDF
 * @param {Array<{caseNumber: string|null, address: string|null, issues: string[]}>} flaggedRecords
 * @returns {Promise<{repairs: Array, usage: object, cost: number}>}
 *   `repairs[i] = { originalCaseNumber, matchedByAddress, record }`
 */
export async function repairChunk(pdfChunk, flaggedRecords) {
  const apiKey = await getApiKey()
  if (!apiKey) throw new Error('No Anthropic API key saved.')

  const base64Pdf = await blobToBase64(pdfChunk)

  const body = {
    model: MODEL,
    max_tokens: 16384,
    temperature: 0,
    system: [{ type: 'text', text: REPAIR_SYSTEM_PROMPT }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf },
          },
          { type: 'text', text: REPAIR_USER_PROMPT(flaggedRecords) },
        ],
      },
    ],
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${text}`)
  }

  const data = await res.json()
  const textBlock = data.content?.find(b => b.type === 'text')
  if (!textBlock) throw new Error('No text block in repair response')

  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      `Repair response truncated: hit max_tokens limit of ${body.max_tokens}. ` +
      `Reduce chunk size or raise max_tokens.`
    )
  }

  const repairs = parseRepairResponse(textBlock.text)
  const usage = data.usage || {}
  const cost = computeCost(usage)

  return { repairs, usage, cost }
}

function parseRepairResponse(text) {
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  }
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error('Repair returned non-JSON output:\n' + text.slice(0, 500))
  }
  if (!parsed || !Array.isArray(parsed.repairs)) {
    throw new Error('Repair output missing `repairs` array')
  }
  return parsed.repairs
}

/**
 * Strip any accidental markdown fences and parse the JSON.
 */
function parseJsonResponse(text) {
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  }
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error('Model returned non-JSON output:\n' + text.slice(0, 500))
  }
  if (!parsed || !Array.isArray(parsed.properties)) {
    throw new Error('Model output missing `properties` array: ' + JSON.stringify(parsed).slice(0, 500))
  }
  return parsed.properties
}

function computeCost(usage) {
  const inputTokens       = usage.input_tokens                || 0
  const outputTokens      = usage.output_tokens               || 0
  const cacheReadTokens   = usage.cache_read_input_tokens     || 0
  const cacheWriteTokens  = usage.cache_creation_input_tokens || 0
  return (
    inputTokens      * PRICING.input +
    outputTokens     * PRICING.output +
    cacheReadTokens  * PRICING.cacheRead +
    cacheWriteTokens * PRICING.cacheWrite
  )
}

/**
 * Convert a Blob to a base64 string (without the "data:...;base64," prefix).
 * FileReader avoids the call-stack overflow that String.fromCharCode(...)
 * hits on large arrays.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Rough cost estimate BEFORE parsing, so we can show "this will cost ~$X"
 * before the user clicks. Based on observed token shapes:
 *   - ~3500 input tokens per PDF page (per Anthropic's docs)
 *   - ~2000 tokens for the cached system prompt (mostly cached after chunk 1)
 *   - ~300 output tokens per property, ~3 properties per page on average
 * These are rough — actual cost is shown after parsing from real usage data.
 */
export function estimateCost({ pageCount, chunkSize }) {
  const chunks = Math.ceil(pageCount / chunkSize)
  const systemPromptTokens = 2000
  const tokensPerPage = 3500
  const outputTokensPerPage = 900

  const inputCost =
    // First chunk pays full system-prompt cost as a cache write.
    systemPromptTokens * PRICING.cacheWrite +
    // Remaining chunks read the cached system prompt at 10% cost.
    systemPromptTokens * PRICING.cacheRead * (chunks - 1) +
    // All chunks pay full price for their PDF input.
    pageCount * tokensPerPage * PRICING.input
  const outputCost = pageCount * outputTokensPerPage * PRICING.output

  return inputCost + outputCost
}
