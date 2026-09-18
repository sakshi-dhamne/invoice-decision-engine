// Stage 7 — turn a settled verdict into one plain-English paragraph.
//
// Deployed by hand through the Supabase dashboard, alongside extract-invoice, and
// reading the same API keys from Deno.env.
//
// This is the only place in the pipeline a model is asked for prose, and it is
// downstream of the decision: the verdict, its reason codes and its evidence are
// already final when they arrive here. The model cannot change any of them, and if
// this call fails the run still completes on the deterministic reason-code summary
// the caller already holds. Never let phrasing block a verdict.
//
// Phrasing a settled decision does not need the larger model, which is why the
// chain starts at a light one (EXPLAIN_MODEL / EXPLAIN_PROVIDER_CHAIN). The retry
// and fallback policy is the shared one from ../_shared/providerChain.ts.

import {
  buildExplainUserMessage,
  type ExplainDecisionRequest,
  type ExplainDecisionResponse,
} from '../../../src/rules/explain.ts'
import {
  CORS_HEADERS,
  jsonResponse,
  parseProviderChain,
  runProviderChain,
  type ChainEntry,
} from '../_shared/providerChain.ts'
import { createAnthropicTextProvider } from '../extract-invoice/providers/anthropic.ts'
import { createGeminiTextProvider } from '../extract-invoice/providers/gemini.ts'
import type { TextProvider } from '../extract-invoice/providers/types.ts'

const DEFAULT_EXPLAIN_MODEL = 'gemini-3.5-flash-lite'

// EXPLAIN_PROVIDER_CHAIN overrides the whole chain; EXPLAIN_MODEL sets just the
// Gemini entry, which is the knob worth having on its own.
function explainChain(): ChainEntry[] {
  const explicit = Deno.env.get('EXPLAIN_PROVIDER_CHAIN')
  if (explicit) return parseProviderChain(explicit)
  const model = Deno.env.get('EXPLAIN_MODEL') || DEFAULT_EXPLAIN_MODEL
  return parseProviderChain(`gemini:${model},anthropic:claude-haiku-4-5-20251001`)
}

function buildTextProvider(
  entry: ChainEntry,
  geminiKey: string | undefined,
  anthropicKey: string | undefined,
): TextProvider | null {
  if (entry.provider === 'gemini') {
    if (!geminiKey) return null
    return createGeminiTextProvider(entry.model, geminiKey)
  }
  if (!anthropicKey) return null
  return createAnthropicTextProvider(entry.model, anthropicKey)
}

function describeRequestError(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return 'request body is not an object'
  const body = request as Record<string, unknown>
  if (typeof body.verdict !== 'string' || body.verdict.length === 0) return 'verdict is required'
  if (!Array.isArray(body.reason_codes) || !body.reason_codes.every((code) => typeof code === 'string')) {
    return 'reason_codes must be an array of strings'
  }
  if (body.evidence !== undefined && (typeof body.evidence !== 'object' || body.evidence === null)) {
    return 'evidence must be an object'
  }
  return null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' } satisfies ExplainDecisionResponse, 405)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Request body was not valid JSON' } satisfies ExplainDecisionResponse, 400)
  }

  const shapeError = describeRequestError(body)
  if (shapeError) {
    return jsonResponse({ ok: false, error: shapeError } satisfies ExplainDecisionResponse, 400)
  }

  const request = body as ExplainDecisionRequest
  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')

  let chain: ChainEntry[]
  try {
    chain = explainChain()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ ok: false, error: `EXPLAIN_PROVIDER_CHAIN is misconfigured: ${message}` }, 500)
  }

  const prompt = buildExplainUserMessage(request)

  const result = await runProviderChain({
    chain,
    label: 'explain-decision',
    logContext: `verdict=${request.verdict} invoice_number=${request.summary?.invoice_number ?? 'unknown'}`,
    build: (entry) => {
      const provider = buildTextProvider(entry, geminiKey, anthropicKey)
      return provider ? () => provider.complete(prompt) : null
    },
  })

  if (!result.ok) {
    // The caller falls back to the deterministic summary. This is a degraded
    // response, not a failed run.
    return jsonResponse({ ok: false, error: result.error } satisfies ExplainDecisionResponse, result.status)
  }

  return jsonResponse(
    {
      ok: true,
      explanation: result.value,
      model: result.entry.model,
      provider: result.entry.provider,
      duration_ms: result.duration_ms,
    } satisfies ExplainDecisionResponse,
    200,
  )
})
