// Provider fallback chain — the retry, backoff and advance policy shared by every
// edge function that calls a model.
//
// Extracted from extract-invoice so explain-decision reuses the same behaviour
// rather than reimplementing it. The policy is unchanged:
//
//   429 (rate limited)         → back off and retry the SAME model; the limit is
//                                 per project, so the next model would not help
//   503 / other 5xx / timeout  → capacity problem; advance to the next entry
//                                 immediately, no backoff
//   4xx other than 429         → a request problem; fail the whole call loudly,
//                                 no retry, no advance
//   chain exhausted            → an error naming every entry tried and its status

import { ProviderError } from '../extract-invoice/providers/types.ts'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const REQUEST_TIMEOUT_MS = 45_000
export const MAX_RATE_LIMIT_RETRIES = 3
export const RATE_LIMIT_BASE_DELAY_MS = 1000

export type ProviderName = 'gemini' | 'anthropic'

export interface ChainEntry {
  provider: ProviderName
  model: string
}

export interface Attempt {
  provider: ProviderName
  model: string
  status: number
  message: string
}

export class TimeoutError extends Error {}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Pure — kept separate from the request loop so the backoff policy is testable
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

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

export type ChainSuccess<T> = { ok: true; value: T; entry: ChainEntry; duration_ms: number }
export type ChainFailure = { ok: false; status: number; error: string; duration_ms: number }
export type ChainResult<T> = ChainSuccess<T> | ChainFailure

export interface RunChainOptions<T> {
  chain: readonly ChainEntry[]
  // Returns null when no API key is configured for that entry's provider, which
  // skips it silently — single-provider operation must be unaffected by an unset
  // key for the other.
  build: (entry: ChainEntry) => ((signalLabel: string) => Promise<T>) | null
  label: string
  logContext?: string
}

export async function runProviderChain<T>(options: RunChainOptions<T>): Promise<ChainResult<T>> {
  const startedAt = performance.now()
  const attempts: Attempt[] = []

  for (const entry of options.chain) {
    const call = options.build(entry)
    if (!call) {
      console.log(`${options.label} skip provider=${entry.provider} model=${entry.model} reason=no_api_key`)
      continue
    }

    let rateLimitAttempt = 0
    for (;;) {
      try {
        const value = await withTimeout(
          call(`${entry.provider}:${entry.model}`),
          REQUEST_TIMEOUT_MS,
          `${entry.provider}:${entry.model}`,
        )
        const duration_ms = Math.round(performance.now() - startedAt)
        console.log(
          `${options.label} ok provider=${entry.provider} model=${entry.model} ${options.logContext ?? ''} duration_ms=${duration_ms}`,
        )
        return { ok: true, value, entry, duration_ms }
      } catch (err) {
        const isTimeout = err instanceof TimeoutError
        const status = err instanceof ProviderError ? err.status : isTimeout ? 504 : 500
        const message = err instanceof Error ? err.message : String(err)

        console.log(
          `${options.label} attempt-failed provider=${entry.provider} model=${entry.model} status=${status} message=${message}`,
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
          // A request problem (bad input, bad key) — fail loudly, no retry, no
          // advance.
          const duration_ms = Math.round(performance.now() - startedAt)
          console.log(
            `${options.label} failed-fast provider=${entry.provider} model=${entry.model} status=${status} duration_ms=${duration_ms}`,
          )
          return {
            ok: false,
            status: 502,
            error: `${entry.provider}:${entry.model} request failed (${status}): ${message}`,
            duration_ms,
          }
        }

        // 503 / other 5xx / timeout — capacity problem, advance immediately.
        attempts.push({ provider: entry.provider, model: entry.model, status, message })
        break
      }
    }
  }

  const duration_ms = Math.round(performance.now() - startedAt)
  const attemptsSummary =
    attempts.length > 0
      ? attempts.map((attempt) => `${attempt.provider}:${attempt.model} → ${attempt.status}`).join(', ')
      : 'none — chain empty or every entry skipped for a missing API key'

  console.log(
    `${options.label} exhausted ${options.logContext ?? ''} duration_ms=${duration_ms} attempts=[${attemptsSummary}]`,
  )

  return {
    ok: false,
    status: 502,
    error: `All providers in the chain failed. Attempts: ${attemptsSummary}`,
    duration_ms,
  }
}
