import {
  GEMINI_RESPONSE_SCHEMA,
  parseExtractionResponseText,
} from '../../../../src/lib/extractionSchema.ts'
import { ProviderError, type ExtractionProvider, type TextProvider } from './types.ts'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// Retry/backoff/timeout policy lives in the orchestrator (index.ts), not here —
// this adapter makes exactly one attempt per call.
export function createGeminiProvider(model: string, apiKey: string): ExtractionProvider {
  return {
    async extract(documentBase64, prompt, mimeType) {
      const url = `${GEMINI_API_BASE}/${model}:generateContent`
      const requestBody = {
        contents: [
          {
            parts: [{ inline_data: { mime_type: mimeType, data: documentBase64 } }, { text: prompt }],
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

// Same endpoint, same key, same error mapping as the extraction adapter — only the
// generation config differs, because stage 7 wants prose rather than JSON.
export function createGeminiTextProvider(model: string, apiKey: string): TextProvider {
  return {
    async complete(prompt) {
      const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ProviderError(`Gemini request failed (${response.status}): ${errorText}`, response.status)
      }

      const payload = await response.json()
      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new ProviderError(`Gemini response had no text part: ${JSON.stringify(payload)}`, 502)
      }
      return text.trim()
    },
  }
}
