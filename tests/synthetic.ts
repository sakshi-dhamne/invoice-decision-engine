// A vendor, purchase order and invoice that share no name, number or amount with
// the fixture corpus.
//
// Everything here exists to prove the rules are general: this company is not in
// vendors.json, its order is not in purchase_orders.json, and its invoice is not
// in invoices.json, yet it flows through the identical code path. The same world
// also supplies the cases the corpus happens not to cover, so no rule is left
// untested.

import type {
  InvoiceFacts,
  PurchaseOrderRecord,
  SubmissionRecord,
  VendorRecord,
} from '../src/rules/types.ts'

export const SYNTHETIC_VENDOR: VendorRecord = {
  id: 'WM-1',
  legal_name: 'Westmark Paper Mills LLP',
  aliases: ['Westmark Paper'],
  bank_account: '778899001122334',
  status: 'active',
}

export const SYNTHETIC_PO: PurchaseOrderRecord = {
  po_number: 'REQ-88120',
  vendor_id: SYNTHETIC_VENDOR.id,
  total_amount: 141600,
  currency: 'INR',
  amount_billed_to_date: 0,
  tax_treatment: 'exclusive',
  status: 'open',
  line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 7080, amount: 141600 }],
  delivery_schedule: null,
  issued_date: '2026-08-25',
}

export const SYNTHETIC_INVOICE: InvoiceFacts = {
  invoice_number: 'WPM/2026/0042',
  invoice_date: '2026-09-05',
  vendor_name: 'Westmark Paper Mills LLP',
  po_reference: 'REQ-88120',
  currency: 'INR',
  // Lines are stated net; 120000 x 1.18 = 141600 gross, which is what the order
  // authorises. Gross unit price is 6000 x 1.18 = 7080, the PO price exactly.
  line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 6000, amount: 120000 }],
  subtotal: 120000,
  tax: 21600,
  total: 141600,
  bank_account: '778899001122334',
  remit_to_name: 'Westmark Paper Mills LLP',
  document_type: 'invoice',
  notes: null,
  file_hash: 'sha256:westmark-0042',
  fields_not_printed: [],
}

export const SYNTHETIC_VENDORS: VendorRecord[] = [SYNTHETIC_VENDOR]
export const SYNTHETIC_POS: PurchaseOrderRecord[] = [SYNTHETIC_PO]

export function syntheticInvoice(overrides: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return { ...SYNTHETIC_INVOICE, ...overrides }
}

export function syntheticPo(overrides: Partial<PurchaseOrderRecord> = {}): PurchaseOrderRecord {
  return { ...SYNTHETIC_PO, ...overrides }
}

export function syntheticSubmission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    id: 'synthetic-prior',
    invoice_number: 'WPM/2026/0031',
    vendor_id: SYNTHETIC_VENDOR.id,
    po_reference: SYNTHETIC_PO.po_number,
    invoice_date: '2026-09-02',
    total: 141600,
    document_type: 'invoice',
    notes: null,
    file_hash: 'sha256:westmark-0031',
    ...overrides,
  }
}
