// Shared vocabulary for the rules engine: verdicts, reason codes, the tunable
// rule set, and the plain record shapes the pure rules operate on.
//
// The rules deliberately do NOT import database row types. `pipeline.ts` adapts
// Supabase rows into these records, which keeps every rule a function of plain
// data and lets the tests build inputs without a database.

export type Verdict = 'AUTO_APPROVE' | 'REVIEW' | 'HOLD' | 'BLOCK' | 'ROUTED_NOT_PAID'

export const REASON_CODES = [
  'CREDIT_NOTE',
  'EXACT_DUPLICATE',
  'UNDECLARED_AMENDMENT',
  'RESUBMISSION',
  'BANK_DETAIL_MISMATCH',
  'PAYEE_ENTITY_MISMATCH',
  'VENDOR_INACTIVE',
  'UNKNOWN_VENDOR',
  'PO_NOT_OPEN',
  'CURRENCY_MISMATCH',
  'DATE_OUT_OF_RANGE',
  'INCOMPLETE_EXTRACTION',
  'ARITHMETIC_INCONSISTENT',
  'TAX_TREATMENT_UNCLEAR',
  'NO_PO_MATCH',
  'AMBIGUOUS_PO_MATCH',
  'QUANTITY_MISMATCH',
  'PRICE_VARIANCE',
  'UNMATCHED_LINE_ITEM',
  'THRESHOLD_SPLIT_SUSPECTED',
  'NEAR_DUPLICATE',
  'PO_OVERAGE',
  'ABOVE_AUTO_APPROVE_LIMIT',
  'CLEAN_MATCH',
  // Advisory only — carried through to the decision so the reviewer sees it, but
  // it never selects a verdict on its own.
  'LOW_CONFIDENCE_VENDOR_MATCH',
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

// ---------------------------------------------------------------------------
// Tunable thresholds — every one of these is read from the `rules` table at
// runtime. No operational number is hardcoded in src/rules/.
// ---------------------------------------------------------------------------

export const RULE_KEYS = [
  'matching_tolerance_pct',
  'matching_tolerance_floor',
  'auto_approve_limit',
  'vendor_match_threshold',
  'vendor_match_floor',
  'po_ambiguity_margin',
  'near_duplicate_window_days',
  'split_pattern_window_days',
  'split_pattern_min_invoices',
  'stale_invoice_days',
  'po_weight_amount',
  'po_weight_description',
  'po_weight_date',
  'po_candidate_floor',
  'po_date_window_days',
  'line_match_threshold',
  'arithmetic_tolerance',
  'near_duplicate_amount_pct',
  'split_pattern_cv_max',
] as const

export type RuleKey = (typeof RULE_KEYS)[number]
export type RuleSet = Readonly<Record<RuleKey, number>>

// Fails loudly on a missing threshold rather than falling back to a default: a
// silently-defaulted rule is a rule nobody can audit.
export function toRuleSet(values: Readonly<Record<string, number | null | undefined>>): RuleSet {
  const missing: string[] = []
  const resolved = {} as Record<RuleKey, number>

  for (const key of RULE_KEYS) {
    const value = values[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push(key)
      continue
    }
    resolved[key] = value
  }

  if (missing.length > 0) {
    throw new Error(
      `rules table is missing ${missing.length} threshold(s): ${missing.join(', ')}. ` +
        'Apply supabase/migrations/002_seed.sql and 005_rules_engine.sql.',
    )
  }

  return resolved
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type DocumentType = 'invoice' | 'credit_note'

export interface LineItemFact {
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
}

// Everything the rules know about the document in front of them. Populated from
// the extraction (stage 2), never from fixture metadata.
export interface InvoiceFacts {
  invoice_number: string | null
  invoice_date: string | null
  vendor_name: string | null
  po_reference: string | null
  currency: string | null
  line_items: LineItemFact[]
  subtotal: number | null
  tax: number | null
  total: number | null
  bank_account: string | null
  remit_to_name: string | null
  document_type: DocumentType
  notes: string | null
  file_hash: string | null
  // Fields the source document genuinely never printed (a tax-inclusive layout
  // states one total and no split). A null here is a correct abstention, not a
  // failed read, and the checks that depend on those fields stand down.
  fields_not_printed: string[]
}

export interface VendorRecord {
  id: string
  legal_name: string
  aliases: string[]
  bank_account: string | null
  status: 'active' | 'inactive'
}

export interface PurchaseOrderLine {
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
  // Goods-receipt data is out of scope (two-way match), so this is absent in
  // practice and treated as 0.
  qty_received_to_date?: number | null
}

export interface DeliveryMilestone {
  milestone: string | null
  description: string | null
  amount: number | null
  due_date: string | null
}

export interface PurchaseOrderRecord {
  po_number: string
  vendor_id: string | null
  total_amount: number | null
  currency: string | null
  amount_billed_to_date: number
  tax_treatment: 'inclusive' | 'exclusive' | null
  status: 'open' | 'closed' | 'cancelled' | null
  line_items: PurchaseOrderLine[]
  delivery_schedule: DeliveryMilestone[] | null
  issued_date: string | null
}

// One previously received document, as recorded in the invoice ledger. This is
// the cross-invoice context the duplicate and split rules need; `vendor_id` is
// the vendor the same stage-3 resolver assigned to it, not a stored label.
export interface SubmissionRecord {
  id: string
  invoice_number: string
  vendor_id: string | null
  po_reference: string | null
  invoice_date: string | null
  total: number | null
  document_type: DocumentType
  notes: string | null
  file_hash: string | null
}

// A completed prior run of the same invoice number for the same vendor, with the
// facts it decided on — the parent a resubmission is diffed against.
export interface PriorRun {
  run_id: string
  invoice_number: string
  vendor_id: string | null
  verdict: Verdict | null
  reason_codes: ReasonCode[]
  facts: InvoiceFacts
  started_at: string
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

export type Evidence = Record<string, unknown>

// Every stage-5 check returns this shape. The evidence object is what the UI
// shows and what the audit trail stores, so it names concrete values rather than
// restating the rule.
export interface CheckResult {
  passed: boolean
  code?: ReasonCode
  evidence?: Evidence
}

export function pass(evidence?: Evidence): CheckResult {
  return evidence ? { passed: true, evidence } : { passed: true }
}

export function fail(code: ReasonCode, evidence?: Evidence): CheckResult {
  return { passed: false, code, evidence }
}

// A check that could not run at all (no vendor resolved, no PO matched). Distinct
// from passing: a skipped check must never be read as evidence of correctness.
export function skipped(reason: string): CheckResult {
  return { passed: true, evidence: { skipped: reason } }
}

export function isSkipped(result: CheckResult): boolean {
  return result.passed && typeof result.evidence?.skipped === 'string'
}
