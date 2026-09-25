import {
  GEMINI_RESPONSE_SCHEMA,
  parseExtractionResponseText,
} from '../../../../src/lib/extractionSchema.ts'
import { ProviderError, type ExtractionProvider, type TextCompletion, type TextProvider } from './types.ts'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// Only the parts of a response this adapter reads. Typed so the two readers below
// are checked rather than reaching into an untyped blob.
interface GeminiPayload {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
  usageMetadata?: { thoughtsTokenCount?: number }
}

/**
 * How much the model may think before it answers.
 *
 * Gemini 3 models reason before responding by default, and the budget is
 * unbounded unless something sets one. Transcription does not need it: every
 * field is a value printed on the page, the schema says what shape each one
 * takes, and the prompt's hard rule is to copy rather than work anything out.
 * The thinking was time spent deliberating over a task whose answer is in front
 * of it, and it was most of the wall clock on an upload.
 *
 * Zero is a floor, not a request: a model that ignores the field behaves exactly
 * as it did before, so this can only make a call faster or leave it unchanged.
 */
const NO_THINKING = { thinkingBudget: 0 }

// A page of invoice JSON is a few hundred tokens. The ceiling is here so a model
// that starts repeating itself fails fast rather than running to a timeout.
const EXTRACTION_OUTPUT_CAP = 4096

// Two or three sentences, and the prompt already says under 60 words.
const EXPLANATION_OUTPUT_CAP = 512

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
          maxOutputTokens: EXTRACTION_OUTPUT_CAP,
          thinkingConfig: NO_THINKING,
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

      const payload = (await response.json()) as GeminiPayload
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
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: EXPLANATION_OUTPUT_CAP,
            thinkingConfig: NO_THINKING,
          },
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ProviderError(`Gemini request failed (${response.status}): ${errorText}`, response.status)
      }

      const payload = (await response.json()) as GeminiPayload

      /**
       * The answer, and not the thinking.
       *
       * A model that reasons before answering can return the reasoning as parts of
       * its own, marked `thought: true`, ahead of the answer. Reading `parts[0]`
       * then returns a thought summary rather than the explanation, or nothing at
       * all. Joining the parts that are not thoughts is correct whether or not any
       * thinking happened.
       */
      const parts = payload?.candidates?.[0]?.content?.parts ?? []
      const text = parts
        .filter((part) => part?.thought !== true && typeof part?.text === 'string')
        .map((part) => part.text ?? '')
        .join('')
        .trim()

      if (text.length === 0) {
        throw new ProviderError(`Gemini response had no text part: ${JSON.stringify(payload)}`, 502)
      }

      // What the model actually spent thinking, as it reports it. Zero means the
      // budget on the request was honoured; anything else means it was not.
      const thoughtTokens = payload?.usageMetadata?.thoughtsTokenCount
      return {
        text,
        thoughtTokens: typeof thoughtTokens === 'number' ? thoughtTokens : null,
      } satisfies TextCompletion
    },
  }
}
