import { supabase } from './supabase.ts'
import type {
  AssumptionRow,
  InvoiceRow,
  Json,
  PurchaseOrderRow,
  RuleRow,
  RunRow,
  RunUpdate,
  StageLogRow,
  StageLogStatus,
  Verdict,
  VendorInsert,
  VendorRow,
} from './database.types.ts'

export async function getVendors(): Promise<VendorRow[]> {
  const { data, error } = await supabase.from('vendors').select('*').order('id')
  if (error) throw error
  return data
}

export async function getVendorById(id: string): Promise<VendorRow | null> {
  const { data, error } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function getPurchaseOrders(): Promise<PurchaseOrderRow[]> {
  const { data, error } = await supabase.from('purchase_orders').select('*').order('po_number')
  if (error) throw error
  return data
}

export async function getPOsByVendor(vendorId: string): Promise<PurchaseOrderRow[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('po_number')
  if (error) throw error
  return data
}

export async function getInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase.from('invoices').select('*').order('invoice_date')
  if (error) throw error
  return data
}

export async function getInvoiceByNumber(invoiceNumber: string): Promise<InvoiceRow | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('invoice_number', invoiceNumber)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function createRun(invoiceId: string): Promise<RunRow> {
  const { data, error } = await supabase
    .from('runs')
    .insert({ invoice_id: invoiceId, status: 'running' })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function updateRun(id: string, patch: RunUpdate): Promise<RunRow> {
  const { data, error } = await supabase.from('runs').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  return data
}

export interface RunsFilter {
  verdict?: Verdict
  invoiceId?: string
  status?: RunRow['status']
}

export async function getRuns(filter?: RunsFilter): Promise<RunRow[]> {
  let query = supabase.from('runs').select('*').order('started_at', { ascending: false })
  if (filter?.verdict) query = query.eq('verdict', filter.verdict)
  if (filter?.invoiceId) query = query.eq('invoice_id', filter.invoiceId)
  if (filter?.status) query = query.eq('status', filter.status)
  const { data, error } = await query
  if (error) throw error
  return data
}

export interface RunWithStages {
  run: RunRow
  stages: StageLogRow[]
}

export async function getRunWithStages(id: string): Promise<RunWithStages | null> {
  const { data: run, error: runError } = await supabase.from('runs').select('*').eq('id', id).maybeSingle()
  if (runError) throw runError
  if (!run) return null

  const { data: stages, error: stagesError } = await supabase
    .from('stage_logs')
    .select('*')
    .eq('run_id', id)
    .order('stage_order')
  if (stagesError) throw stagesError

  return { run, stages }
}

export interface StageLogPayload {
  input?: Json | null
  output?: Json | null
  reasoning?: string | null
  duration_ms?: number | null
}

export async function logStage(
  runId: string,
  stage: string,
  stageOrder: number,
  status: StageLogStatus,
  payload: StageLogPayload = {},
): Promise<StageLogRow> {
  const { data, error } = await supabase
    .from('stage_logs')
    .insert({
      run_id: runId,
      stage,
      stage_order: stageOrder,
      status,
      input: payload.input ?? null,
      output: payload.output ?? null,
      reasoning: payload.reasoning ?? null,
      duration_ms: payload.duration_ms ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function updateStageLog(id: string, patch: Partial<StageLogRow>): Promise<StageLogRow> {
  const { data, error } = await supabase.from('stage_logs').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  return data
}

// Completed runs, oldest first — the cross-invoice context the duplicate and
// resubmission-lineage rules read.
export async function getCompletedRuns(): Promise<RunRow[]> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .eq('status', 'complete')
    .order('started_at', { ascending: true })
  if (error) throw error
  return data
}

// Ingest records the document's content hash the first time it is seen, so a
// later submission of the same file can be recognised as an exact duplicate.
export async function setInvoiceFileHash(invoiceId: string, fileHash: string): Promise<void> {
  const { error } = await supabase.from('invoices').update({ file_hash: fileHash }).eq('id', invoiceId)
  if (error) throw error
}

export async function getInvoiceById(id: string): Promise<InvoiceRow | null> {
  const { data, error } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function getRules(): Promise<Record<string, RuleRow>> {
  const { data, error } = await supabase.from('rules').select('*')
  if (error) throw error
  const rules: Record<string, RuleRow> = {}
  for (const rule of data) {
    rules[rule.key] = rule
  }
  return rules
}

export async function updateRule(key: string, value: number): Promise<RuleRow> {
  const { data, error } = await supabase
    .from('rules')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key)
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function getAssumptions(): Promise<AssumptionRow[]> {
  const { data, error } = await supabase.from('assumptions').select('*').order('id')
  if (error) throw error
  return data
}

export async function resetDemoData(): Promise<void> {
  const { error } = await supabase.from('runs').delete().not('id', 'is', null)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Product screens
// ---------------------------------------------------------------------------

// The latest run per invoice, which is what every screen outside the live view
// shows. An invoice re-run after onboarding has two runs; the queue should show
// where it stands now, not where it started.
export async function getLatestRuns(): Promise<RunRow[]> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
  if (error) throw error

  const seen = new Set<string>()
  const latest: RunRow[] = []
  for (const run of data) {
    const key = run.invoice_id ?? run.id
    if (seen.has(key)) continue
    seen.add(key)
    latest.push(run)
  }
  return latest
}

export async function getRunById(id: string): Promise<RunRow | null> {
  const { data, error } = await supabase.from('runs').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function getStageLogs(runId: string): Promise<StageLogRow[]> {
  const { data, error } = await supabase
    .from('stage_logs')
    .select('*')
    .eq('run_id', runId)
    .order('stage_order')
  if (error) throw error
  return data
}

// Records that a person overrode the verdict, and who they were. The original
// verdict and its reason codes stay exactly as the rules left them: the override
// is an additional fact about the run, not a rewrite of what was decided.
export async function recordOverride(runId: string, who: string): Promise<RunRow> {
  const { data, error } = await supabase
    .from('runs')
    .update({ touched_by_human: true, touched_by: who })
    .eq('id', runId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function createVendor(vendor: VendorInsert): Promise<VendorRow> {
  const { data, error } = await supabase.from('vendors').insert(vendor).select('*').single()
  if (error) throw error
  return data
}

// Invoices that have never completed a run. "Fetch new invoices" works through
// these and nothing else, so pressing it twice does not re-run the whole corpus.
export async function getInvoicesWithoutCompletedRun(): Promise<InvoiceRow[]> {
  const [invoices, runs] = await Promise.all([getInvoices(), getCompletedRuns()])
  const decided = new Set(runs.map((run) => run.invoice_id).filter((id): id is string => id !== null))
  return invoices.filter((invoice) => !decided.has(invoice.id))
}
