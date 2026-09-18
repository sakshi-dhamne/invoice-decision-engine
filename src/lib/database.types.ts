export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type VendorStatus = 'active' | 'inactive'

export type VendorRow = {
  id: string
  legal_name: string
  aliases: string[] | null
  bank_account: string | null
  bank_ifsc: string | null
  gstin: string | null
  address: string | null
  email_domain: string | null
  status: VendorStatus
  created_at: string
}

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
