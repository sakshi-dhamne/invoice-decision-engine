// What a person is told when an edge function refuses a request.
//
// `supabase.functions.invoke` throws a FunctionsHttpError on any non-2xx and catches
// it into `{ data: null, error }`, leaving the response body unread on
// `error.context` and `error.message` reading "Edge Function returned a non-2xx
// status code". Both call sites did `if (error) throw error` before looking at
// `data`, and since `data` is null on a non-2xx the `data.error` branch underneath
// could never run. Every failure reached a person as the same generic HTTP
// complaint, including the ones the functions had written a real sentence for.
//
// The assertion these exist for: a non-2xx carrying a JSON body with an `error`
// field surfaces that field's text, not the transport error.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { edgeFunctionMessage, invokeEdgeFunction } from '../src/lib/edgeFunction.ts'
import { runFailureSentence, SERVICE_GAVE_NO_ANSWER, SERVICE_UNREACHABLE, stageFailedSentence } from '../src/lib/reasonCopy.ts'

// The message the transport supplies, which is the one that was reaching people.
const TRANSPORT_MESSAGE = 'Edge Function returned a non-2xx status code'

// What the provider chain actually says when every entry has been tried.
const CHAIN_EXHAUSTED =
  'All providers in the chain failed. Attempts: gemini-3.6-flash returned 503, gemini-3.5-flash returned 503, gemini-3.7-flash returned 503'

const NOT_A_DOCUMENT = 'This file is not a PDF or an image we can read'

/** A FunctionsHttpError as the client builds one: the name, and the raw Response. */
function httpError(body: string, status = 502, contentType = 'application/json'): Error {
  const error = new Error(TRANSPORT_MESSAGE)
  error.name = 'FunctionsHttpError'
  Object.assign(error, { context: new Response(body, { status, headers: { 'Content-Type': contentType } }) })
  return error
}

/**
 * A network failure as the client builds one.
 *
 * Its `context` is the underlying fetch error, not a response. Reading that as
 * though it were a body yields the raw "fetch failed", which is the transport
 * complaint this whole change exists to stop showing people.
 */
function transportError(name: 'FunctionsFetchError' | 'FunctionsRelayError'): Error {
  const error = new Error('Failed to send a request to the Edge Function')
  error.name = name
  Object.assign(error, { context: new TypeError('fetch failed') })
  return error
}

// ---------------------------------------------------------------------------
// Reading the body off the error
// ---------------------------------------------------------------------------

describe('the message an edge function sent', () => {
  it('is read from a non-2xx JSON body rather than lost to the transport error', async () => {
    const error = httpError(JSON.stringify({ ok: false, error: CHAIN_EXHAUSTED }))
    const message = await edgeFunctionMessage(error)
    expect(message).toBe(CHAIN_EXHAUSTED)
    expect(message).not.toBe(TRANSPORT_MESSAGE)
    expect(message).not.toContain('non-2xx')
  })

  it('names every provider that was tried and what each returned', async () => {
    const message = await edgeFunctionMessage(httpError(JSON.stringify({ ok: false, error: CHAIN_EXHAUSTED })))
    for (const attempt of ['gemini-3.6-flash returned 503', 'gemini-3.5-flash returned 503', 'gemini-3.7-flash returned 503']) {
      expect(message, attempt).toContain(attempt)
    }
  })

  it('reads a 400 about the document, which is a different status and the same problem', async () => {
    const error = httpError(JSON.stringify({ ok: false, error: NOT_A_DOCUMENT }), 400)
    expect(await edgeFunctionMessage(error)).toBe(NOT_A_DOCUMENT)
  })

  it('leaves the original error readable, so the body is not consumed out from under it', async () => {
    const error = httpError(JSON.stringify({ ok: false, error: NOT_A_DOCUMENT }))
    expect(await edgeFunctionMessage(error)).toBe(NOT_A_DOCUMENT)
    // A body can be read once. Cloning is what makes a second read possible, and a
    // caller inspecting the response afterwards is entitled to one.
    const context = (error as unknown as { context: Response }).context
    expect(context.bodyUsed).toBe(false)
    await expect(context.json()).resolves.toMatchObject({ error: NOT_A_DOCUMENT })
  })

  it('falls back to a message key, which is what the runtime sends', async () => {
    expect(await edgeFunctionMessage(httpError(JSON.stringify({ message: 'Function boot error' })))).toBe(
      'Function boot error',
    )
  })

  it('takes a plain-text body as the message', async () => {
    expect(await edgeFunctionMessage(httpError('Gateway timed out', 504, 'text/plain'))).toBe('Gateway timed out')
  })

  it('says nothing rather than something wrong when the body holds no sentence', async () => {
    expect(await edgeFunctionMessage(httpError(JSON.stringify({ ok: false }), 500))).toBeNull()
    expect(await edgeFunctionMessage(httpError('   ', 500, 'text/plain'))).toBeNull()
    expect(await edgeFunctionMessage(httpError('not json at all{', 500))).toBe('not json at all{')
  })

  it('never throws on an error it cannot make sense of', async () => {
    for (const value of [null, undefined, 'a string', 42, new Error('plain')]) {
      await expect(edgeFunctionMessage(value)).resolves.toBeNull()
    }
  })

  it('reads nothing out of a network error, whose context is not a body', async () => {
    // It would otherwise find the underlying error's own `message` and report
    // "fetch failed" as though the function had said it.
    for (const name of ['FunctionsFetchError', 'FunctionsRelayError'] as const) {
      await expect(edgeFunctionMessage(transportError(name))).resolves.toBeNull()
    }
  })

  it('survives a response whose body cannot be read', async () => {
    const error = new Error(TRANSPORT_MESSAGE)
    error.name = 'FunctionsHttpError'
    Object.assign(error, {
      context: {
        clone: () => ({ text: () => Promise.reject(new Error('stream already read')) }),
        text: () => Promise.reject(new Error('stream already read')),
      },
    })
    await expect(edgeFunctionMessage(error)).resolves.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// What the caller ends up throwing
// ---------------------------------------------------------------------------

describe('invoking an edge function', () => {
  // Stubbed at the fetch layer rather than on `supabase.functions`, because
  // `get functions()` hands back a new FunctionsClient on every access, so a spy on
  // one instance never sees the call the helper makes. Stubbing fetch also runs the
  // real client path: it is supabase-js that builds the FunctionsHttpError from this
  // response, which is the behaviour these assertions are about.
  const replyWith = (body: string, status: number, contentType = 'application/json') => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(body, { status, headers: { 'Content-Type': contentType } })),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("throws the function's sentence, not the transport error", async () => {
    replyWith(JSON.stringify({ ok: false, error: CHAIN_EXHAUSTED }), 502)

    // The assertion this whole file exists for.
    await expect(invokeEdgeFunction('extract-invoice', {})).rejects.toThrow(CHAIN_EXHAUSTED)
    await expect(invokeEdgeFunction('extract-invoice', {})).rejects.not.toThrow(TRANSPORT_MESSAGE)
  })

  it('throws what a 400 about the document said', async () => {
    replyWith(JSON.stringify({ ok: false, error: NOT_A_DOCUMENT }), 400)
    await expect(invokeEdgeFunction('extract-invoice', {})).rejects.toThrow(NOT_A_DOCUMENT)
  })

  it('says the service was not reached when the request never got there', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(invokeEdgeFunction('extract-invoice', {})).rejects.toThrow(SERVICE_UNREACHABLE)
  })

  it('says the service gave no answer when a non-2xx carries nothing readable', async () => {
    replyWith(JSON.stringify({ ok: false }), 500)
    await expect(invokeEdgeFunction('extract-invoice', {})).rejects.toThrow(SERVICE_GAVE_NO_ANSWER)
  })

  it('returns the body on success', async () => {
    replyWith(JSON.stringify({ ok: true, model: 'gemini:gemini-3.5-flash' }), 200)
    await expect(invokeEdgeFunction('extract-invoice', {})).resolves.toMatchObject({ ok: true })
  })

  it('surfaces the explain-decision failure the same way', async () => {
    // The second call site, which had the identical bug.
    replyWith(JSON.stringify({ ok: false, error: 'EXPLAIN_PROVIDER_CHAIN is misconfigured: empty' }), 500)
    await expect(invokeEdgeFunction('explain-decision', {})).rejects.toThrow(
      'EXPLAIN_PROVIDER_CHAIN is misconfigured: empty',
    )
  })

  it('names no function and no status code in either fallback', () => {
    // What this software calls a service is not a fact about the invoice, and a
    // status code is not something a finance manager can act on.
    for (const sentence of [SERVICE_UNREACHABLE, SERVICE_GAVE_NO_ANSWER]) {
      expect(sentence, sentence).not.toContain('extract-invoice')
      expect(sentence, sentence).not.toContain('explain-decision')
      expect(sentence, sentence).not.toMatch(/\bnon-2xx\b|\b[45]\d\d\b/)
    }
  })
})

// ---------------------------------------------------------------------------
// What a failed run then shows
// ---------------------------------------------------------------------------

describe('the sentence a failed run shows', () => {
  it('says where it stopped and then what went wrong', () => {
    const sentence = stageFailedSentence('extract', CHAIN_EXHAUSTED)
    expect(sentence).toBe(`This stopped while reading the document. ${CHAIN_EXHAUSTED}.`)
    expect(sentence).toContain('gemini-3.6-flash returned 503')
  })

  it('does not double up a full stop', () => {
    expect(stageFailedSentence('extract', 'It broke.')).toBe('This stopped while reading the document. It broke.')
  })

  it('reads the recorded sentence straight back', () => {
    const recorded = stageFailedSentence('extract', CHAIN_EXHAUSTED)
    expect(runFailureSentence(recorded)).toBe(recorded)
  })

  it('translates the legacy record rather than leaking a stage name at a reader', () => {
    // Runs that failed before this was recorded as English carry this shape, and
    // deployed data outlives the format that wrote it.
    const legacy = `Stage "extract" threw: ${CHAIN_EXHAUSTED}`
    const sentence = runFailureSentence(legacy)
    expect(sentence).toBe(`This stopped while reading the document. ${CHAIN_EXHAUSTED}.`)
    expect(sentence).not.toContain('threw')
    expect(sentence).not.toContain('Stage "')
  })

  it('translates the legacy record for every stage the pipeline has', () => {
    for (const [stage, clause] of [
      ['ingest', 'receiving the document'],
      ['extract', 'reading the document'],
      ['resolve_vendor', 'identifying the vendor'],
      ['match_po', 'finding the order'],
      ['validate', 'running the checks'],
      ['decide', 'deciding'],
      ['explain', 'writing the explanation'],
    ] as const) {
      expect(runFailureSentence(`Stage "${stage}" threw: boom`), stage).toBe(`This stopped while ${clause}. boom.`)
    }
  })

  it('has nothing to say about a run that recorded nothing', () => {
    expect(runFailureSentence(null)).toBeNull()
    expect(runFailureSentence('')).toBeNull()
    expect(runFailureSentence('   ')).toBeNull()
  })
})
