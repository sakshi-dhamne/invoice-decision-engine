// The rules/database boundary.
//
// pipeline.ts is the only file in the decision path that does I/O, so most of it
// is not unit-testable offline. Its row adapters are pure, though, and they are
// where a schema change would quietly corrupt the facts the rules decide on.

import { describe, expect, it } from 'vitest'

import { toInvoiceFacts, toPurchaseOrderRecord, toVendorRecord } from '../src/lib/pipeline.ts'
import type { InvoiceRow, PurchaseOrderRow, VendorRow } from '../src/lib/database.types.ts'
import type { ExtractionResult } from '../src/lib/extractionSchema.ts'

const invoiceRow: InvoiceRow = {
  id: 'row-1',
  invoice_number: 'WPM/2026/0042',
  file_path: 'fixtures/pdfs/westmark.pdf',
  file_hash: 'sha256:westmark-0042',
  vendor_name_as_printed: 'Westmark Paper Mills LLP',
  vendor_id: 'WM-1',
  po_reference: 'REQ-88120',
  invoice_date: '2026-09-05',
  currency: 'INR',
  // Accounting truth on the ledger row, deliberately different from what the
  // document printed — the rules must read the extraction, not this.
  subtotal: 120000,
  tax: 21600,
  total: 141600,
  bank_account_printed: '778899001122334',
  remit_to_name: 'Westmark Paper Mills LLP',
  document_type: 'invoice',
  line_items: null,
  extraction_confidence: null,
  parent_invoice_number: null,
  notes_field: 'ledger note',
  expected_verdict: 'AUTO_APPROVE',
  fields_not_printed: ['subtotal'],
  created_at: '2026-09-05T00:00:00Z',
}

const extraction: ExtractionResult = {
  invoice_number: 'WPM/2026/0042',
  invoice_date: '2026-09-05',
  vendor_name: 'Westmark Paper Mills LLP',
  po_reference: 'REQ-88120',
  currency: 'INR',
  line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 6000, amount: 120000 }],
  subtotal: null,
  tax: 21600,
  total: 141600,
  bank_account: '778899001122334',
  bank_ifsc: 'TEST0001234',
  remit_to_name: 'Westmark Paper Mills LLP',
  document_type: 'invoice',
  notes: 'printed note',
  confidence: {},
  unreadable_fields: ['tax'],
  extraction_notes: null,
}

describe('row adapters', () => {
  it('builds facts from the extraction, not from the ledger row', () => {
    const facts = toInvoiceFacts(extraction, invoiceRow)
    expect(facts.subtotal).toBeNull()
    expect(facts.notes).toBe('printed note')
    expect(facts.line_items).toHaveLength(1)
  })

  it('takes the file hash from the ledger row, which is where ingest records it', () => {
    expect(toInvoiceFacts(extraction, invoiceRow).file_hash).toBe('sha256:westmark-0042')
  })

  it('unions what the document never prints with what the model could not read', () => {
    expect(toInvoiceFacts(extraction, invoiceRow).fields_not_printed.sort()).toEqual(['subtotal', 'tax'])
  })

  it('defaults a null aliases column to an empty list rather than crashing the scorer', () => {
    const row: VendorRow = {
      id: 'WM-1',
      legal_name: 'Westmark Paper Mills LLP',
      aliases: null,
      bank_account: '778899001122334',
      bank_ifsc: null,
      gstin: null,
      address: null,
      email_domain: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    }
    expect(toVendorRecord(row).aliases).toEqual([])
  })

  it('reads jsonb line items and delivery schedules, and keeps a null schedule null', () => {
    const row: PurchaseOrderRow = {
      po_number: 'REQ-88120',
      vendor_id: 'WM-1',
      total_amount: 141600,
      currency: 'INR',
      amount_billed_to_date: 0,
      tax_treatment: 'inclusive',
      status: 'open',
      line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 7080, amount: 141600 }],
      delivery_schedule: null,
      issued_date: '2026-08-25',
      created_at: '2026-08-25T00:00:00Z',
    }
    const record = toPurchaseOrderRecord(row)
    expect(record.line_items).toHaveLength(1)
    expect(record.delivery_schedule).toBeNull()

    const scheduled = toPurchaseOrderRecord({
      ...row,
      delivery_schedule: [{ milestone: 'P1', description: 'First reel delivery', amount: 70800, due_date: '2026-09-10' }],
    })
    expect(scheduled.delivery_schedule).toHaveLength(1)
  })
})
