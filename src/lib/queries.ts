import { supabase } from './supabase.ts'
import { latestRunPerInvoice } from './runState.ts'
import { stepFromMessage, type DeletionStep } from './maintenance.ts'
import { UPLOAD_BUCKET } from './uploads.ts'
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

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export interface MaintenanceInventory {
  invoices: InvoiceRow[]
  /** Every run, not the latest per invoice: all of them go when a document does. */
  runs: RunRow[]
  /** How many stage logs each run carries, so the count is not a guess. */
  stageLogCounts: Map<string, number>
}

// Supabase caps a select at 1000 rows by default, and a count the confirmation
// panel understates is worse than no count at all. Stage logs are the one table
// here that can run past it, so that read is paged.
const PAGE_SIZE = 1000

async function countStageLogsByRun(): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('stage_logs')
      .select('run_id')
      .order('run_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    for (const row of data) counts.set(row.run_id, (counts.get(row.run_id) ?? 0) + 1)
    if (data.length < PAGE_SIZE) return counts
  }
}

/**
 * Everything the maintenance screen has to show, and everything it has to count.
 *
 * Runs are ordered newest first, which is what buildInventory assumes when it picks
 * the run whose outcome a row shows.
 */
export async function getMaintenanceInventory(): Promise<MaintenanceInventory> {
  const [invoices, runs, stageLogCounts] = await Promise.all([
    getInvoices(),
    getRuns(),
    countStageLogsByRun(),
  ])
  return { invoices, runs, stageLogCounts }
}

export interface DeletionReport {
  invoices: number
  runs: number
  stageLogs: number
  extractions: number
  detachedLinks: number
  files: number
  /**
   * Set when the records went and the files did not.
   *
   * Storage is not part of the database transaction, so this is the one outcome
   * that cannot be made all-or-nothing. It is reported rather than thrown, because
   * the records really are gone and saying otherwise would be wrong.
   */
  filesError: string | null
}

export type DeletionOutcome =
  | { ok: true; report: DeletionReport }
  | { ok: false; step: DeletionStep; detail: string; missingFunction: boolean }

function numberFrom(value: Json | null, key: string): number {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const found = record?.[key]
  return typeof found === 'number' ? found : 0
}

/**
 * Deletes a set of uploaded invoices, in the only order the foreign keys allow.
 *
 * Steps 1 to 3 are one call to `delete_invoices_cascade`, which does them inside a
 * single transaction: detach the runs pointing at runs that are going, delete the
 * runs, delete the invoices. Stage logs and extractions cascade. If any of it
 * fails, all of it rolls back and this reports which step stopped it, so a
 * half-deleted set is not a state this can leave behind.
 *
 * Step 4, the stored files, happens afterwards because storage is not in the
 * transaction. Records first is deliberate: a file nothing points at is clutter,
 * whereas an invoice whose document has been deleted is a broken record.
 */
export async function deleteInvoicesAndFiles(
  invoiceIds: readonly string[],
  storagePaths: readonly string[],
): Promise<DeletionOutcome> {
  if (invoiceIds.length === 0) {
    return {
      ok: true,
      report: { invoices: 0, runs: 0, stageLogs: 0, extractions: 0, detachedLinks: 0, files: 0, filesError: null },
    }
  }

  const { data, error } = await supabase.rpc('delete_invoices_cascade', { invoice_ids: [...invoiceIds] })

  if (error) {
    // A project that has not had 013_maintenance_delete.sql applied answers that
    // the function does not exist, which is a different problem from a failure
    // inside it and has a different thing to do about it.
    const missingFunction = /could not find the function|does not exist|PGRST202/i.test(
      `${error.message} ${error.code ?? ''}`,
    )
    return { ok: false, step: stepFromMessage(error.message), detail: error.message, missingFunction }
  }

  const report: DeletionReport = {
    invoices: numberFrom(data, 'invoices'),
    runs: numberFrom(data, 'runs'),
    stageLogs: numberFrom(data, 'stage_logs'),
    extractions: numberFrom(data, 'extractions'),
    detachedLinks: numberFrom(data, 'detached_links'),
    files: 0,
    filesError: null,
  }

  if (storagePaths.length === 0) return { ok: true, report }

  const { error: storageError } = await supabase.storage.from(UPLOAD_BUCKET).remove([...storagePaths])
  if (storageError) return { ok: true, report: { ...report, filesError: storageError.message } }

  return { ok: true, report: { ...report, files: storagePaths.length } }
}
