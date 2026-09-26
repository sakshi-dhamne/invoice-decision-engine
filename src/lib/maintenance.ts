// Clearing test data out, without taking the test corpus with it.
//
// Everything here is pure: what a document is, whether it may be deleted, what
// deleting a set of them would actually remove, and the order the removal has to
// happen in. The queries live in queries.ts and the screen in pages/Maintenance.tsx,
// so all of the judgement below can be tested with no database.
//
// Two facts about the schema drive the whole module, and both are in
// 001_schema.sql. `runs.invoice_id` references `invoices` with no cascade, so a run
// has to go before the invoice it decided. `runs.parent_run_id` references `runs`,
// also with no cascade, and that one is the trap: a resubmission's run points at
// the run of the invoice it corrects, and that earlier invoice may be one nobody
// selected. Deleting the selected runs then fails on a foreign key, which is
// exactly what happened when this was first attempted by hand in SQL.

import type { InvoiceRow, RunRow, Verdict } from './database.types.ts'
import { effectiveVerdict, latestRunPerInvoice } from './runState.ts'

// ---------------------------------------------------------------------------
// Where a document came from
// ---------------------------------------------------------------------------

export type InvoiceOrigin = 'seeded' | 'uploaded'

/**
 * How this document arrived.
 *
 * `storage_path` is set by the upload flow and by nothing else, which is the same
 * test `wasUploaded` in feed.ts already makes. A document with none was seeded from
 * fixtures/invoices.json by 002_seed.sql.
 *
 * The test is deliberately this way round rather than matching a list of fixture
 * names. A row nobody can account for reads as seeded and is therefore protected,
 * which is the safe way for this to be wrong.
 */
export function originOf(invoice: Pick<InvoiceRow, 'storage_path'>): InvoiceOrigin {
  return (invoice.storage_path?.trim().length ?? 0) > 0 ? 'uploaded' : 'seeded'
}

/**
 * Whether this document may be deleted.
 *
 * Only an uploaded one. The seeded corpus is what the 27 of 27 assertion is made
 * against and what the demo runs on, so losing one of those invoices costs more
 * than every uploaded document put together. The database refuses these too, in
 * 013_maintenance_delete.sql, so the guard holds even if this screen is bypassed.
 */
export function canDelete(invoice: Pick<InvoiceRow, 'storage_path'>): boolean {
  return originOf(invoice) === 'uploaded'
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

export interface MaintenanceRow {
  invoice: InvoiceRow
  origin: InvoiceOrigin
  /** Part of the test corpus, so it cannot be selected and shows a lock. */
  locked: boolean
  /** The run whose outcome the row shows, which is the latest of them. */
  latestRun: RunRow | null
  /** Every run of this document, because all of them go when it does. */
  runIds: readonly string[]
  /** What the outcome column reads, once a person has been taken into account. */
  outcome: Verdict | null
  /** True when no run of this document ever reached a verdict. */
  neverDecided: boolean
}

export interface InventoryInput {
  invoices: readonly InvoiceRow[]
  /** Every run, not just the latest one: deleting a document deletes all of them. */
  runs: readonly RunRow[]
  /** How many stage logs each run carries, tallied by the caller. */
  stageLogCounts: ReadonlyMap<string, number>
}

export function buildInventory(input: InventoryInput): MaintenanceRow[] {
  const runsByInvoice = new Map<string, RunRow[]>()
  for (const run of input.runs) {
    if (!run.invoice_id) continue
    const existing = runsByInvoice.get(run.invoice_id)
    if (existing) existing.push(run)
    else runsByInvoice.set(run.invoice_id, [run])
  }

  return input.invoices.map((invoice): MaintenanceRow => {
    const runs = runsByInvoice.get(invoice.id) ?? []
    // The query returns runs newest first, which is what this selection assumes.
    const latestRun = latestRunPerInvoice(runs)[0] ?? null
    return {
      invoice,
      origin: originOf(invoice),
      locked: !canDelete(invoice),
      latestRun,
      runIds: runs.map((run) => run.id),
      outcome: latestRun ? effectiveVerdict(latestRun) : null,
      // A verdict on any run counts. A document read once and re-read after its
      // vendor was onboarded has a failed first run and a decided second one, and
      // that document was decided.
      neverDecided: runs.every((run) => run.verdict === null),
    }
  })
}

/** How many stage logs a set of runs carries, for the confirmation panel. */
export function stageLogsFor(runIds: readonly string[], counts: ReadonlyMap<string, number>): number {
  return runIds.reduce((total, runId) => total + (counts.get(runId) ?? 0), 0)
}

// ---------------------------------------------------------------------------
// What a deletion would take with it
// ---------------------------------------------------------------------------

/**
 * An invoice that is staying, whose run points at a run that is going.
 *
 * This is the case worth stopping a person over. The link is the trail between a
 * resubmission and the invoice it corrects, and deleting one half of it leaves the
 * surviving invoice with nothing to point back at. The deletion detaches the link
 * rather than failing on it, so the invoice survives intact; what it loses is the
 * record that there was an earlier attempt.
 */
export interface OrphanedLink {
  invoiceNumber: string
  /** How many of this invoice's runs lose their link. */
  links: number
}

export interface DeletionImpact {
  invoices: number
  runs: number
  stageLogs: number
  /** Runs whose parent link has to be detached first, wherever they belong. */
  detachedLinks: number
  /** Only the ones belonging to invoices that are not being deleted. */
  orphaned: OrphanedLink[]
  /** Selected rows the rules refuse, which should always be none. */
  refused: number
}

export interface ImpactInput {
  rows: readonly MaintenanceRow[]
  runs: readonly RunRow[]
  stageLogCounts: ReadonlyMap<string, number>
  selected: ReadonlySet<string>
}

/**
 * Exactly what is about to go, counted before anything does.
 *
 * Takes the whole run set rather than the selected rows' runs, because the
 * question this has to answer is about the runs of invoices nobody selected.
 */
export function deletionImpact(input: ImpactInput): DeletionImpact {
  const selectedRows = input.rows.filter((row) => input.selected.has(row.invoice.id))
  const deletable = selectedRows.filter((row) => !row.locked)

  const doomedRunIds = new Set(deletable.flatMap((row) => [...row.runIds]))
  const invoiceNumbers = new Map(input.rows.map((row) => [row.invoice.id, row.invoice.invoice_number]))

  // Every run pointing at a run that is about to go. The ones belonging to a
  // selected invoice are going themselves, so only the rest are worth naming.
  const orphanedByInvoice = new Map<string, number>()
  let detachedLinks = 0
  for (const run of input.runs) {
    if (!run.parent_run_id || !doomedRunIds.has(run.parent_run_id)) continue
    detachedLinks += 1
    if (doomedRunIds.has(run.id)) continue
    const number = run.invoice_id ? invoiceNumbers.get(run.invoice_id) : undefined
    if (!number) continue
    orphanedByInvoice.set(number, (orphanedByInvoice.get(number) ?? 0) + 1)
  }

  return {
    invoices: deletable.length,
    runs: doomedRunIds.size,
    stageLogs: stageLogsFor([...doomedRunIds], input.stageLogCounts),
    detachedLinks,
    orphaned: [...orphanedByInvoice.entries()]
      .map(([invoiceNumber, links]) => ({ invoiceNumber, links }))
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
    refused: selectedRows.length - deletable.length,
  }
}

/**
 * The ids a deletion may actually be asked to remove.
 *
 * The screen cannot select a locked row, and the database refuses one anyway, so
 * this is the third guard rather than the only one. It exists because the panel
 * counts the deletable subset and the button should send exactly what the panel
 * counted: sending a locked id would have the database refuse the whole batch and
 * report a failure for something the person was never shown.
 */
export function deletableIds(rows: readonly MaintenanceRow[], selected: ReadonlySet<string>): string[] {
  return rows.filter((row) => selected.has(row.invoice.id) && !row.locked).map((row) => row.invoice.id)
}

/** The storage objects to remove, once the records are gone. */
export function storagePathsFor(rows: readonly MaintenanceRow[], selected: ReadonlySet<string>): string[] {
  return rows
    .filter((row) => selected.has(row.invoice.id) && !row.locked)
    .map((row) => row.invoice.storage_path)
    .filter((path): path is string => (path?.trim().length ?? 0) > 0)
}

// ---------------------------------------------------------------------------
// The bulk of the clutter
// ---------------------------------------------------------------------------

/**
 * Uploaded documents that never reached a verdict.
 *
 * A run that failed decided nothing: no verdict, no reason codes, no checks. There
 * is nothing on the record worth keeping and these accumulate faster than anything
 * else, so they get one action of their own. A document with no run at all counts:
 * it was uploaded and then nothing happened to it.
 */
export function failedUploadIds(rows: readonly MaintenanceRow[]): string[] {
  return rows.filter((row) => !row.locked && row.neverDecided).map((row) => row.invoice.id)
}

// ---------------------------------------------------------------------------
// The order, which is the whole point
// ---------------------------------------------------------------------------

export type DeletionStep = 'detach' | 'runs' | 'invoices' | 'files'

/**
 * The only order in which this does not fail on a foreign key.
 *
 * `detach` first, because a run that is staying may point at one that is going.
 * `runs` before `invoices`, because `runs.invoice_id` has no cascade. Stage logs
 * need no step of their own: `stage_logs.run_id` cascades, and so do extractions
 * on `invoices.id`. `files` last, because storage is not part of the transaction
 * and a file with no record is a smaller problem than a record with no file.
 *
 * tests/maintenance.spec.ts checks this against the foreign keys declared in
 * 001_schema.sql rather than against a copy of this list.
 */
export const DELETION_ORDER: readonly DeletionStep[] = ['detach', 'runs', 'invoices', 'files']

/**
 * What each step is called, in the database and on the screen alike.
 *
 * 013_maintenance_delete.sql puts these exact phrases in the error it raises, so a
 * failure can be attributed to a step rather than reported as a bare message. One
 * table rather than two, because a wire phrase and a label that have to match are
 * better off unable to drift. tests/maintenance.spec.ts checks the SQL still uses
 * them.
 */
export const STEP_PHRASE: Readonly<Record<DeletionStep, string>> = {
  detach: 'detaching the links to earlier attempts',
  runs: 'deleting the runs',
  invoices: 'deleting the invoices',
  files: 'deleting the stored files',
}

/**
 * Which step a database error came from.
 *
 * Falls back to the first step that touches data. A failure we cannot place is
 * still a failure before anything was deleted, because the transaction rolls back
 * either way, and naming the earliest step is the reading that claims the least.
 */
export function stepFromMessage(message: string): DeletionStep {
  for (const step of DELETION_ORDER) {
    if (message.includes(STEP_PHRASE[step])) return step
  }
  return 'detach'
}

// ---------------------------------------------------------------------------
// Sorting and filtering, as the other lists do it
// ---------------------------------------------------------------------------

export type MaintenanceSortKey = 'invoice' | 'vendor' | 'file' | 'origin' | 'outcome' | 'received'
export type MaintenanceOriginFilter = 'all' | InvoiceOrigin
export type MaintenanceOutcomeFilter = 'all' | 'undecided' | Verdict

export function vendorAsPrinted(row: MaintenanceRow): string {
  return row.invoice.vendor_name_as_printed ?? 'Not read'
}

export function filePathOf(row: MaintenanceRow): string {
  return row.invoice.storage_path ?? row.invoice.file_path ?? 'No file recorded'
}

export function matchesMaintenanceSearch(row: MaintenanceRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return [row.invoice.invoice_number, vendorAsPrinted(row), filePathOf(row)].some((value) =>
    value.toLowerCase().includes(needle),
  )
}

export function matchesOrigin(row: MaintenanceRow, filter: MaintenanceOriginFilter): boolean {
  return filter === 'all' || row.origin === filter
}

export function matchesOutcome(row: MaintenanceRow, filter: MaintenanceOutcomeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'undecided') return row.neverDecided
  return row.outcome === filter
}

export function sortMaintenanceRows(
  rows: readonly MaintenanceRow[],
  key: MaintenanceSortKey,
  direction: 'asc' | 'desc',
): MaintenanceRow[] {
  const sign = direction === 'asc' ? 1 : -1
  const value = (row: MaintenanceRow): string => {
    switch (key) {
      case 'invoice':
        return row.invoice.invoice_number
      case 'vendor':
        return vendorAsPrinted(row)
      case 'file':
        return filePathOf(row)
      case 'origin':
        return row.origin
      case 'outcome':
        return String(row.outcome ?? '')
      case 'received':
        return row.invoice.created_at
    }
  }
  return [...rows].sort((a, b) => value(a).localeCompare(value(b)) * sign)
}
