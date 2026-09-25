import { supabase } from './supabase.ts'
import { latestRunPerInvoice } from './runState.ts'
import type {
  AssumptionRow,
  InvoiceRow,
  Json,
  PurchaseOrderInsert,
  PurchaseOrderRow,
  RuleRow,
  RunRow,
  RunUpdate,
  StageLogRow,
  StageLogStatus,
  Verdict,
  VendorChangeInsert,
  VendorChangeRow,
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

// The latest run per invoice record, which is what every screen outside the live
// view shows. An invoice re-run after onboarding has two runs; the queue should
// show where it stands now, not where it started. The selection rule itself lives
// in feed.ts, where it can be tested without a database.
export async function getLatestRuns(): Promise<RunRow[]> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
  if (error) throw error
  return latestRunPerInvoice(data)
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

/**
 * Records that a person overrode the verdict: who, and when.
 *
 * The rules' verdict and reason codes stay exactly as they left them. That is the
 * record of what was caught, and rewriting it would mean nobody could ever see
 * what had been overruled.
 *
 * The outcome is a different question from the record, and it does change: once a
 * person has approved an invoice it is approved. `effectiveVerdict` in feed.ts
 * reads the two together, which is what takes the invoice out of the queue and
 * shows it as approved by a person rather than by the rules.
 */
export async function recordOverride(runId: string, who: string): Promise<RunRow> {
  const { data, error } = await supabase
    .from('runs')
    .update({ touched_by_human: true, touched_by: who, approved_at: new Date().toISOString() })
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

// ---------------------------------------------------------------------------
// Vendor history
// ---------------------------------------------------------------------------

/**
 * Applies an edit and records what it changed, field by field.
 *
 * The change rows are written first. If the update then fails the trail carries an
 * edit that did not land, which reads as a mistake somebody can investigate; the
 * other order loses the record of a change that did land, which reads as nothing
 * at all. Where the two can come apart, the trail is the half worth keeping.
 *
 * The caller decides which fields moved and how each one is classified. This is
 * the write, not the policy.
 */
export async function applyVendorEdit(input: {
  vendorId: string
  patch: Partial<VendorInsert>
  changes: readonly Omit<VendorChangeInsert, 'vendor_id'>[]
}): Promise<VendorRow> {
  if (input.changes.length > 0) {
    const { error: trailError } = await supabase
      .from('vendor_changes')
      .insert(input.changes.map((change) => ({ ...change, vendor_id: input.vendorId })))
    if (trailError) throw trailError
  }

  const { data, error } = await supabase
    .from('vendors')
    .update(input.patch)
    .eq('id', input.vendorId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Every edit ever made to one vendor, most recent first.
export async function getVendorChanges(vendorId: string): Promise<VendorChangeRow[]> {
  const { data, error } = await supabase
    .from('vendor_changes')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('changed_at', { ascending: false })
  if (error) throw error
  return data
}

// The same, for every vendor at once, so the list screen can show each vendor's
// last change without a query per row.
export async function getAllVendorChanges(): Promise<Map<string, VendorChangeRow[]>> {
  const { data, error } = await supabase
    .from('vendor_changes')
    .select('*')
    .order('changed_at', { ascending: false })
  if (error) throw error

  const byVendor = new Map<string, VendorChangeRow[]>()
  for (const row of data) {
    const existing = byVendor.get(row.vendor_id)
    if (existing) existing.push(row)
    else byVendor.set(row.vendor_id, [row])
  }
  return byVendor
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/**
 * Raises an order.
 *
 * Used when a held invoice cites no order and somebody decides the work was
 * genuinely authorised. The invoice is re-run afterwards by the caller, so the
 * order is checked by the same rules as any other rather than being assumed good.
 */
export async function createPurchaseOrder(order: PurchaseOrderInsert): Promise<PurchaseOrderRow> {
  const { data, error } = await supabase.from('purchase_orders').insert(order).select('*').single()
  if (error) throw error
  return data
}

// How long each extraction actually took, from the stage log the pipeline writes.
// The dashboard reports the median of these rather than a cost, because the token
// counts and the price list that a cost needs are not recorded anywhere.
export async function getExtractionDurations(): Promise<number[]> {
  const { data, error } = await supabase
    .from('stage_logs')
    .select('duration_ms')
    .eq('stage', 'extract')
    .not('duration_ms', 'is', null)
  if (error) throw error
  return data.map((row) => row.duration_ms).filter((value): value is number => value !== null)
}

/**
 * Files a duplicate away.
 *
 * The verdict and its reason code are left alone: the rules blocked a duplicate
 * and that stays true. This records that a person has dealt with it, which is what
 * takes it off the queue.
 */
export async function discardRun(runId: string, who: string): Promise<RunRow> {
  const { data, error } = await supabase
    .from('runs')
    .update({ discarded_at: new Date().toISOString(), discarded_by: who })
    .eq('id', runId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Vendors, with the orders they have open, for the vendor list.
export async function getVendorsWithActivity(): Promise<{ vendor: VendorRow; openOrders: number }[]> {
  const [vendors, orders] = await Promise.all([getVendors(), getPurchaseOrders()])
  return vendors.map((vendor) => ({
    vendor,
    openOrders: orders.filter((order) => order.vendor_id === vendor.id && order.status === 'open').length,
  }))
}

// The ingest stage's output for a set of runs. The queue needs it only for the
// duplicates, which is where stage 1 records what the document repeats, so this is
// asked for by run rather than loaded for everything.
export async function getIngestOutputs(runIds: readonly string[]): Promise<Map<string, Json>> {
  if (runIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('stage_logs')
    .select('run_id, output')
    .eq('stage', 'ingest')
    .in('run_id', [...runIds])
  if (error) throw error
  const byRun = new Map<string, Json>()
  for (const row of data) byRun.set(row.run_id, row.output)
  return byRun
}

/**
 * Removes a document that could not be read.
 *
 * A failed run decided nothing, so there is nothing on the record worth keeping:
 * no verdict, no reason, no checks. The run and the invoice row both go, which is
 * what "remove" has to mean for the queue to be honest about it. The stage logs go
 * with the run, which cascades.
 */
export async function removeFailedRun(runId: string, invoiceId: string | null): Promise<void> {
  const { error: runError } = await supabase.from('runs').delete().eq('id', runId)
  if (runError) throw runError
  if (!invoiceId) return

  // Only when nothing else points at the document. A re-run that succeeded is
  // worth keeping, and so is the invoice it decided.
  const { data: remaining, error: countError } = await supabase.from('runs').select('id').eq('invoice_id', invoiceId)
  if (countError) throw countError
  if (remaining.length > 0) return

  const { error: invoiceError } = await supabase.from('invoices').delete().eq('id', invoiceId)
  if (invoiceError) throw invoiceError
}
