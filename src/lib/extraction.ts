import { supabase } from './supabase.ts'
import type { ExtractInvoiceResponse, ExtractionResult } from './extractionSchema.ts'

// Self-reported model confidence is weakly calibrated, so the pipeline must not gate
// decisions on it alone. It's for display and for ordering a human review queue.
//
// The decisive checks are deterministic and come later in the rules engine:
// - a null in a required field → INCOMPLETE_EXTRACTION
// - subtotal + tax ≠ total → ARITHMETIC_INCONSISTENT

export interface ExtractionOutcome {
  data: ExtractionResult
  model: string
  duration_ms: number
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
// edge function, which is the only thing that talks to Gemini.
export async function extractInvoice(pdfUrl: string, invoiceNumber?: string): Promise<ExtractionOutcome> {
  const pdf_base64 = await fetchPdfAsBase64(pdfUrl)

  const { data, error } = await supabase.functions.invoke<ExtractInvoiceResponse>('extract-invoice', {
    body: { pdf_base64, invoice_number: invoiceNumber },
  })

  if (error) throw error
  if (!data) throw new Error('extract-invoice returned no data')
  if (!data.ok) throw new Error(data.error)

  return { data: data.data, model: data.model, duration_ms: data.duration_ms }
}
