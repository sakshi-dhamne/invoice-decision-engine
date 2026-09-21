// Deno edge function — deployed by hand through the Supabase dashboard (see the PR
// description for steps). Reads GEMINI_API_KEY / ANTHROPIC_API_KEY from Deno.env so
// they never reach the browser.
//
// Orchestrates a provider fallback chain (PROVIDER_CHAIN env var, "provider:model"
// entries comma-separated). Gemini models are contended independently of each
// other, and Gemini itself can have a provider-wide outage, so the chain both
// walks Gemini models and — as insurance, not a cost optimisation — falls back to
// Anthropic if every Gemini entry is unavailable.
//
// The retry/backoff/advance policy lives in ../_shared/providerChain.ts, which
// explain-decision uses as well; this file is the extraction-specific part of the
// request: validating the body, building the adapters, shaping the response.

import {
  ACCEPTED_DOCUMENT_TYPES,
  EXTRACTION_PROMPT,
  isAcceptedDocumentType,
  type ExtractInvoiceRequest,
  type ExtractInvoiceResponse,
} from '../../../src/lib/extractionSchema.ts'
import {
  CORS_HEADERS,
  jsonResponse,
  parseProviderChain,
  runProviderChain,
  type ChainEntry,
} from '../_shared/providerChain.ts'
import { createAnthropicProvider } from './providers/anthropic.ts'
import { createGeminiProvider } from './providers/gemini.ts'
import type { ExtractionProvider } from './providers/types.ts'

const DEFAULT_PROVIDER_CHAIN = 'gemini:gemini-3.6-flash,gemini:gemini-3.5-flash,gemini:gemini-3.5-flash-lite,anthropic:claude-sonnet-5'

function buildProvider(
  entry: ChainEntry,
  geminiKey: string | undefined,
  anthropicKey: string | undefined,
): ExtractionProvider | null {
  if (entry.provider === 'gemini') {
    if (!geminiKey) return null
    return createGeminiProvider(entry.model, geminiKey)
  }
  if (!anthropicKey) return null
  return createAnthropicProvider(entry.model, anthropicKey)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' } satisfies ExtractInvoiceResponse, 405)
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')

  let request: ExtractInvoiceRequest
  try {
    request = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Request body was not valid JSON' } satisfies ExtractInvoiceResponse, 400)
  }

  if (typeof request.pdf_base64 !== 'string' || request.pdf_base64.length === 0) {
    return jsonResponse({ ok: false, error: 'pdf_base64 is required' } satisfies ExtractInvoiceResponse, 400)
  }

  // A document with no declared type is a PDF, which is what every caller sent
  // before images were accepted.
  const mimeType = request.mime_type ?? 'application/pdf'
  if (!isAcceptedDocumentType(mimeType)) {
    return jsonResponse(
      {
        ok: false,
        error: `mime_type "${mimeType}" is not one this function reads. Accepted: ${ACCEPTED_DOCUMENT_TYPES.join(', ')}`,
      } satisfies ExtractInvoiceResponse,
      400,
    )
  }

  let chain: ChainEntry[]
  try {
    chain = parseProviderChain(Deno.env.get('PROVIDER_CHAIN') || DEFAULT_PROVIDER_CHAIN)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ ok: false, error: `PROVIDER_CHAIN is misconfigured: ${message}` }, 500)
  }

  if (request.provider) {
    if (request.provider !== 'gemini' && request.provider !== 'anthropic') {
      return jsonResponse({ ok: false, error: `Unknown provider "${request.provider}"` }, 400)
    }
    chain = chain.filter((entry) => entry.provider === request.provider)
    if (chain.length === 0) {
      return jsonResponse(
        { ok: false, error: `PROVIDER_CHAIN has no entries for forced provider "${request.provider}"` },
        400,
      )
    }
    const hasKey = request.provider === 'gemini' ? !!geminiKey : !!anthropicKey
    if (!hasKey) {
      return jsonResponse({ ok: false, error: `Forced provider "${request.provider}" has no API key configured` }, 400)
    }
  }

  const invoiceNumber = request.invoice_number ?? 'unknown'

  const result = await runProviderChain({
    chain,
    label: 'extract-invoice',
    logContext: `invoice_number=${invoiceNumber}`,
    build: (entry) => {
      const provider = buildProvider(entry, geminiKey, anthropicKey)
      return provider ? () => provider.extract(request.pdf_base64, EXTRACTION_PROMPT, mimeType) : null
    },
  })

  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error } satisfies ExtractInvoiceResponse, result.status)
  }

  return jsonResponse(
    {
      ok: true,
      data: result.value,
      model: result.entry.model,
      provider: result.entry.provider,
      duration_ms: result.duration_ms,
    } satisfies ExtractInvoiceResponse,
    200,
  )
})
