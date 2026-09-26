// Diagnostics that stay off in normal operation.
//
// A provider that rejects a request answers with a status and a sentence about
// the request, never about the document inside it, so when every PDF is refused
// and every image is accepted there is nothing in the logs that distinguishes a
// bad request from bad bytes. These lines close that gap: they say what was about
// to be sent, immediately before it was sent.
//
// Behind a flag because the payload prefix is document content, however little of
// it, and because a line per call is noise once the question is answered. Set
// EXTRACTION_DEBUG to 1 in the function's environment to turn it on, and remove
// the variable to turn it off again. Nothing about extraction changes either way.

export const DEBUG_ENV_VAR = 'EXTRACTION_DEBUG'

/**
 * How much of the payload a diagnostic line quotes.
 *
 * Enough to recognise the format and no more. Base64 encodes three bytes per four
 * characters from the start, so a document's signature is in the first handful:
 * a PDF begins JVBERi0 ("%PDF-"), a PNG iVBORw0KGgo, a JPEG /9j/. A prefix that
 * reads PCFET0NUWVBF or PGh0bWw is "<!DOCTYPE" or "<html" and the bytes are a web
 * page, whatever the type beside them claims.
 */
export const PAYLOAD_PREFIX_CHARS = 20

/**
 * An environment variable, wherever this module is running.
 *
 * Deno in the deployed function. The test runner loads these same files directly,
 * where there is no Deno at all, and a deployment could withhold environment
 * access; neither is a reason for a diagnostic to throw.
 */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno?.env
  if (!env) return undefined
  try {
    return env.get(name)
  } catch {
    return undefined
  }
}

// Off unless something says otherwise, and the ways of saying no all mean no.
export function debugEnabled(): boolean {
  const value = readEnv(DEBUG_ENV_VAR)?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

export function payloadPrefix(base64: string): string {
  return base64.slice(0, PAYLOAD_PREFIX_CHARS)
}

/** Writes the line only when the flag is set, so callers need no condition of their own. */
export function logDebug(line: string): void {
  if (debugEnabled()) console.log(line)
}
