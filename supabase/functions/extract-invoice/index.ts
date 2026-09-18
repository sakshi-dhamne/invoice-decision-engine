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
// Per-entry behaviour:
//   429 (rate limited)         → back off and retry the SAME model; the limit is
//                                 per project, so the next model wouldn't help
//   503 / other 5xx / timeout  → capacity problem; advance to the next entry
//                                 immediately, no backoff
//   4xx other than 429         → a request problem; fail the whole call loudly,
//                                 no retry, no advance
//   chain exhausted            → return an error naming every entry tried and its
//                                 status

import { EXTRACTION_PROMPT, type ExtractInvoiceRequest, type ExtractInvoiceResponse } from '../../../src/lib/extractionSchema.ts'
import { createAnthropicProvider } from './providers/anthropic.ts'
import { createGeminiProvider } from './providers/gemini.ts'
import { ProviderError, type ExtractionProvider } from './providers/types.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const DEFAULT_PROVIDER_CHAIN = 'gemini:gemini-3.6-flash,gemini:gemini-3.5-flash,gemini:gemini-3.5-flash-lite,anthropic:claude-sonnet-5'

const REQUEST_TIMEOUT_MS = 45_000
const MAX_RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BASE_DELAY_MS = 1000

type ProviderName = 'gemini' | 'anthropic'

interface ChainEntry {
  provider: ProviderName
  model: string
}

interface Attempt {
  provider: ProviderName
  model: string
  status: number
  message: string
}

function jsonResponse(body: ExtractInvoiceResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Pure — kept separate from the request loop so the backoff policy is unit-testable
// without mocking fetch.
export function backoffDelayMs(attempt: number, jitter = Math.random() * 250): number {
  return RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt + jitter
}

export function parseProviderChain(raw: string): ChainEntry[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':')
      if (separatorIndex === -1) {
        throw new Error(`Chain entry "${entry}" is not in "provider:model" form`)
      }
      const provider = entry.slice(0, separatorIndex).trim()
      const model = entry.slice(separatorIndex + 1).trim()
      if (provider !== 'gemini' && provider !== 'anthropic') {
        throw new Error(`Unknown provider "${provider}" in chain entry "${entry}"`)
      }
      if (!model) {
        throw new Error(`Chain entry "${entry}" is missing a model`)
      }
      return { provider, model }
    })
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function buildProvider(entry: ChainEntry, geminiKey: string | undefined, anthropicKey: string | undefined): ExtractionProvider | null {
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
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')

  let request: ExtractInvoiceRequest
  try {
    request = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Request body was not valid JSON' }, 400)
  }

  if (typeof request.pdf_base64 !== 'string' || request.pdf_base64.length === 0) {
    return jsonResponse({ ok: false, error: 'pdf_base64 is required' }, 400)
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
      return jsonResponse({ ok: false, error: `PROVIDER_CHAIN has no entries for forced provider "${request.provider}"` }, 400)
    }
    const hasKey = request.provider === 'gemini' ? !!geminiKey : !!anthropicKey
    if (!hasKey) {
      return jsonResponse(
        { ok: false, error: `Forced provider "${request.provider}" has no API key configured` },
        400,
      )
    }
  }

  const startedAt = performance.now()
  const invoiceNumber = request.invoice_number ?? 'unknown'
  const attempts: Attempt[] = []

  for (const entry of chain) {
    const providerImpl = buildProvider(entry, geminiKey, anthropicKey)
    if (!providerImpl) {
      // No API key configured for this entry's provider — skip it silently.
      // Gemini-only operation must be unaffected when ANTHROPIC_API_KEY is unset.
      console.log(`extract-invoice skip provider=${entry.provider} model=${entry.model} reason=no_api_key`)
      continue
    }

    let rateLimitAttempt = 0
    // deno-lint-ignore no-constant-condition
    while (true) {
      try {
        const data = await withTimeout(
          providerImpl.extract(request.pdf_base64, EXTRACTION_PROMPT),
          REQUEST_TIMEOUT_MS,
          `${entry.provider}:${entry.model}`,
        )
        const duration_ms = Math.round(performance.now() - startedAt)
        console.log(
          `extract-invoice ok provider=${entry.provider} model=${entry.model} invoice_number=${invoiceNumber} duration_ms=${duration_ms}`,
        )
        return jsonResponse({ ok: true, data, model: entry.model, provider: entry.provider, duration_ms }, 200)
      } catch (err) {
        const isTimeout = err instanceof TimeoutError
        const status = err instanceof ProviderError ? err.status : isTimeout ? 504 : 500
        const message = err instanceof Error ? err.message : String(err)

        console.log(
          `extract-invoice attempt-failed provider=${entry.provider} model=${entry.model} status=${status} message=${message}`,
        )

        if (status === 429) {
          if (rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
            await sleep(backoffDelayMs(rateLimitAttempt))
            rateLimitAttempt++
            continue
          }
          attempts.push({
            provider: entry.provider,
            model: entry.model,
            status,
            message: `${message} (still rate limited after ${MAX_RATE_LIMIT_RETRIES} retries)`,
          })
          break
        }

        if (status >= 400 && status < 500) {
          // A request problem (bad PDF, bad key, etc.) — fail loudly, don't
          // retry, don't advance to the next model.
          const duration_ms = Math.round(performance.now() - startedAt)
          console.log(
            `extract-invoice failed-fast provider=${entry.provider} model=${entry.model} status=${status} duration_ms=${duration_ms}`,
          )
          return jsonResponse(
            { ok: false, error: `${entry.provider}:${entry.model} request failed (${status}): ${message}` },
            502,
          )
        }

        // 503 / other 5xx / timeout — capacity problem, advance immediately.
        attempts.push({ provider: entry.provider, model: entry.model, status, message })
        break
      }
    }
  }

  const duration_ms = Math.round(performance.now() - startedAt)
  const attemptsSummary = attempts.length > 0 ? attempts.map((a) => `${a.provider}:${a.model} → ${a.status}`).join(', ') : 'none — chain empty or every entry skipped for a missing API key'

  console.log(`extract-invoice exhausted invoice_number=${invoiceNumber} duration_ms=${duration_ms} attempts=[${attemptsSummary}]`)

  return jsonResponse(
    { ok: false, error: `All providers in the chain failed. Attempts: ${attemptsSummary}` },
    502,
  )
})
