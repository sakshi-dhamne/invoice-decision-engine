import {
  GEMINI_RESPONSE_SCHEMA,
  parseExtractionResponseText,
} from '../../../../src/lib/extractionSchema.ts'
import { ProviderError, type ExtractionProvider } from './types.ts'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// Retry/backoff/timeout policy lives in the orchestrator (index.ts), not here —
// this adapter makes exactly one attempt per call.
export function createGeminiProvider(model: string, apiKey: string): ExtractionProvider {
  return {
    async extract(pdfBase64, prompt) {
      const url = `${GEMINI_API_BASE}/${model}:generateContent`
      const requestBody = {
        contents: [
          {
            parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }, { text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ProviderError(`Gemini request failed (${response.status}): ${errorText}`, response.status)
      }

      const payload = await response.json()
      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
      if (typeof text !== 'string') {
        throw new ProviderError(`Gemini response had no text part: ${JSON.stringify(payload)}`, 502)
      }

      try {
        return parseExtractionResponseText(text)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ProviderError(message, 502)
      }
    },
  }
}
