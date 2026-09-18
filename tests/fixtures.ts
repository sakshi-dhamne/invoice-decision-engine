// Test-corpus loader.
//
// Reads the same JSON fixtures that seed the database and adapts them into the
// plain records the rules engine takes. It is a loader and nothing more: it does
// not special-case any invoice, vendor or purchase order, and the rules never see
// a fixture's `expected_verdict` — that is only ever the assertion target.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { resolveVendor } from '../src/rules/vendor.ts'
import { toRuleSet } from '../src/rules/types.ts'
import type {
  InvoiceFacts,
  LineItemFact,
  PurchaseOrderRecord,
  RuleSet,
  SubmissionRecord,
  VendorRecord,
} from '../src/rules/types.ts'

function readJson<T>(relativePath: string): T {
  const url = new URL(`../${relativePath}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T
}

interface VendorFixture {
  id: string
  legal_name: string
  aliases: string[]
  bank_account: string
  status: 'active' | 'inactive'
}

interface PoFixture {
  po_number: string
  vendor_id: string
  total_amount: number
  currency: string
  amount_billed_to_date: number
  tax_treatment: 'inclusive' | 'exclusive'
  status: 'open' | 'closed' | 'cancelled'
  issued_date: string
  line_items: { description: string; quantity: number; unit_price: number; amount: number }[]
  delivery_schedule?: { milestone: string; description: string; amount: number; due_date: string }[]
}

interface InvoiceFixture {
  invoice_number: string
  vendor_name_as_printed: string
  po_reference: string | null
  invoice_date: string
  currency: string
  line_items: LineItemFact[]
  subtotal: number | null
  tax: number | null
  total: number | null
  bank_account_printed: string
  remit_to_name: string
  document_type: 'invoice' | 'credit_note'
  template: string
  notes_field: string | null
  parent_invoice_number: string | null
  expected_verdict: string
  case_description: string
  pdf_filename: string
}

// Layout "b" states a single tax-inclusive total with no subtotal/tax split, so a
// correct extraction returns null for both. Mirrors 004_fields_not_printed.sql,
// which derives the same set from the template rather than naming invoices.
const TAX_INCLUSIVE_TEMPLATE = 'b'

export const VENDOR_FIXTURES = readJson<VendorFixture[]>('fixtures/vendors.json')
export const PO_FIXTURES = readJson<PoFixture[]>('fixtures/purchase_orders.json')
export const INVOICE_FIXTURES = readJson<InvoiceFixture[]>('fixtures/invoices.json')

export const vendors: VendorRecord[] = VENDOR_FIXTURES.map((vendor) => ({
  id: vendor.id,
  legal_name: vendor.legal_name,
  aliases: vendor.aliases ?? [],
  bank_account: vendor.bank_account,
  status: vendor.status,
}))

export const purchaseOrders: PurchaseOrderRecord[] = PO_FIXTURES.map((po) => ({
  po_number: po.po_number,
  vendor_id: po.vendor_id,
  total_amount: po.total_amount,
  currency: po.currency,
  amount_billed_to_date: po.amount_billed_to_date,
  tax_treatment: po.tax_treatment,
  status: po.status,
  line_items: po.line_items,
  delivery_schedule: po.delivery_schedule ?? null,
  issued_date: po.issued_date,
}))

// The ten thresholds 002_seed.sql seeds plus the nine 005_rules_engine.sql adds.
// Values are duplicated here rather than read from SQL so the suite runs with no
// network; a drift between the two is caught by tests/rules.spec.ts.
export const rules: RuleSet = toRuleSet({
  matching_tolerance_pct: 0.02,
  matching_tolerance_floor: 1000,
  auto_approve_limit: 200000,
  vendor_match_threshold: 0.85,
  vendor_match_floor: 0.6,
  po_ambiguity_margin: 0.15,
  near_duplicate_window_days: 14,
  split_pattern_window_days: 10,
  split_pattern_min_invoices: 3,
  stale_invoice_days: 180,
  po_weight_amount: 0.5,
  po_weight_description: 0.3,
  po_weight_date: 0.2,
  po_candidate_floor: 0.5,
  po_date_window_days: 365,
  line_match_threshold: 0.6,
  arithmetic_tolerance: 1,
  near_duplicate_amount_pct: 0.01,
  split_pattern_cv_max: 0.05,
})

export interface CorpusDocument {
  id: string
  expected_verdict: string
  case_description: string
  facts: InvoiceFacts
  // The vendor stage 3 resolves for this document, used to scope the ledger. Not
  // read from the fixture's vendor_id.
  resolved_vendor_id: string | null
}

function toFacts(fixture: InvoiceFixture): InvoiceFacts {
  const fieldsNotPrinted = fixture.template === TAX_INCLUSIVE_TEMPLATE ? ['subtotal', 'tax'] : []
  return {
    invoice_number: fixture.invoice_number,
    invoice_date: fixture.invoice_date,
    vendor_name: fixture.vendor_name_as_printed,
    po_reference: fixture.po_reference,
    currency: fixture.currency,
    line_items: fixture.line_items,
    // A correct extraction abstains on a field the document never printed.
    subtotal: fieldsNotPrinted.includes('subtotal') ? null : fixture.subtotal,
    tax: fieldsNotPrinted.includes('tax') ? null : fixture.tax,
    total: fixture.total,
    bank_account: fixture.bank_account_printed,
    remit_to_name: fixture.remit_to_name,
    document_type: fixture.document_type,
    notes: fixture.notes_field,
    file_hash: `sha256:${fixture.pdf_filename}`,
    fields_not_printed: fieldsNotPrinted,
  }
}

export const corpus: CorpusDocument[] = INVOICE_FIXTURES.map((fixture) => {
  const facts = toFacts(fixture)
  return {
    id: fixture.pdf_filename,
    expected_verdict: fixture.expected_verdict,
    case_description: fixture.case_description,
    facts,
    resolved_vendor_id: resolveVendor(facts.vendor_name, vendors, rules).vendor?.id ?? null,
  }
})

// The received-document ledger: every document in the corpus, as the ingest stage
// would have recorded it.
export const ledger: SubmissionRecord[] = corpus.map((document) => ({
  id: document.id,
  invoice_number: document.facts.invoice_number ?? '',
  vendor_id: document.resolved_vendor_id,
  po_reference: document.facts.po_reference,
  invoice_date: document.facts.invoice_date,
  total: document.facts.total,
  document_type: document.facts.document_type,
  notes: document.facts.notes,
  file_hash: document.facts.file_hash,
}))

// Documents are decided in the order they were received, so a resubmission sees
// its parent and a near-duplicate sees the invoice it duplicates.
export const corpusInReceiptOrder: CorpusDocument[] = [...corpus].sort((a, b) => {
  const byDate = String(a.facts.invoice_date).localeCompare(String(b.facts.invoice_date))
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id)
})

export function findDocument(pdfFilename: string): CorpusDocument {
  const found = corpus.find((document) => document.id === pdfFilename)
  if (!found) throw new Error(`No corpus document named ${pdfFilename}`)
  return found
}
