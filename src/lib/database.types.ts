export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type VendorStatus = 'active' | 'inactive'

export type VendorRow = {
  id: string
  legal_name: string
  aliases: string[] | null
  bank_account: string | null
  bank_ifsc: string | null
  // Who confirmed the account above, and how. Recorded when a vendor is onboarded
  // so the payment details are not just numbers somebody typed.
  bank_confirmed_by: string | null
  // When that confirmation happened. A confirmation with no date cannot be aged,
  // and an out-of-band check is only worth anything while it is recent.
  bank_confirmed_at: string | null
  // When the account or IFSC last moved. The decision screens read this: an
  // invoice against a vendor whose account changed in the last thirty days is
  // shown as such at the moment somebody decides it.
  bank_changed_at: string | null
  gstin: string | null
  address: string | null
  email_domain: string | null
  status: VendorStatus
  created_at: string
  added_by: string | null
  updated_at: string | null
  updated_by: string | null
}

// One field, changed once. A save that touches three fields writes three rows, so
// a payment change and an identity edit made together can be told apart.
export type VendorChangeKind = 'created' | 'identity' | 'payment'

export type VendorChangeRow = {
  id: string
  vendor_id: string
  kind: VendorChangeKind
  field: string
  old_value: string | null
  new_value: string | null
  changed_by: string
  // Who confirmed the new account, and how. Present on a payment change and
  // nothing else.
  verification_note: string | null
  changed_at: string
}

export type VendorChangeInsert = Omit<VendorChangeRow, 'id' | 'changed_at'> & { changed_at?: string }

export type VendorInsert = Partial<VendorRow> & Pick<VendorRow, 'id' | 'legal_name' | 'status'>

export type TaxTreatment = 'inclusive' | 'exclusive'
export type PurchaseOrderStatus = 'open' | 'closed' | 'cancelled'

export type PurchaseOrderRow = {
  po_number: string
  vendor_id: string | null
  total_amount: number | null
  currency: string
  amount_billed_to_date: number
  tax_treatment: TaxTreatment | null
  status: PurchaseOrderStatus | null
  line_items: Json | null
  delivery_schedule: Json | null
  issued_date: string | null
  created_at: string
}

export type PurchaseOrderInsert = Partial<PurchaseOrderRow> & Pick<PurchaseOrderRow, 'po_number'>

export type DocumentType = 'invoice' | 'credit_note'

export type InvoiceRow = {
  id: string
  invoice_number: string
  file_path: string | null
  // Set when the document was uploaded through the product rather than seeded.
  // The extraction client reads from Storage when this is present and from
  // public/invoices otherwise.
  storage_path: string | null
  file_hash: string | null
  vendor_name_as_printed: string | null
  vendor_id: string | null
  po_reference: string | null
  invoice_date: string | null
  currency: string | null
  subtotal: number | null
  tax: number | null
  total: number | null
  bank_account_printed: string | null
  remit_to_name: string | null
  document_type: DocumentType
  line_items: Json | null
  extraction_confidence: Json | null
  parent_invoice_number: string | null
  notes_field: string | null
  expected_verdict: string | null
  fields_not_printed: string[] | null
  created_at: string
}

export type InvoiceInsert = Partial<InvoiceRow> & Pick<InvoiceRow, 'invoice_number'>

export type ExtractionRow = {
  id: string
  invoice_id: string
  extracted_data: Json
  model: string
  duration_ms: number | null
  is_current: boolean
  created_at: string
}

export type ExtractionInsert = Partial<ExtractionRow> &
  Pick<ExtractionRow, 'invoice_id' | 'extracted_data' | 'model'>

export type RunStatus = 'running' | 'complete' | 'failed'
export type Verdict = 'AUTO_APPROVE' | 'REVIEW' | 'HOLD' | 'BLOCK' | 'ROUTED_NOT_PAID'

export type RunRow = {
  id: string
  invoice_id: string | null
  status: RunStatus | null
  verdict: Verdict | null
  reason_codes: string[] | null
  parent_run_id: string | null
  changed_fields: Json | null
  matched_po: string | null
  explanation: string | null
  started_at: string
  finished_at: string | null
  touched_by_human: boolean
  // Who overrode the verdict, when someone did.
  touched_by: string | null
  // When they did. Null on a run overridden before this was recorded, which reads
  // as a missing time rather than being filled in with a guess.
  approved_at: string | null
  // Set when a person filed a duplicate away. The verdict and reason codes stay
  // exactly as the rules left them; this is an extra fact about the run.
  discarded_at: string | null
  discarded_by: string | null
}

export type RunInsert = Partial<RunRow>

export type RunUpdate = Partial<Omit<RunRow, 'id'>>

export type StageLogStatus = 'pending' | 'running' | 'passed' | 'flagged' | 'failed'

export type StageLogRow = {
  id: string
  run_id: string
  stage: string
  stage_order: number
  status: StageLogStatus | null
  input: Json | null
  output: Json | null
  reasoning: string | null
  duration_ms: number | null
  created_at: string
}

export type StageLogInsert = Partial<StageLogRow> & Pick<StageLogRow, 'run_id' | 'stage' | 'stage_order'>

export type RuleRow = {
  key: string
  value: number | null
  unit: string | null
  description: string | null
  updated_at: string
}

export type AssumptionRow = {
  id: number
  text: string | null
  category: string | null
  made_on: string
}

export type RuleInsert = Partial<RuleRow> & Pick<RuleRow, 'key'>
export type AssumptionInsert = Partial<Omit<AssumptionRow, 'id'>>

type EmptyRelationships = { Relationships: [] }

export type Database = {
  public: {
    Tables: {
      vendors: { Row: VendorRow; Insert: VendorInsert; Update: Partial<VendorInsert> } & EmptyRelationships
      vendor_changes: {
        Row: VendorChangeRow
        Insert: VendorChangeInsert
        Update: Partial<VendorChangeInsert>
      } & EmptyRelationships
      purchase_orders: { Row: PurchaseOrderRow; Insert: PurchaseOrderInsert; Update: Partial<PurchaseOrderInsert> } &
        EmptyRelationships
      invoices: { Row: InvoiceRow; Insert: InvoiceInsert; Update: Partial<InvoiceInsert> } & EmptyRelationships
      extractions: { Row: ExtractionRow; Insert: ExtractionInsert; Update: Partial<ExtractionInsert> } &
        EmptyRelationships
      runs: { Row: RunRow; Insert: RunInsert; Update: RunUpdate } & EmptyRelationships
      stage_logs: { Row: StageLogRow; Insert: StageLogInsert; Update: Partial<StageLogInsert> } & EmptyRelationships
      rules: { Row: RuleRow; Insert: RuleInsert; Update: Partial<RuleRow> } & EmptyRelationships
      assumptions: { Row: AssumptionRow; Insert: AssumptionInsert; Update: Partial<AssumptionRow> } &
        EmptyRelationships
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}
