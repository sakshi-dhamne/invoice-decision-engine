// The decision, and everything a person needs to act on it.
//
// Nothing here recomputes a verdict. The run holds what the rules decided and the
// stage log holds the evidence they decided it on, so this page reads and lays
// out. The override is recorded alongside the verdict, never over it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  LabelValueGrid,
  Loading,
  Panel,
  PanelHeading,
  ReasonCodes,
  Spinner,
  VerdictChip,
  type Field,
} from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dateAndTime, evidenceValue, humanKey, money, shortDate } from '@/lib/format.ts'
import { verdictTone } from '@/lib/reasonCopy.ts'
import { getInvoiceById, getPurchaseOrders, getRunById, getStageLogs, recordOverride } from '@/lib/queries.ts'
import { REASON_CODE_FIELDS } from '@/rules/validate.ts'
import type { FieldChange } from '@/rules/validate.ts'
import type { ReasonCode } from '@/rules/types.ts'
import type { InvoiceRow, PurchaseOrderRow, RunRow, StageLogRow } from '@/lib/database.types.ts'

interface OrderLine {
  description?: string | null
  quantity?: number | null
  unit_price?: number | null
  amount?: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export default function Decision() {
  const { id = '' } = useParams()
  const [run, setRun] = useState<RunRow | null>(null)
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null)
  const [logs, setLogs] = useState<StageLogRow[]>([])
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [overriding, setOverriding] = useState(false)

  const load = useCallback(async () => {
    try {
      const fresh = await getRunById(id)
      if (!fresh) {
        setError('That decision does not exist. Go back to the queue and open it again.')
        setLoaded(true)
        return
      }
      const [stages, allOrders, doc] = await Promise.all([
        getStageLogs(id),
        getPurchaseOrders(),
        fresh.invoice_id ? getInvoiceById(fresh.invoice_id) : Promise.resolve(null),
      ])
      setRun(fresh)
      setLogs(stages)
      setOrders(allOrders)
      setInvoice(doc)
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The decision could not be loaded.')
      setLoaded(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const codes = useMemo(() => run?.reason_codes ?? [], [run])
  const toneName = verdictTone(run?.verdict)
  const classes = tone(toneName)

  // Which extracted fields the failing checks point at, so they can be marked.
  const flaggedFields = useMemo(() => {
    const fields = new Set<string>()
    for (const code of codes) {
      for (const field of REASON_CODE_FIELDS[code as ReasonCode] ?? []) fields.add(field)
    }
    return fields
  }, [codes])

  const extraction = useMemo(() => asRecord(logs.find((log) => log.stage === 'extract')?.output), [logs])

  const invoiceFields: Field[] = useMemo(() => {
    if (!extraction) return []
    const text = (key: string) => (typeof extraction[key] === 'string' ? (extraction[key] as string) : 'Not read')
    const num = (key: string) => (typeof extraction[key] === 'number' ? (extraction[key] as number) : null)
    return [
      { label: 'Invoice number', value: text('invoice_number'), mono: true, flagged: flaggedFields.has('invoice_number') },
      { label: 'Invoice date', value: shortDate(text('invoice_date')), flagged: flaggedFields.has('invoice_date') },
      { label: 'Vendor as printed', value: text('vendor_name'), flagged: flaggedFields.has('vendor_name') },
      { label: 'Order cited', value: text('po_reference'), mono: true, flagged: flaggedFields.has('po_reference') },
      { label: 'Currency', value: text('currency'), flagged: flaggedFields.has('currency') },
      { label: 'Subtotal', value: money(num('subtotal')), flagged: flaggedFields.has('subtotal') },
      { label: 'Tax', value: money(num('tax')), flagged: flaggedFields.has('tax') },
      { label: 'Total', value: money(num('total')), flagged: flaggedFields.has('total') },
      { label: 'Bank account', value: text('bank_account'), mono: true, flagged: flaggedFields.has('bank_account') },
      { label: 'Pay to', value: text('remit_to_name'), flagged: flaggedFields.has('remit_to_name') },
    ]
  }, [extraction, flaggedFields])

  const changes = (run?.changed_fields as unknown as FieldChange[] | null) ?? null
  const isResubmission = Array.isArray(changes) && changes.length > 0

  const order = orders.find((candidate) => candidate.po_number === run?.matched_po) ?? null
  const orderLines: OrderLine[] = Array.isArray(order?.line_items) ? (order.line_items as OrderLine[]) : []

  // The order's arithmetic, laid out the way an approver checks it.
  const invoiceTotal = typeof extraction?.total === 'number' ? (extraction.total as number) : (invoice?.total ?? null)
  const orderValue = order?.total_amount ?? null
  const billed = order?.amount_billed_to_date ?? 0
  const overage =
    orderValue != null && invoiceTotal != null ? Math.max(0, billed + invoiceTotal - orderValue) : null

  // The tolerance the rules allowed, taken from the check that reported it rather
  // than recalculated here.
  const validateOutput = useMemo(() => asRecord(logs.find((log) => log.stage === 'validate')?.output), [logs])
  const overageCheck = asRecord(validateOutput?.cumulative_overage)
  const overageEvidence = asRecord(overageCheck?.evidence)
  const allowance = typeof overageEvidence?.allowance === 'number' ? (overageEvidence.allowance as number) : null

  const unmatchedLines = useMemo(() => {
    const coverage = asRecord(asRecord(validateOutput?.line_coverage)?.evidence)
    const unmatched = coverage?.unmapped_invoice_lines
    return Array.isArray(unmatched) ? (unmatched as Record<string, unknown>[]) : []
  }, [validateOutput])

  const override = async () => {
    if (!run) return
    setOverriding(true)
    try {
      // In a deployment with sign-in this is the signed-in person. Until then the
      // trail records that the override came from this browser, not from a name we
      // have invented for it.
      const updated = await recordOverride(run.id, 'Approved at this workstation')
      setRun(updated)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The override could not be saved.')
    } finally {
      setOverriding(false)
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the queue
          </Link>

          {run ? (
            <div className="flex items-center gap-3">
              <Button asChild variant="outline">
                <Link to={`/runs/${run.id}`}>See how it ran</Link>
              </Button>
              <Button type="button" variant="outline">
                Ask the vendor
              </Button>
              <Button type="button" onClick={override} disabled={overriding || run.touched_by_human} className="gap-2">
                {overriding ? <Spinner className="border-t-primary-foreground" /> : null}
                {run.touched_by_human ? 'Approved by a person' : 'Override and approve'}
              </Button>
            </div>
          ) : null}
        </div>

        {error ? <ErrorNote title="This decision could not be shown">{error}</ErrorNote> : null}

        {!loaded ? (
          <Panel>
            <Loading>Loading the decision</Loading>
          </Panel>
        ) : run ? (
          <>
            <Panel className={cn('border-l-4 px-6 py-6', classes.border)}>
              <div className="flex flex-wrap items-center gap-4">
                <VerdictChip verdict={run.verdict} size="lg" />
                <h1 className="identifier text-lg font-medium text-ink">
                  {invoice?.invoice_number ?? 'This invoice'}
                </h1>
                {run.touched_by_human ? (
                  <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
                    A person approved this after the checks ran
                  </span>
                ) : null}
              </div>

              <p className="prose-serif mt-5 max-w-[72ch] text-[17px] text-ink-soft">
                {run.explanation ?? 'No explanation was recorded for this run.'}
              </p>

              <div className="mt-5 flex flex-wrap gap-1.5">
                {codes.map((code) => (
                  <span
                    key={code}
                    className="identifier inline-flex items-center rounded border border-line bg-line-soft px-1.5 py-0.5 text-xs text-ink-soft"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </Panel>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Left */}
              <div className="space-y-6">
                <Panel>
                  <PanelHeading>{isResubmission ? 'What changed since the last submission' : 'What the invoice says'}</PanelHeading>
                  <div className="px-5 py-4">
                    {isResubmission ? (
                      <ul className="space-y-3">
                        {changes.map((change) => (
                          <li key={change.field} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
                            <p className="text-xs text-muted">{humanKey(change.field)}</p>
                            <div className="mt-1 flex flex-wrap items-baseline gap-2 text-sm">
                              <span className="text-muted line-through tnum">{evidenceValue(change.from)}</span>
                              <span aria-hidden="true" className="text-muted">
                                to
                              </span>
                              <span className={cn('font-medium tnum', classes.text)}>{evidenceValue(change.to)}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : invoiceFields.length > 0 ? (
                      <LabelValueGrid fields={invoiceFields} flagTone={toneName} />
                    ) : (
                      <p className="text-sm text-muted">The document was not read on this run.</p>
                    )}
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading>Why this outcome</PanelHeading>
                  <div className="px-5 py-4">
                    <ReasonCodes codes={codes} />
                  </div>
                </Panel>
              </div>

              {/* Right */}
              <div className="space-y-6">
                <Panel>
                  <PanelHeading>The order</PanelHeading>
                  <div className="px-5 py-4">
                    {order ? (
                      <>
                        <LabelValueGrid
                          fields={[
                            { label: 'Order', value: order.po_number, mono: true },
                            { label: 'Order value', value: money(orderValue, order.currency) },
                            { label: 'Billed before this', value: money(billed, order.currency) },
                            { label: 'This invoice', value: money(invoiceTotal, order.currency) },
                            { label: 'Tolerance allowed', value: allowance != null ? money(allowance) : 'Not applicable' },
                            {
                              label: 'Over the order by',
                              value: overage != null && overage > 0 ? money(overage) : 'Nothing',
                              flagged: overage != null && overage > 0,
                            },
                          ]}
                          flagTone={toneName}
                        />

                        {orderLines.length > 0 ? (
                          <div className="mt-5 border-t border-line-soft pt-4">
                            <h3 className="text-xs text-muted">Lines on the order</h3>
                            <ul className="mt-2 space-y-2">
                              {orderLines.map((line, index) => (
                                <li key={index} className="flex items-baseline justify-between gap-4 text-sm">
                                  <span className="min-w-0 truncate text-ink-soft">{line.description ?? 'No description'}</span>
                                  <span className="shrink-0 text-ink tnum">{money(line.amount ?? null, order.currency)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {unmatchedLines.length > 0 ? (
                          <div className={cn('mt-4 rounded-md border px-3 py-2.5', classes.panel)}>
                            <h3 className={cn('text-xs font-medium', classes.text)}>Lines the order does not account for</h3>
                            <ul className="mt-1.5 space-y-1">
                              {unmatchedLines.map((line, index) => (
                                <li key={index} className={cn('text-sm', classes.text)}>
                                  {evidenceValue(line.description ?? line)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-sm text-muted">
                        No order was matched, so there is nothing to compare this invoice against.
                      </p>
                    )}
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading>The trail</PanelHeading>
                  <ol className="px-5 py-4">
                    <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm first:pt-0">
                      <span className="text-ink-soft">Received</span>
                      <span className="text-muted tnum">{dateAndTime(invoice?.created_at)}</span>
                    </li>
                    <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm">
                      <span className="text-ink-soft">Checks started</span>
                      <span className="text-muted tnum">{dateAndTime(run.started_at)}</span>
                    </li>
                    <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm last:border-0">
                      <span className="text-ink-soft">Decided</span>
                      <span className="text-muted tnum">{dateAndTime(run.finished_at)}</span>
                    </li>
                    {run.parent_run_id ? (
                      <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
                        <span className="text-ink-soft">Earlier attempt</span>
                        <Link to={`/decisions/${run.parent_run_id}`} className="text-ink underline underline-offset-4">
                          See what was submitted before
                        </Link>
                      </li>
                    ) : null}
                    {run.touched_by_human ? (
                      <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
                        <span className="text-ink-soft">Overridden</span>
                        <span className="text-muted">{run.touched_by ?? 'A person'}</span>
                      </li>
                    ) : null}
                  </ol>
                </Panel>

                {codes.includes('UNKNOWN_VENDOR') ? (
                  <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
                    <p className="text-sm text-ink-soft">
                      This company is not on the approved vendor list yet. Add it, confirm where its payments go, and we
                      will check this invoice again.
                    </p>
                    <Button asChild className="mt-3">
                      <Link to={`/vendors/new?from=${run.id}`}>Add this vendor</Link>
                    </Button>
                  </Panel>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <Panel>
            <EmptyState>Open a decision from the queue to see it here.</EmptyState>
          </Panel>
        )}
      </div>
    </AppShell>
  )
}
