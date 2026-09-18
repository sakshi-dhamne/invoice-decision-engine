import { supabase } from './supabase.ts'
import type { ExtractInvoiceResponse, ExtractionProviderName, ExtractionResult } from './extractionSchema.ts'
import type { ExtractionRow, Json } from './database.types.ts'

// Self-reported model confidence is weakly calibrated, so the pipeline must not gate
// decisions on it alone. It's for display and for ordering a human review queue.
//
// The decisive checks are deterministic and come later in the rules engine:
// - a null in a required field → INCOMPLETE_EXTRACTION
// - subtotal + tax ≠ total → ARITHMETIC_INCONSISTENT

export interface ExtractionOutcome {
  data: ExtractionResult
  model: string
  provider: ExtractionProviderName
  duration_ms: number
}

export interface CachedExtraction {
  data: ExtractionResult
  model: string
  duration_ms: number | null
  fromCache: boolean
  extractedAt: string
}

export interface GetOrExtractOptions {
  // Skips the cache read and always calls the edge function.
  force?: boolean
  // Forces the edge function's fallback chain down to one provider, bypassing the
  // cache entirely — for the harness's `?provider=` testing mode. The result is
  // still recorded (for audit) but never becomes the invoice's current cached
  // extraction, so a one-off Anthropic test run can't silently swap out the
  // invoice's primary (Gemini) result that the accuracy comparison reads.
  provider?: ExtractionProviderName
}

// Best-effort provider label for a cached row — the extractions table only stores
// `model`, not which provider served it, so this is display-only.
export function providerForModel(model: string): ExtractionProviderName | 'unknown' {
  if (model.startsWith('gemini')) return 'gemini'
  if (model.startsWith('claude')) return 'anthropic'
  return 'unknown'
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function fetchPdfAsBase64(pdfUrl: string): Promise<string> {
  const response = await fetch(pdfUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${pdfUrl}: ${response.status}`)
  }
  const buffer = await response.arrayBuffer()
  return arrayBufferToBase64(buffer)
}

// Fetches a PDF from same-origin `public/invoices/` and posts it to the extract-invoice
// edge function, which is the only thing that talks to Gemini/Anthropic. Not called
// directly outside this module — everything downstream goes through getOrExtract.
async function extractInvoice(
  pdfUrl: string,
  invoiceNumber?: string,
  provider?: ExtractionProviderName,
): Promise<ExtractionOutcome> {
  const pdf_base64 = await fetchPdfAsBase64(pdfUrl)

  const { data, error } = await supabase.functions.invoke<ExtractInvoiceResponse>('extract-invoice', {
    body: { pdf_base64, invoice_number: invoiceNumber, provider },
  })

  if (error) throw error
  if (!data) throw new Error('extract-invoice returned no data')
  if (!data.ok) throw new Error(data.error)

  return { data: data.data, model: data.model, provider: data.provider, duration_ms: data.duration_ms }
}

async function fetchCurrentExtraction(invoiceId: string): Promise<ExtractionRow | null> {
  const { data, error } = await supabase
    .from('extractions')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// All invoices' current extractions in one query, for the harness's initial load
// and its quota guard (counting invoices that still lack a cached extraction).
export async function getCurrentExtractions(): Promise<Map<string, ExtractionRow>> {
  const { data, error } = await supabase.from('extractions').select('*').eq('is_current', true)
  if (error) throw error
  const map = new Map<string, ExtractionRow>()
  for (const row of data) map.set(row.invoice_id, row)
  return map
}

function toCached(row: ExtractionRow, fromCache: boolean): CachedExtraction {
  return {
    data: row.extracted_data as unknown as ExtractionResult,
    model: row.model,
    duration_ms: row.duration_ms,
    fromCache,
    extractedAt: row.created_at,
  }
}

// The only thing that calls the extract-invoice edge function. Unless `force`,
// returns the invoice's current cached extraction if one exists; otherwise runs a
// live extraction, stores it, and returns that (flagged fromCache: false).
export async function getOrExtract(
  invoiceId: string,
  pdfUrl: string,
  invoiceNumber: string | undefined,
  opts: GetOrExtractOptions = {},
): Promise<CachedExtraction> {
  const forceProvider = opts.provider

  if (!opts.force && !forceProvider) {
    const cached = await fetchCurrentExtraction(invoiceId)
    if (cached) return toCached(cached, true)
  }

  const outcome = await extractInvoice(pdfUrl, invoiceNumber, forceProvider)

  if (forceProvider) {
    // Recorded for history/audit but not promoted to `is_current` — a provider
    // test run must not become the invoice's primary cached extraction.
    const { data: inserted, error } = await supabase
      .from('extractions')
      .insert({
        invoice_id: invoiceId,
        extracted_data: outcome.data as unknown as Json,
        model: outcome.model,
        duration_ms: outcome.duration_ms,
        is_current: false,
      })
      .select('*')
      .single()
    if (error) throw error
    return toCached(inserted, false)
  }

  await supabase.from('extractions').update({ is_current: false }).eq('invoice_id', invoiceId).eq('is_current', true)

  const { data: inserted, error } = await supabase
    .from('extractions')
    .insert({
      invoice_id: invoiceId,
      extracted_data: outcome.data as unknown as Json,
      model: outcome.model,
      duration_ms: outcome.duration_ms,
      is_current: true,
    })
    .select('*')
    .single()
  if (error) throw error

  return toCached(inserted, false)
}
