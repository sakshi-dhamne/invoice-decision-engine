// Shared between the browser client (extraction.ts, ExtractionHarness.tsx) and the
// Deno edge function (supabase/functions/extract-invoice/index.ts) — single source of
// truth for the extraction contract with Gemini, so the two sides can't drift apart.

export type DocumentType = 'invoice' | 'credit_note'

export interface LineItemExtract {
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
}

export const EXTRACTION_FIELDS = [
  'invoice_number',
  'invoice_date',
  'vendor_name',
  'po_reference',
  'currency',
  'line_items',
  'subtotal',
  'tax',
  'total',
  'bank_account',
  'bank_ifsc',
  'remit_to_name',
  'document_type',
  'notes',
] as const

export type ExtractionField = (typeof EXTRACTION_FIELDS)[number]

export type ExtractionConfidence = Partial<Record<ExtractionField, number>>

export interface ExtractionResult {
  invoice_number: string | null
  invoice_date: string | null
  vendor_name: string | null
  po_reference: string | null
  currency: string | null
  line_items: LineItemExtract[]
  subtotal: number | null
  tax: number | null
  total: number | null
  bank_account: string | null
  bank_ifsc: string | null
  remit_to_name: string | null
  document_type: DocumentType
  notes: string | null
  confidence: ExtractionConfidence
  unreadable_fields: string[]
  extraction_notes: string | null
}

export type ExtractionProviderName = 'gemini' | 'anthropic'

// What a document may arrive as. Scanned invoices turn up as phone photos far more
// often than as PDFs, and both models read an image natively, so the only thing
// that has to change between the two is the media type declared alongside the
// bytes.
export const ACCEPTED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
] as const

export type AcceptedDocumentType = (typeof ACCEPTED_DOCUMENT_TYPES)[number]

export function isAcceptedDocumentType(value: unknown): value is AcceptedDocumentType {
  return typeof value === 'string' && (ACCEPTED_DOCUMENT_TYPES as readonly string[]).includes(value)
}

export interface ExtractInvoiceRequest {
  // Named for the case it started with. It carries whichever of the accepted types
  // `mime_type` declares, and defaults to a PDF when nothing says otherwise.
  pdf_base64: string
  mime_type?: AcceptedDocumentType
  invoice_number?: string
  // Forces the chain down to entries for this provider only, bypassing fallback
  // to the others — used by the harness's `?provider=` testing mode.
  provider?: ExtractionProviderName
}

export interface ExtractInvoiceSuccess {
  ok: true
  data: ExtractionResult
  model: string
  provider: ExtractionProviderName
  duration_ms: number
}

export interface ExtractInvoiceFailure {
  ok: false
  error: string
}

export type ExtractInvoiceResponse = ExtractInvoiceSuccess | ExtractInvoiceFailure

// Gemini's `responseSchema` follows a subset of OpenAPI 3.0 (the `Schema` object from
// https://ai.google.dev/api/rest/v1beta/Schema) — uppercase `type` strings, not JSON Schema.
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    invoice_number: { type: 'STRING', nullable: true },
    invoice_date: { type: 'STRING', nullable: true, description: 'ISO YYYY-MM-DD' },
    vendor_name: { type: 'STRING', nullable: true },
    po_reference: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', nullable: true },
    line_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', nullable: true },
          quantity: { type: 'NUMBER', nullable: true },
          unit_price: { type: 'NUMBER', nullable: true },
          amount: { type: 'NUMBER', nullable: true },
        },
      },
    },
    subtotal: { type: 'NUMBER', nullable: true },
    tax: { type: 'NUMBER', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    bank_account: { type: 'STRING', nullable: true },
    bank_ifsc: { type: 'STRING', nullable: true },
    remit_to_name: { type: 'STRING', nullable: true },
    document_type: { type: 'STRING', enum: ['invoice', 'credit_note'] },
    notes: { type: 'STRING', nullable: true },
    confidence: {
      type: 'OBJECT',
      properties: Object.fromEntries(EXTRACTION_FIELDS.map((field) => [field, { type: 'NUMBER', nullable: true }])),
    },
    unreadable_fields: { type: 'ARRAY', items: { type: 'STRING' } },
    extraction_notes: { type: 'STRING', nullable: true },
  },
  required: ['document_type', 'confidence', 'unreadable_fields'],
} as const

export const EXTRACTION_PROMPT = `You are extracting structured data from a vendor invoice for an accounts-payable system. A wrong number here causes a wrong payment, so accuracy matters far more than completeness.

Rules:
1. Transcribe only what is printed on the document. Never infer, calculate, or complete a value that is not legible.
2. If a field is absent, obscured, or you cannot read it with confidence, return null for that field and add its name to unreadable_fields. Returning null is the correct answer for an unreadable field — a guess is a failure.
3. Do not compute values. If the subtotal is not printed, return null — do not derive it from the line items. If the total is illegible, return null even though you could add up the parts.
3a. This holds hardest for the total, because it is the figure the vendor is asking to be paid. Arithmetic is never an acceptable source for it: subtotal + tax is a guess about the total, not a reading of it. Where a printed total is faint, blurred, greyed out or partly obscured but still legible, transcribe what it says and score its confidence low. Only when you cannot make it out at all is the answer null plus "total" in unreadable_fields.
3b. Never reconcile the figures with each other. If the total you read does not equal subtotal + tax, that is the document's discrepancy to have, not an error to correct: return every figure exactly as printed and say what you noticed in extraction_notes. Downstream checks exist to catch precisely that mismatch, and they cannot see it if you have already resolved it.
3c. A field named in unreadable_fields must come back null. Listing a field and still returning a value for it says the value was worked out rather than read, and it will be discarded.
4. Transcribe the vendor name exactly as printed, including suffixes, punctuation and spacing. Do not normalise or expand abbreviations.
5. Amounts as plain numbers — no currency symbols, no thousands separators. ₹1,84,500 becomes 184500.
6. Dates as ISO YYYY-MM-DD.
7. remit_to_name is whoever the document says to pay, which may differ from the vendor in the letterhead. Transcribe both separately and do not reconcile them.
8. A negative total or a document titled CREDIT NOTE means document_type is credit_note.
9. For each field give a confidence between 0 and 1 reflecting how clearly you could read it. Be conservative — blurred, rotated or low-contrast text should score low even if you think you know what it says.
10. Note anything structurally odd in extraction_notes: amounts that appear inconsistent, missing sections, signs the document has been altered. Describe what you observe; do not conclude anything about it.`

const STRING_OR_NULL_FIELDS = [
  'invoice_number',
  'invoice_date',
  'vendor_name',
  'po_reference',
  'currency',
  'bank_account',
  'bank_ifsc',
  'remit_to_name',
] as const

const NUMBER_OR_NULL_FIELDS = ['subtotal', 'tax', 'total'] as const

// Exported so both extraction adapters can validate against the same contract:
// Gemini's JSON-text response (via parseExtractionResponseText below) and
// Anthropic's already-parsed tool_use.input (validated directly by providers/anthropic.ts).
export function describeExtractionResultShapeError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'response is not an object'
  const v = value as Record<string, unknown>

  if (v.document_type !== 'invoice' && v.document_type !== 'credit_note') {
    return 'document_type must be "invoice" or "credit_note"'
  }

  for (const field of STRING_OR_NULL_FIELDS) {
    if (v[field] !== null && typeof v[field] !== 'string') return `${field} must be a string or null`
  }

  for (const field of NUMBER_OR_NULL_FIELDS) {
    if (v[field] !== null && typeof v[field] !== 'number') return `${field} must be a number or null`
  }

  if (!Array.isArray(v.line_items)) return 'line_items must be an array'
  for (const item of v.line_items) {
    if (typeof item !== 'object' || item === null) return 'line_items entries must be objects'
  }

  if (!Array.isArray(v.unreadable_fields) || !v.unreadable_fields.every((f) => typeof f === 'string')) {
    return 'unreadable_fields must be an array of strings'
  }

  if (typeof v.confidence !== 'object' || v.confidence === null || Array.isArray(v.confidence)) {
    return 'confidence must be an object'
  }

  if (v.extraction_notes !== null && typeof v.extraction_notes !== 'string') {
    return 'extraction_notes must be a string or null'
  }

  return null
}

// Parses and shape-validates Gemini's raw response text. Throws with the raw text
// attached rather than returning a partially-valid result — a malformed extraction
// must fail loudly, never pass garbage downstream.
export function parseExtractionResponseText(text: string): ExtractionResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Gemini response was not valid JSON: ${text}`)
  }

  const shapeError = describeExtractionResultShapeError(parsed)
  if (shapeError) {
    throw new Error(`Gemini response did not match the expected shape (${shapeError}): ${text}`)
  }

  return parsed as ExtractionResult
}
