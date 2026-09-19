// Taking in documents nobody has seen before.
//
// The seeded corpus is served from public/invoices. Anything a person uploads goes
// to a Storage bucket instead, and the invoice row records where. Everything
// downstream reads `pdfUrlFor`, so the rest of the pipeline never learns which of
// the two it is working with.
//
// Scanned invoices arrive as phone photos at least as often as PDFs, so an image
// is a first-class document here rather than something to convert first.

import { supabase } from './supabase.ts'
import { ACCEPTED_DOCUMENT_TYPES, isAcceptedDocumentType, type AcceptedDocumentType } from './extractionSchema.ts'
import type { InvoiceRow } from './database.types.ts'

export const UPLOAD_BUCKET = 'invoices'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// What the file picker offers. The extensions matter because a browser hands over
// an empty type for HEIC often enough that the type alone cannot be trusted.
export const UPLOAD_ACCEPT = `${ACCEPTED_DOCUMENT_TYPES.join(',')},.pdf,.png,.jpg,.jpeg,.webp,.heic`

const EXTENSION_TYPES: Readonly<Record<string, AcceptedDocumentType>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
}

/**
 * What this file is, as far as the extraction is concerned.
 *
 * The browser's own guess comes first. When it has none, which happens with HEIC
 * on several platforms, the extension decides. Null means we cannot read it.
 */
export function documentTypeOf(file: File): AcceptedDocumentType | null {
  if (isAcceptedDocumentType(file.type)) return file.type
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_TYPES[extension] ?? null
}

export interface UploadRejection {
  reason: string
}

/**
 * Whether we can accept this file at all.
 *
 * Returns the sentence to show beside it, or null when the file is fine. Each one
 * says what is wrong and what to do about it.
 */
export function rejectUpload(file: File): UploadRejection | null {
  if (!documentTypeOf(file)) {
    return { reason: 'We read PDFs and photos. Send this one as a PDF, or as a picture of the page.' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { reason: 'Larger than 10 MB. Send a smaller scan, or split it into separate invoices.' }
  }
  if (file.size === 0) {
    return { reason: 'This file is empty. Check it opens on your computer, then try again.' }
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
  const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-')
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
export async function uploadInvoiceDocument(file: File): Promise<UploadedInvoice> {
  const contentType = documentTypeOf(file)
  if (!contentType) throw new Error('We read PDFs and photos. This file is neither.')

  const storagePath = storageKeyFor(file)

  const { error: uploadError } = await supabase.storage
    .from(UPLOAD_BUCKET)
    .upload(storagePath, file, { contentType, upsert: false })

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
export async function describeUploadedInvoice(invoiceId: string, patch: Partial<InvoiceRow>): Promise<void> {
  const { error } = await supabase.from('invoices').update(patch).eq('id', invoiceId)
  if (error) throw error
}
