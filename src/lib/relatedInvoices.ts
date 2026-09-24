// The other invoices a decision is talking about.
//
// Three checks in the engine reach their conclusion by comparing this document
// with other documents: the near-duplicate check, the threshold-split check, and
// the cumulative total billed against an order. Each of them was reported to the
// reader as a finding with nothing behind it. Being told that "a recent invoice
// from this vendor has almost the same total" and not being shown which one, or
// what it was decided as, leaves the reader holding the whole judgement and none
// of the evidence.
//
// So a check that compares against other invoices shows those invoices. This
// resolves the invoice numbers a check recorded, and the siblings on an order,
// into rows a person can read and open.

import { getInvoices, getLatestRuns } from './queries.ts'
import { isApproved } from './runState.ts'
import { asRecord } from './format.ts'
import type { InvoiceRow, RunRow } from './database.types.ts'

/** One document and where it stands, which is its latest run. */
export interface LedgerEntry {
  invoice: InvoiceRow
  run: RunRow | null
}

export async function loadLedger(): Promise<LedgerEntry[]> {
  const [invoices, runs] = await Promise.all([getInvoices(), getLatestRuns()])
  const runByInvoice = new Map<string, RunRow>()
  for (const run of runs) {
    if (run.invoice_id && !runByInvoice.has(run.invoice_id)) runByInvoice.set(run.invoice_id, run)
  }
  return invoices.map((invoice) => ({ invoice, run: runByInvoice.get(invoice.id) ?? null }))
}

/** Another invoice, beside the one being decided. */
export interface RelatedInvoice {
  invoiceId: string
  runId: string | null
  // Carried whole so the outcome chip reads it the same way every list does,
  // including an invoice a person approved.
  run: RunRow | null
  invoiceNumber: string
  invoiceDate: string | null
  total: number | null
  currency: string
  /** The order it was decided against, or failing that the one it cites. */
  poNumber: string | null
  /** Approved, so its value is committed against the order it bills. */
  countsAgainstTheOrder: boolean
  /** Days between the two invoice dates, when both are readable. */
  gapDays: number | null
  /** How far its total sits from this invoice's, as an absolute amount. */
  amountDifference: number | null
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const from = new Date(a).getTime()
  const to = new Date(b).getTime()
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.round(Math.abs(to - from) / 86_400_000)
}

/** What this decision is comparing against: the invoice being decided. */
export interface Subject {
  invoiceId: string | null
  invoiceDate: string | null
  total: number | null
}

function toRelated(entry: LedgerEntry, subject: Subject): RelatedInvoice {
  const total = entry.invoice.total
  return {
    invoiceId: entry.invoice.id,
    runId: entry.run?.id ?? null,
    run: entry.run,
    invoiceNumber: entry.invoice.invoice_number,
    invoiceDate: entry.invoice.invoice_date,
    total,
    currency: entry.invoice.currency ?? 'INR',
    poNumber: entry.run?.matched_po ?? entry.invoice.po_reference,
    countsAgainstTheOrder: isApproved(entry.run),
    gapDays: daysApart(entry.invoice.invoice_date, subject.invoiceDate),
    amountDifference:
      typeof total === 'number' && typeof subject.total === 'number' ? Math.abs(total - subject.total) : null,
  }
}

/**
 * Every other invoice billed against one order.
 *
 * "Billed against" is the order the run matched, which is the order the invoice
 * was actually checked against. An invoice citing an order we could not match was
 * never measured against it.
 */
export function invoicesOnOrder(
  poNumber: string | null,
  ledger: readonly LedgerEntry[],
  subject: Subject,
): RelatedInvoice[] {
  if (!poNumber) return []
  const wanted = poNumber.trim().toLowerCase()
  return ledger
    .filter((entry) => entry.invoice.id !== subject.invoiceId)
    .filter((entry) => (entry.run?.matched_po ?? '').trim().toLowerCase() === wanted)
    .map((entry) => toRelated(entry, subject))
    .sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')))
}

/**
 * The invoices a cross-invoice check named, resolved into rows.
 *
 * A check records what it compared against as invoice numbers, dates and totals.
 * Invoice numbers repeat, so the date and the total break the tie: two records
 * under one number are two documents, and the one this check meant is the one
 * whose figures it recorded.
 */
export function namedInvoices(
  named: readonly Record<string, unknown>[],
  ledger: readonly LedgerEntry[],
  subject: Subject,
): RelatedInvoice[] {
  const rows: RelatedInvoice[] = []
  const taken = new Set<string>()

  for (const record of named) {
    const number = typeof record.invoice_number === 'string' ? record.invoice_number : null
    if (!number) continue
    const date = typeof record.invoice_date === 'string' ? record.invoice_date : null
    const total = typeof record.total === 'number' ? record.total : null

    const candidates = ledger.filter(
      (entry) => entry.invoice.invoice_number === number && entry.invoice.id !== subject.invoiceId,
    )
    const exact = candidates.find(
      (entry) =>
        (total === null || entry.invoice.total === total) &&
        (date === null || entry.invoice.invoice_date === date),
    )
    const entry = exact ?? candidates[0]
    if (!entry || taken.has(entry.invoice.id)) continue
    taken.add(entry.invoice.id)
    rows.push(toRelated(entry, subject))
  }

  return rows.sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')))
}

/**
 * The invoices a check listed, off its own evidence.
 *
 * `near_duplicate` records what it matched under `matches`; `threshold_split`
 * records the run of invoices it found under `invoices`. Both are read the same
 * way, and a check that passed has nothing to show.
 */
export function comparedInvoices(
  validations: Record<string, unknown> | null,
  check: string,
  key: string,
): Record<string, unknown>[] {
  const result = asRecord(validations?.[check])
  if (!result || result.passed !== false) return []
  const evidence = asRecord(result.evidence)
  const listed = evidence?.[key]
  if (!Array.isArray(listed)) return []
  return listed.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
}
