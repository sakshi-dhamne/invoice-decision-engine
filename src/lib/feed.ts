// What the queue and the dashboard both need: the latest run for each invoice,
// joined to the document it decided and the vendor it resolved to.

import { getInvoices, getLatestRuns, getVendors } from './queries.ts'
import type { InvoiceRow, RunRow, VendorRow, Verdict } from './database.types.ts'

export interface FeedRow {
  run: RunRow
  invoice: InvoiceRow | null
  vendor: VendorRow | null
  primaryCode: string | null
}

export interface Feed {
  rows: FeedRow[]
  invoices: InvoiceRow[]
  vendors: VendorRow[]
}

export async function loadFeed(): Promise<Feed> {
  const [runs, invoices, vendors] = await Promise.all([getLatestRuns(), getInvoices(), getVendors()])

  const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const vendorsById = new Map(vendors.map((vendor) => [vendor.id, vendor]))

  const rows = runs.map((run): FeedRow => {
    const invoice = run.invoice_id ? (invoicesById.get(run.invoice_id) ?? null) : null
    return {
      run,
      invoice,
      vendor: invoice?.vendor_id ? (vendorsById.get(invoice.vendor_id) ?? null) : null,
      // The rules engine puts the code that selected the verdict first.
      primaryCode: run.reason_codes?.[0] ?? null,
    }
  })

  return { rows, invoices, vendors }
}

// The three verdicts that put a document in front of a person.
export const NEEDS_A_PERSON: readonly Verdict[] = ['REVIEW', 'HOLD', 'BLOCK']

export function needsAPerson(run: RunRow): boolean {
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
