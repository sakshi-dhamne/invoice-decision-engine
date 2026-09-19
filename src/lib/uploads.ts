// Taking in a document nobody has seen before.
//
// The seeded corpus is served from public/invoices. Anything a person uploads goes
// to a Storage bucket instead, and the invoice row records where. Everything
// downstream reads `pdfUrlFor`, so the rest of the pipeline never learns which of
// the two it is working with.

import { supabase } from './supabase.ts'
import type { InvoiceRow } from './database.types.ts'

export const UPLOAD_BUCKET = 'invoices'

// Two guards on the file picker, both reported in the dialog rather than thrown.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export interface UploadRejection {
  reason: string
}

/**
 * Whether we can accept this file at all.
 *
 * Returns the sentence to show under the drop zone, or null when the file is fine.
 * Both messages say what is wrong and what to do about it.
 */
export function rejectUpload(file: File): UploadRejection | null {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!isPdf) {
    return { reason: 'That file is not a PDF. Choose the invoice as a PDF and try again.' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { reason: 'That file is larger than 10 MB. Send a smaller scan, or split it into separate invoices.' }
  }
  if (file.size === 0) {
    return { reason: 'That file is empty. Check it opens on your computer, then try again.' }
  }
  return null
}

// Storage object keys have to be predictable and collision-free. The invoice
// number is not either, so the key is time-stamped and the original name is kept
// only for the part a person might recognise.
function storageKeyFor(file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80)
  return `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
}

// A stand-in number until the extraction reads the real one. It is replaced on the
// invoice row as soon as stage 2 returns, so a person never sees it for long.
function provisionalNumberFor(file: File): string {
  const stem = file.name.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-')
  return stem.slice(0, 60) || `Upload ${new Date().toISOString().slice(0, 10)}`
}

export interface UploadedInvoice {
  invoice: InvoiceRow
  storagePath: string
}

/**
 * Puts the file in Storage and opens an invoice row for it.
 *
 * The row carries almost nothing: a document we have never seen has no vendor, no
 * order and no total until it has been read. Filling any of that in here would be
 * guessing, and the rules would then be checking our guess rather than the page.
 */
export async function uploadInvoicePdf(file: File): Promise<UploadedInvoice> {
  const storagePath = storageKeyFor(file)

  const { error: uploadError } = await supabase.storage
    .from(UPLOAD_BUCKET)
    .upload(storagePath, file, { contentType: 'application/pdf', upsert: false })

  if (uploadError) {
    throw new Error(
      `The file could not be saved (${uploadError.message}). Check the invoices storage bucket exists, then try again.`,
    )
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      invoice_number: provisionalNumberFor(file),
      storage_path: storagePath,
      file_path: storagePath,
      document_type: 'invoice',
    })
    .select('*')
    .single()

  if (error) {
    throw new Error(`The file was saved but the invoice record could not be created (${error.message}).`)
  }

  return { invoice: data, storagePath }
}

/**
 * What the extraction reads, once the document has been read.
 *
 * An uploaded invoice starts life with a placeholder number and no figures. The
 * extraction is the first thing that knows what the document actually says, so the
 * row is brought up to date from it. These columns are for display and for the
 * cross-invoice ledger; the rules keep deciding on the extraction itself.
 */
export async function describeUploadedInvoice(
  invoiceId: string,
  patch: Partial<InvoiceRow>,
): Promise<void> {
  const { error } = await supabase.from('invoices').update(patch).eq('id', invoiceId)
  if (error) throw error
}
