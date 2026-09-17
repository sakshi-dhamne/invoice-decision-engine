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
  extract(pdfBase64: string, prompt: string): Promise<ExtractionResult>
}
