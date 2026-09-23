import {
  EXTRACTION_FIELDS,
  describeExtractionResultShapeError,
  type ExtractionResult,
} from '../../../../src/lib/extractionSchema.ts'
import { ProviderError, type ExtractionProvider, type TextProvider } from './types.ts'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 4096
// Stage 7 wants two or three sentences, and the prompt already says under 60
// words. Anthropic does no extended thinking unless a request asks for one, so
// there is no reasoning budget to cap here — only the answer itself.
const EXPLANATION_MAX_TOKENS = 512
const TOOL_NAME = 'record_invoice'

// Anthropic tool use takes JSON Schema, not Gemini's OpenAPI-subset `Schema`
// object — a separate schema definition, describing the identical
// ExtractionResult contract from extractionSchema.ts.
const RECORD_INVOICE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD' },
    vendor_name: { type: ['string', 'null'] },
    po_reference: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] },
          unit_price: { type: ['number', 'null'] },
          amount: { type: ['number', 'null'] },
        },
      },
    },
    subtotal: { type: ['number', 'null'] },
    tax: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    bank_account: { type: ['string', 'null'] },
    bank_ifsc: { type: ['string', 'null'] },
    remit_to_name: { type: ['string', 'null'] },
    document_type: { type: 'string', enum: ['invoice', 'credit_note'] },
    notes: { type: ['string', 'null'] },
    confidence: {
      type: 'object',
      properties: Object.fromEntries(EXTRACTION_FIELDS.map((field) => [field, { type: ['number', 'null'] }])),
    },
    unreadable_fields: { type: 'array', items: { type: 'string' } },
    extraction_notes: { type: ['string', 'null'] },
  },
  required: ['document_type', 'confidence', 'unreadable_fields'],
}

interface AnthropicContentBlock {
  type?: string
  input?: unknown
}

// Same prompt text as Gemini — if the wording diverges, the two paths extract
// differently and the fallback stops being a fallback.
export function createAnthropicProvider(model: string, apiKey: string): ExtractionProvider {
  return {
    async extract(documentBase64, prompt, mimeType) {
      // A PDF goes in as a document block. An image goes in as an image block.
      // Anthropic has no HEIC support, so one arriving here fails this provider
      // and the chain moves on to a model that can read it.
      const source = { type: 'base64', media_type: mimeType, data: documentBase64 }
      const documentPart =
        mimeType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }

      const requestBody = {
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        tools: [
          {
            name: TOOL_NAME,
            description: 'Record the structured invoice extraction result.',
            input_schema: RECORD_INVOICE_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: [
              documentPart,
              { type: 'text', text: prompt },
            ],
          },
        ],
      }

      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ProviderError(`Anthropic request failed (${response.status}): ${errorText}`, response.status)
      }

      const payload = await response.json()
      const blocks: AnthropicContentBlock[] = Array.isArray(payload?.content) ? payload.content : []
      const toolUse = blocks.find((block) => block.type === 'tool_use')

      if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
        throw new ProviderError(`Anthropic response had no tool_use block: ${JSON.stringify(payload)}`, 502)
      }

      const shapeError = describeExtractionResultShapeError(toolUse.input)
      if (shapeError) {
        throw new ProviderError(
          `Anthropic tool_use.input did not match the expected shape (${shapeError}): ${JSON.stringify(toolUse.input)}`,
          502,
        )
      }

      return toolUse.input as ExtractionResult
    },
  }
}

interface AnthropicTextBlock {
  type?: string
  text?: string
}

// Same endpoint, version header and error mapping as the extraction adapter; no
// tool, because stage 7 wants a sentence rather than a record.
export function createAnthropicTextProvider(model: string, apiKey: string): TextProvider {
  return {
    async complete(prompt) {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: EXPLANATION_MAX_TOKENS,
          temperature: 0.2,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ProviderError(`Anthropic request failed (${response.status}): ${errorText}`, response.status)
      }

      const payload = await response.json()
      const blocks: AnthropicTextBlock[] = Array.isArray(payload?.content) ? payload.content : []
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim()

      if (text.length === 0) {
        throw new ProviderError(`Anthropic response had no text block: ${JSON.stringify(payload)}`, 502)
      }
      return text
    },
  }
}
