import type { ExtractionResult } from '../../../../src/lib/extractionSchema.ts'

// Carries the HTTP status so the orchestrator (index.ts) can decide whether to
// back off and retry the same model (429), advance to the next chain entry
// (503 and other 5xx/timeout), or fail the whole request (other 4xx).
export class ProviderError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

// The contract every provider adapter returns — nothing downstream of the
// orchestrator knows or cares which provider produced it.
export interface ExtractionProvider {
  extract(documentBase64: string, prompt: string, mimeType: string): Promise<ExtractionResult>
}

/**
 * A plain text completion, and what it cost to think about.
 *
 * Stage 7 turns a settled verdict into a sentence; it needs no schema, no tool and
 * no document, so it is its own small contract rather than a variant of the
 * extraction one.
 *
 * `thoughtTokens` is the one piece of accounting worth carrying back. Stage 7 asks
 * for a paragraph about a decision that has already been made, and it was still
 * taking twenty seconds after a thinking budget of zero was set on the request.
 * A number the provider reports is the difference between knowing the budget was
 * applied and assuming it: anything above zero here means it was not, whatever the
 * request asked for. Null means the provider did not say.
 */
export interface TextCompletion {
  text: string
  thoughtTokens: number | null
}

export interface TextProvider {
  complete(prompt: string): Promise<TextCompletion>
}
