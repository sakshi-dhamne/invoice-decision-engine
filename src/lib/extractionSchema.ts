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
  'bank_name',
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
  // The bank the account sits in, which is not the party being paid. Held apart
  // from remit_to_name because a payment block names both and they were being
  // read as one: an invoice whose block said "PUNJAB & SIND BANK" came back with
  // the bank as its payee, and the payee is what the entity check compares.
  bank_name: string | null
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

// ---------------------------------------------------------------------------
// What the bytes actually are
// ---------------------------------------------------------------------------

/**
 * The document's type, read off the document.
 *
 * A declared type is a claim about bytes, and the claim can be wrong. The way it
 * goes wrong in this product is specific and was worth a lot of confusion: the
 * seeded PDFs are served as static files from the same origin as the app, and the
 * app rewrites every unmatched path to index.html. A PDF that is missing from the
 * deployment therefore comes back as an HTML page, with status 200 and a content
 * type of text/html. Nothing downstream read the type as unusable, because the
 * client's fallback for an unrecognised header was to call it a PDF, so a web page
 * was posted to the model labelled as a document, and the model answered 400
 * INVALID_ARGUMENT. Every PDF failed and every image was fine, which is exactly
 * what it looks like when the PDFs are the ones being served from the app.
 *
 * So the bytes decide. Every accepted format carries a signature in its first few
 * bytes, and none of them is ambiguous.
 */
const SIGNATURES: readonly { type: AcceptedDocumentType; magic: readonly number[] }[] = [
  // "%PDF-"
  { type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
]

// HEIC and WebP both start with a container header and name the format a few
// bytes in, so they are read as a box rather than as a prefix.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']

function ascii(head: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...head.subarray(from, from + length))
}

/** How many bytes `sniffDocumentType` needs. Everything it reads is in the first 16. */
export const DOCUMENT_HEAD_BYTES = 16

export function sniffDocumentType(head: Uint8Array): AcceptedDocumentType | null {
  for (const { type, magic } of SIGNATURES) {
    if (magic.every((byte, index) => head[index] === byte)) return type
  }
  // "RIFF" .... "WEBP"
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp'
  // An ISO base-media box: its size, then "ftyp", then the brand.
  if (ascii(head, 4, 4) === 'ftyp' && HEIC_BRANDS.includes(ascii(head, 8, 4))) return 'image/heic'
  return null
}

/**
 * The first bytes of a base64 payload, for sniffing.
 *
 * Decodes a prefix rather than the whole document: the signature is in the first
 * few bytes and the payload is megabytes. The slice is cut to a multiple of four
 * so it decodes cleanly on its own.
 */
export function headFromBase64(base64: string, bytes: number = DOCUMENT_HEAD_BYTES): Uint8Array {
  const characters = Math.ceil(bytes / 3) * 4
  const prefix = base64.slice(0, characters)
  const usable = prefix.slice(0, prefix.length - (prefix.length % 4))
  if (usable.length === 0) return new Uint8Array()
  try {
    const binary = atob(usable)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

/**
 * How many bytes a base64 payload decodes to.
 *
 * Four characters carry three bytes, less whatever the padding stands in for.
 * Only ever used in a log line, but a log line that a person is reading against a
 * provider's complaint about size should not be approximate.
 */
export function base64ByteLength(base64: string): number {
  const body = base64.replace(/[\r\n\s]/g, '')
  if (body.length === 0) return 0
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

/**
 * Bytes that are plainly not a document, whatever anything says they are.
 *
 * A server with no document to serve sends a page or an error body, and both are
 * text. This is the case a declared type cannot be trusted through: the whole
 * failure was an HTML page going to the model under a document's name, so a
 * declaration of "application/pdf" over "<!doctype html>" is the claim to refuse
 * rather than the claim to believe.
 *
 * Deliberately narrow. It answers for markup and for JSON, and leaves every
 * binary format that simply has no signature we know to the declaration.
 */
export function looksLikeText(head: Uint8Array): boolean {
  let index = 0
  // A byte-order mark, then whitespace, then the first thing that means anything.
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) index = 3
  while (index < head.length && (head[index] === 0x20 || head[index] === 0x09 || head[index] === 0x0a || head[index] === 0x0d)) {
    index += 1
  }
  const first = head[index]
  return first === 0x3c || first === 0x7b || first === 0x5b
}

/** What to say when something that is not a document arrives where one should be. */
export function unreadableDocumentMessage(declaredType: string | null | undefined): string {
  const declared = declaredType?.trim()
  return (
    'This file is not a PDF or an image we can read' +
    (declared ? `; it arrived as ${declared}` : '') +
    '. If it is a seeded invoice, check the document is present at the address it is served from.'
  )
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
    bank_name: { type: 'STRING', nullable: true, description: 'The bank holding the account, never the payee' },
    remit_to_name: { type: 'STRING', nullable: true, description: 'The party being paid, never their bank' },
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
7. remit_to_name is the party being paid: the account holder the payment block names, which may differ from the vendor in the letterhead. Transcribe both separately and do not reconcile them.
7a. bank_name is the bank the account sits in, printed beside the branch, the IFSC or the SWIFT code. The two are different things: the bank is where the money goes, the remit-to is who it goes to. A block reading "Bank: STATE CO-OPERATIVE BANK / Branch: Fort / A/c name: Larksfield Engineering" has bank_name "STATE CO-OPERATIVE BANK" and remit_to_name "Larksfield Engineering". Never put a bank in remit_to_name: if the block names a bank and no account holder, remit_to_name is null and goes in unreadable_fields.
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

// Fields added after extractions had already been cached. An absent one reads as
// null rather than as a malformed response, so a stored extraction from before
// the field existed is still a valid extraction.
const LATER_STRING_FIELDS = ['bank_name'] as const

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

  for (const field of LATER_STRING_FIELDS) {
    if (v[field] !== undefined && v[field] !== null && typeof v[field] !== 'string') {
      return `${field} must be a string or null`
    }
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
