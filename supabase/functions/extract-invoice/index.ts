// Deno edge function — deployed by hand through the Supabase dashboard (see the PR
// description for steps). Reads GEMINI_API_KEY from Deno.env so it never reaches the browser.

import {
  DEFAULT_EXTRACTION_MODEL,
  EXTRACTION_PROMPT,
  GEMINI_RESPONSE_SCHEMA,
  parseExtractionResponseText,
  type ExtractInvoiceRequest,
  type ExtractInvoiceResponse,
} from '../../../src/lib/extractionSchema.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_STATUSES = new Set([429, 503])

function jsonResponse(body: ExtractInvoiceResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Pure — kept separate from callGemini so the retry/backoff policy is unit-testable
// without mocking fetch.
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

export function backoffDelayMs(attempt: number, jitter = Math.random() * 250): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + jitter
}

// Exponential backoff with jitter on 429/503 — the free tier throttles and 503s
// happen, and a demo that dies on a transient error is the failure mode to avoid.
async function callGemini(model: string, apiKey: string, pdfBase64: string): Promise<string> {
  const url = `${GEMINI_API_BASE}/${model}:generateContent`
  const requestBody = {
    contents: [
      {
        parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }, { text: EXTRACTION_PROMPT }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    },
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    })

    if (response.ok) {
      const payload = await response.json()
      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
      if (typeof text !== 'string') {
        throw new Error(`Gemini response had no text part: ${JSON.stringify(payload)}`)
      }
      return text
    }

    if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
      await sleep(backoffDelayMs(attempt))
      continue
    }

    const errorText = await response.text()
    throw new Error(`Gemini request failed (${response.status}): ${errorText}`)
  }

  throw new Error('Gemini request failed after retries')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY')
  if (!apiKey) {
    return jsonResponse({ ok: false, error: 'GEMINI_API_KEY is not configured' }, 500)
  }

  const model = Deno.env.get('EXTRACTION_MODEL') || DEFAULT_EXTRACTION_MODEL

  let request: ExtractInvoiceRequest
  try {
    request = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Request body was not valid JSON' }, 400)
  }

  if (typeof request.pdf_base64 !== 'string' || request.pdf_base64.length === 0) {
    return jsonResponse({ ok: false, error: 'pdf_base64 is required' }, 400)
  }

  const startedAt = performance.now()
  const invoiceNumber = request.invoice_number ?? 'unknown'

  try {
    const text = await callGemini(model, apiKey, request.pdf_base64)
    const data = parseExtractionResponseText(text)
    const duration_ms = Math.round(performance.now() - startedAt)

    console.log(`extract-invoice ok model=${model} invoice_number=${invoiceNumber} duration_ms=${duration_ms}`)

    return jsonResponse({ ok: true, data, model, duration_ms }, 200)
  } catch (err) {
    const duration_ms = Math.round(performance.now() - startedAt)
    const message = err instanceof Error ? err.message : String(err)

    console.log(`extract-invoice failed model=${model} invoice_number=${invoiceNumber} duration_ms=${duration_ms}`)

    return jsonResponse({ ok: false, error: message }, 502)
  }
})
