// One purchase order: what it authorised, and everything billed against it.
//
// The list of invoices is the point. An order's remaining balance is a number; the
// invoices that took it there are what a person can actually check.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  LabelValueGrid,
  Loading,
  OutcomeChip,
  PageBody,
  Panel,
  PanelHeading,
} from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { count, money, shortDate } from '@/lib/format.ts'
import {
  COUNTS_AGAINST_ORDER_LABEL,
  NOT_COUNTING_LABEL,
  ORDER_INVOICES_EMPTY,
  ORDER_INVOICES_LABEL,
  ORDER_NOT_FOUND,
} from '@/lib/reasonCopy.ts'
import { loadOrders, orderStatusLabel, type OrderSummary } from '@/lib/orders.ts'
import { invoicesOnOrder, type LedgerEntry, type RelatedInvoice } from '@/lib/relatedInvoices.ts'
import type { OrderLine } from '@/lib/decisionData.ts'

export default function OrderDetail() {
  const { poNumber } = useParams<{ poNumber: string }>()
  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (!poNumber) return
    try {
      const data = await loadOrders()
      setSummary(data.orders.find((row) => row.order.po_number === poNumber) ?? null)
      setLedger(data.ledger)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This order could not be loaded.')
    } finally {
      setLoaded(true)
    }
  }, [poNumber])

  useEffect(() => {
    void load()
  }, [load])

  const billed: RelatedInvoice[] = useMemo(
    () =>
      summary && ledger
        ? invoicesOnOrder(summary.order.po_number, ledger, { invoiceId: null, invoiceDate: null, total: null })
        : [],
    [summary, ledger],
  )

  const lines: OrderLine[] = Array.isArray(summary?.order.line_items)
    ? (summary.order.line_items as OrderLine[])
    : []

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <Link to="/orders" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the orders
          </Link>

          {error ? <ErrorNote title="This order could not be shown">{error}</ErrorNote> : null}

          {!loaded ? (
            <Loading>Loading the order</Loading>
          ) : !summary ? (
            <Panel>
              <EmptyState action={<Link to="/orders" className="text-sm text-ink underline underline-offset-4">Back to the orders</Link>}>
                {ORDER_NOT_FOUND}
              </EmptyState>
            </Panel>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="identifier text-2xl font-semibold text-ink">{summary.order.po_number}</h1>
                <span className="text-sm text-muted">{summary.vendor?.legal_name ?? 'Not identified'}</span>
              </div>

              <Panel className="px-5 py-4">
                <LabelValueGrid
                  columns={2}
                  fields={[
                    { label: 'Order value', value: money(summary.order.total_amount, summary.order.currency) },
                    { label: 'Billed to date', value: money(summary.billedToDate, summary.order.currency) },
                    { label: 'Remaining', value: money(summary.remaining, summary.order.currency) },
                    { label: 'Status', value: orderStatusLabel(summary.order.status) },
                    { label: 'Raised', value: shortDate(summary.order.issued_date) },
                    {
                      label: 'Figures include tax',
                      value: summary.order.tax_treatment === 'inclusive' ? 'Yes' : 'No',
                    },
                  ]}
                />
              </Panel>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
                <Panel>
                  <PanelHeading right={<span className="text-xs text-muted tnum">{count(billed.length)}</span>}>
                    {ORDER_INVOICES_LABEL}
                  </PanelHeading>
                  {billed.length === 0 ? (
                    <EmptyState>{ORDER_INVOICES_EMPTY}</EmptyState>
                  ) : (
                    <ul className="divide-y divide-line-soft">
                      {billed.map((row) => (
                        <li key={row.invoiceId}>
                          {row.runId ? (
                            <Link
                              to={`/decisions/${row.runId}`}
                              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3.5 transition-colors hover:bg-line-soft/60"
                            >
                              <InvoiceRowBody row={row} />
                            </Link>
                          ) : (
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3.5">
                              <InvoiceRowBody row={row} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel>
                  <PanelHeading>Lines on the order</PanelHeading>
                  {lines.length === 0 ? (
                    <EmptyState>This order states no lines.</EmptyState>
                  ) : (
                    <ul className="divide-y divide-line-soft">
                      {lines.map((line, index) => (
                        <li key={index} className="flex items-baseline justify-between gap-4 px-5 py-3">
                          <span className="min-w-0 text-sm text-ink-soft">{line.description ?? 'No description'}</span>
                          <span className="shrink-0 text-sm text-ink tnum">
                            {money(line.amount ?? null, summary.order.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            </>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}

function InvoiceRowBody({ row }: { row: RelatedInvoice }) {
  return (
    <>
      {row.run ? <OutcomeChip run={row.run} size="sm" /> : null}
      <span className="identifier text-sm text-ink">{row.invoiceNumber}</span>
      <span className="text-sm text-muted">{shortDate(row.invoiceDate)}</span>
      <span className={cn('text-xs', row.countsAgainstTheOrder ? tone('approve').text : 'text-muted')}>
        {row.countsAgainstTheOrder ? COUNTS_AGAINST_ORDER_LABEL : NOT_COUNTING_LABEL}
      </span>
      <span className="ml-auto text-sm text-ink tnum">{money(row.total, row.currency)}</span>
    </>
  )
}
