// Calling an edge function and getting its own words back when it fails.
//
// `supabase.functions.invoke` throws a FunctionsHttpError on any non-2xx and
// catches it into `{ data: null, error }`. The response body is never read, so it
// sits unconsumed on `error.context` while `error.message` says only "Edge Function
// returned a non-2xx status code". Every call site here did `if (error) throw error`
// before looking at `data`, and because `data` is null on a non-2xx, the `data.error`
// branch underneath was unreachable. The result was that both edge functions wrote
// careful failure messages that nothing ever showed: a chain that exhausted every
// provider, a file that was not a document we can read, a misconfigured chain, all
// of them reached a person as the same generic HTTP complaint.
//
// So the body is read off the error before anything is thrown, and what the function
// said becomes the message. Both functions answer a failure with
// `{ ok: false, error: "<sentence>" }`, and that sentence is written for a person.
//
// Every invoke in the app goes through here, so a new call site cannot reintroduce
// the swallowing by forgetting to unwrap.

import { supabase } from './supabase.ts'
import { SERVICE_GAVE_NO_ANSWER, SERVICE_UNREACHABLE } from './reasonCopy.ts'

/**
 * Whatever a body turns out to hold: parsed JSON, or the raw text.
 *
 * A function that fails inside the Supabase runtime rather than inside our own
 * handler answers with text, not with our JSON shape, so this cannot assume one.
 */
function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * The body carried by a failed invoke, read without consuming the original.
 *
 * Cloned where cloning is available, because the caller may still want to inspect
 * the response and a body can only be read once. Returns undefined when there is
 * nothing here that looks like a response at all.
 */
async function bodyOf(context: unknown): Promise<unknown> {
  if (context === null || context === undefined) return undefined
  if (typeof context === 'string') return parseMaybeJson(context)

  // Only something that can hand over a body. `context` is a Response on a
  // FunctionsHttpError and the underlying network error on a FunctionsFetchError,
  // and reading the second one as though it were a body is how "fetch failed"
  // reached a person as though the function had said it.
  const response = context as { text?: unknown; clone?: unknown }
  if (typeof response.text !== 'function') return undefined

  const source = typeof response.clone === 'function' ? (response.clone as () => unknown)() : context
  const text = await (source as { text: () => Promise<string> }).text()
  return parseMaybeJson(text)
}

/** The sentence inside a body, if it holds one. */
function sentenceIn(body: unknown): string | null {
  if (typeof body === 'string') {
    const trimmed = body.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (body === null || typeof body !== 'object') return null

  // `error` is what both of our functions send. `message` is what the runtime
  // sends when it fails before reaching our handler.
  const record = body as Record<string, unknown>
  for (const key of ['error', 'message'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * What the function actually said, or null if it said nothing we can read.
 *
 * Never throws. A body that cannot be read is a reason to fall back to a sentence
 * of our own, not a reason to replace the failure with a different failure.
 */
export async function edgeFunctionMessage(error: unknown): Promise<string | null> {
  if (error === null || typeof error !== 'object') return null
  try {
    return sentenceIn(await bodyOf((error as { context?: unknown }).context))
  } catch {
    return null
  }
}

/**
 * Whether the function was reached at all.
 *
 * A network failure never got there, so there is no body and no message from it;
 * that is a different thing to tell somebody than a function that answered with a
 * complaint. Matched on the name rather than with `instanceof`, so this holds across
 * whichever copy of the client library is loaded.
 */
function neverReached(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'FunctionsFetchError' || name === 'FunctionsRelayError'
}

/**
 * Calls an edge function and returns its body, or throws what it said.
 *
 * The thrown message is the function's own sentence wherever there is one, because
 * that sentence names the actual problem: which providers were tried and what each
 * returned, or what was wrong with the document. Only when the body holds nothing
 * readable does this supply a sentence of its own.
 */
export async function invokeEdgeFunction<T>(name: string, body: unknown): Promise<T> {
  // The client's body type is a union of the things it knows how to serialise. Both
  // call sites pass a plain object, which is the first member of it.
  const { data, error } = await supabase.functions.invoke<T>(name, { body: body as Record<string, unknown> })

  if (error) {
    // Asked first, because a request that never arrived has no function message to
    // prefer over this and carries a raw network error where a body would be.
    if (neverReached(error)) throw new Error(SERVICE_UNREACHABLE)

    const said = await edgeFunctionMessage(error)
    if (said) throw new Error(said)

    // A non-2xx whose body held nothing readable. The function name is how this
    // software addresses the service and is not a fact about the document, so it
    // stays out of the message.
    throw new Error(SERVICE_GAVE_NO_ANSWER)
  }

  if (data === null || data === undefined) throw new Error(SERVICE_GAVE_NO_ANSWER)
  return data
}
