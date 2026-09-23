// What every list in the product reads: the latest run for each invoice, joined to
// the document it decided and the vendor it resolved to.
//
// A row is identified by its run, never by its invoice number. Invoice numbers are
// not unique and never were: a resubmission carries the same number as the document
// it corrects, and so does every copy of a file somebody forwards twice. Keying a
// list on the number made two records highlight together and left the second one
// impossible to open.

import { getIngestOutputs, getInvoices, getLatestRuns, getVendors } from './queries.ts'
import { asRecord } from './decisionData.ts'
import type { InvoiceRow, RunRow, StageLogRow, VendorRow, Verdict } from './database.types.ts'

export interface DuplicateOf {
  invoiceNumber: string
  runId: string | null
  decidedAt: string | null
}

export interface FeedRow {
  run: RunRow
  invoice: InvoiceRow | null
  vendor: VendorRow | null
  primaryCode: string | null
  // Set when this run blocked the document for repeating one we had already been
  // through. Carries what the row and the detail pane need to say so.
  duplicateOf: DuplicateOf | null
}

export interface Feed {
  rows: FeedRow[]
  invoices: InvoiceRow[]
  vendors: VendorRow[]
}

/**
 * The most recent run of each invoice record.
 *
 * Keyed on the invoice record, not on the invoice number. An invoice re-run after
 * its vendor was onboarded has two runs, and the queue showed both: `INV-ZTR-0001`
 * appeared as Held and as Blocked at once, which is two answers to one question.
 * Only the latest is where the document stands now; the earlier ones are its
 * History.
 *
 * Two separate records that happen to share an invoice number each keep their own
 * latest run, and that is deliberate. An uploaded copy of a document is a
 * different record from the original, both are real, and collapsing them on the
 * number would hide the copy that was blocked behind the original that was not.
 *
 * Takes runs already ordered newest first, which is how the query returns them.
 */
export function latestRunPerInvoice(runs: readonly RunRow[]): RunRow[] {
  const seen = new Set<string>()
  const latest: RunRow[] = []
  for (const run of runs) {
    const record = run.invoice_id ?? run.id
    if (seen.has(record)) continue
    seen.add(record)
    latest.push(run)
  }
  return latest
}

/** The stable identity of a row. Short enough for a URL, long enough to be unique. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}

/**
 * The row a URL is pointing at.
 *
 * Matches on the run, by the short form the URL carries. Returns null rather than
 * guessing when more than one row matches, which can only happen if the short form
 * ever collides.
 */
export function rowForShortId(rows: readonly FeedRow[], shortId: string | null): FeedRow | null {
  if (!shortId) return null
  const matches = rows.filter((row) => row.run.id.startsWith(shortId))
  return matches.length === 1 ? matches[0] : null
}

export async function loadFeed(): Promise<Feed> {
  const [runs, invoices, vendors] = await Promise.all([getLatestRuns(), getInvoices(), getVendors()])

  const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const vendorsById = new Map(vendors.map((vendor) => [vendor.id, vendor]))

  // Only a duplicate needs its ingest output, and it is the one row that cannot
  // explain itself without it.
  const duplicateRunIds = runs
    .filter((run) => (run.reason_codes ?? []).includes('EXACT_DUPLICATE'))
    .map((run) => run.id)
  const ingestByRun = await getIngestOutputs(duplicateRunIds).catch(() => new Map())

  const rows = runs.map((run): FeedRow => {
    const invoice = run.invoice_id ? (invoicesById.get(run.invoice_id) ?? null) : null
    return {
      run,
      invoice,
      vendor: invoice?.vendor_id ? (vendorsById.get(invoice.vendor_id) ?? null) : null,
      // The rules engine puts the code that selected the verdict first.
      primaryCode: run.reason_codes?.[0] ?? null,
      duplicateOf: duplicateFromIngest(ingestByRun.get(run.id) ?? null),
    }
  })

  return { rows, invoices, vendors }
}

/**
 * What a duplicate repeats, read from the stage log that found it.
 *
 * Stage 1 records this when it stops a run, so it is available without reading the
 * document. The reason code alone cannot say which invoice was repeated.
 */
export function duplicateFromStages(stages: readonly StageLogRow[]): DuplicateOf | null {
  return duplicateFromIngest(stages.find((stage) => stage.stage === 'ingest')?.output ?? null)
}

export function duplicateFromIngest(output: unknown): DuplicateOf | null {
  const ingest = asRecord(output)
  const number = ingest?.duplicate_of
  if (typeof number !== 'string' || number.length === 0) return null
  return {
    invoiceNumber: number,
    runId: typeof ingest?.prior_run_id === 'string' ? ingest.prior_run_id : null,
    decidedAt: typeof ingest?.prior_decided_at === 'string' ? ingest.prior_decided_at : null,
  }
}

export function isDuplicate(row: FeedRow): boolean {
  return (row.run.reason_codes ?? []).includes('EXACT_DUPLICATE')
}

/**
 * Whether this document was put in by hand rather than seeded.
 *
 * `storage_path` is set only by the upload flow, so it is the whole test. This is
 * metadata about how a document arrived, not a kind of invoice: an uploaded
 * document is checked by the same rules, appears in the same list and carries the
 * same verdicts. It is worth being able to filter on because somebody who has just
 * uploaded a stack of documents wants to find them again.
 */
export function wasUploaded(row: FeedRow): boolean {
  return Boolean(row.invoice?.storage_path)
}

export function hasFailed(run: RunRow): boolean {
  return run.status === 'failed'
}

export function wasDiscarded(run: RunRow): boolean {
  return run.discarded_at !== null
}

// The three verdicts that put a document in front of a person.
export const NEEDS_A_PERSON: readonly Verdict[] = ['REVIEW', 'HOLD', 'BLOCK']

/**
 * Whether this row is an open exception.
 *
 * An exception is a decision that needs a person. A run that failed outright is
 * not one: nothing was decided about it, there is no verdict to agree or disagree
 * with, and nothing on the queue's screen applies to it. Those belong on Invoices
 * under the Failed filter, where the document can be removed and sent again. A run
 * somebody has already discarded is not an exception either.
 */
export function needsAPerson(run: RunRow): boolean {
  if (wasDiscarded(run) || hasFailed(run)) return false
  return run.status === 'complete' && run.verdict !== null && NEEDS_A_PERSON.includes(run.verdict)
}

export function countByVerdict(rows: FeedRow[]): Partial<Record<Verdict, number>> {
  const counts: Partial<Record<Verdict, number>> = {}
  for (const row of rows) {
    if (!row.run.verdict) continue
    counts[row.run.verdict] = (counts[row.run.verdict] ?? 0) + 1
  }
  return counts
}

// The name to show for a document: the vendor we resolved it to, or failing that
// the name printed on the page.
export function vendorNameFor(row: FeedRow): string {
  return row.vendor?.legal_name ?? row.invoice?.vendor_name_as_printed ?? 'Not identified'
}

export function matchesSearch(row: FeedRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  const haystack = [
    row.invoice?.invoice_number,
    row.invoice?.po_reference,
    vendorNameFor(row),
    row.run.verdict,
    ...(row.run.reason_codes ?? []),
  ]
  return haystack.some((value) => String(value ?? '').toLowerCase().includes(needle))
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey = 'age' | 'amount' | 'invoice' | 'vendor' | 'outcome' | 'date'
export type SortDirection = 'asc' | 'desc'

export function sortRows(rows: FeedRow[], key: SortKey, direction: SortDirection): FeedRow[] {
  const sign = direction === 'asc' ? 1 : -1

  const value = (row: FeedRow): string | number => {
    switch (key) {
      case 'amount':
        return row.invoice?.total ?? 0
      case 'age':
        return new Date(row.run.started_at).getTime()
      case 'invoice':
        return String(row.invoice?.invoice_number ?? '')
      case 'vendor':
        return vendorNameFor(row)
      case 'outcome':
        return String(row.run.verdict ?? '')
      case 'date':
        return String(row.invoice?.invoice_date ?? '')
    }
  }

  return [...rows].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign
    return String(left).localeCompare(String(right)) * sign
  })
}
