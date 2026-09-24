// One invoice, fully explained. Used by the queue's detail pane and by the
// standalone decision page, so both show exactly the same thing.
//
// Three tabs. Decision is the verdict and why. Document is the page itself beside
// what was read off it. History is the trail, and the only place in the product
// where an internal identifier appears.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dateAndTime, evidenceValue, fileNameOf, humanKey, money, shortDate } from '@/lib/format.ts'
import {
  APPROVED_BY_PERSON_LABEL,
  approvedByPersonSentence,
  comparedBySentence,
  COUNTS_AGAINST_ORDER_LABEL,
  NOT_COUNTING_LABEL,
  ORDER_INVOICES_EMPTY,
  ORDER_INVOICES_LABEL,
  ORDER_OVERAGE_LABEL,
  OTHERS_LIKE_THIS_LABEL,
  BANK_CHANGED_RECENTLY_LABEL,
  BANK_CONFIRMED_LABEL,
  BANK_CONFIRMED_MISSING,
  bankChangedRecentlySentence,
  duplicateOfSentence,
  FAILED_RUN_SENTENCE,
  reasonSentence,
  vendorAddedSinceSentence,
  verdictTone,
} from '@/lib/reasonCopy.ts'
import { bankChangedRecently, daysSinceBankChange } from '@/lib/vendorEdit.ts'
import { approverOf, loadDecision, readFields, type DecisionData, type OrderLine } from '@/lib/decisionData.ts'
import type { RelatedInvoice } from '@/lib/relatedInvoices.ts'
import { discardRun, recordOverride, removeFailedRun } from '@/lib/queries.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { supabase } from '@/lib/supabase.ts'
import { duplicateFromStages } from '@/lib/feed.ts'
import { AskVendorDialog } from './AskVendorDialog.tsx'
import { DiscardDialog } from './DiscardDialog.tsx'
import { DocumentViewer } from './DocumentViewer.tsx'
import { OverrideDialog } from './OverrideDialog.tsx'
import {
  DecisionSkeleton,
  EmptyState,
  ErrorNote,
  LabelValueGrid,
  OutcomeChip,
  Panel,
  PanelHeading,
  Skeleton,
} from './Primitives.tsx'
import { tone } from './tone.ts'

export type DetailTab = 'decision' | 'document' | 'history'

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'decision', label: 'Decision' },
  { id: 'document', label: 'Document' },
  { id: 'history', label: 'History' },
]

export interface DecisionDetailHandle {
  openDocument: () => void
  // The primary action for whatever this is. Approving an exception, or filing a
  // duplicate away: the keyboard should not have to know which.
  act: () => void
}

/**
 * Other invoices, laid out as rows a person can compare at a glance.
 *
 * Every column here is one of the things that separates a duplicate from an
 * ordinary bill: when it was dated, what it was for, which order it cites, and
 * what happened to it. `showGap` adds the two that only mean something against
 * another invoice, the days between them and the difference in amount.
 */
function RelatedInvoiceList({ rows, showGap }: { rows: readonly RelatedInvoice[]; showGap: boolean }) {
  return (
    <ul className="mt-2 divide-y divide-line-soft">
      {rows.map((row) => (
        <li key={row.invoiceId} className="py-2 first:pt-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {row.run ? <OutcomeChip run={row.run} size="sm" /> : null}
            {row.runId ? (
              <Link
                to={`/decisions/${row.runId}`}
                className="identifier text-sm text-ink underline underline-offset-4"
              >
                {row.invoiceNumber}
              </Link>
            ) : (
              <span className="identifier text-sm text-ink">{row.invoiceNumber}</span>
            )}
            <span className="text-sm text-muted">{shortDate(row.invoiceDate)}</span>
            <span className="ml-auto text-sm text-ink tnum">{money(row.total, row.currency)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-xs text-muted">
            <span className="identifier">{row.poNumber ?? 'No order'}</span>
            {showGap && row.gapDays !== null ? (
              <span className="tnum">
                {row.gapDays === 0 ? 'Same day' : row.gapDays === 1 ? '1 day apart' : `${row.gapDays} days apart`}
              </span>
            ) : null}
            {showGap && row.amountDifference !== null ? (
              <span className="tnum">
                {row.amountDifference === 0
                  ? 'Same amount'
                  : `${money(row.amountDifference, row.currency)} apart`}
              </span>
            ) : null}
            <span className={row.countsAgainstTheOrder ? tone('approve').text : undefined}>
              {row.countsAgainstTheOrder ? COUNTS_AGAINST_ORDER_LABEL : NOT_COUNTING_LABEL}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DecisionDetail({
  runId,
  onChanged,
  onRemoved,
  handleRef,
}: {
  runId: string | null
  onChanged?: () => void
  // Fired when the record this pane was showing no longer exists, so the list can
  // move the selection somewhere that does.
  onRemoved?: () => void
  // Lets the queue drive this pane from the keyboard without owning its state.
  handleRef?: MutableRefObject<DecisionDetailHandle | null>
}) {
  const [data, setData] = useState<DecisionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<DetailTab>('decision')
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const navigate = useNavigate()
  // Read by the keyboard handler, which is registered once and must not close over
  // a stale idea of what this invoice is.
  const duplicateRef = useRef(false)

  /**
   * Which decision this pane is currently showing, or waiting for.
   *
   * A fetch started for one invoice can land after the reader has moved to
   * another. Comparing against this on arrival is what stops the slower of two
   * responses painting itself over the newer selection.
   */
  const showing = useRef<string | null>(runId)

  const load = useCallback(async () => {
    if (!runId) {
      setData(null)
      return
    }
    setLoading(true)
    try {
      const fresh = await loadDecision(runId)
      if (showing.current !== runId) return
      setError(fresh ? null : 'That decision is no longer here. Choose another invoice from the list.')
      setData(fresh)
    } catch (caught) {
      if (showing.current !== runId) return
      setError(caught instanceof Error ? caught.message : 'This decision could not be loaded.')
    } finally {
      if (showing.current === runId) setLoading(false)
    }
  }, [runId])

  // A new selection empties the pane before it fetches. Leaving the previous
  // invoice's verdict, reasons and order on screen under the new invoice's name is
  // the one thing this pane must never do.
  useEffect(() => {
    showing.current = runId
    setTab('decision')
    setSelectedField(null)
    setData(null)
    setError(null)
    void load()
  }, [runId, load])

  /**
   * The explanation arrives after the verdict does.
   *
   * Stage 7 runs once the decision is already written, so a run opened the instant
   * it completes carries the deterministic summary and the model's wording lands a
   * few seconds later. Watching the row means that paragraph appears by itself
   * rather than on the next time somebody happens to reload.
   */
  useEffect(() => {
    if (!runId) return
    const channel = supabase
      .channel(`decision:${runId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'runs', filter: `id=eq.${runId}` }, () => {
        void load()
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [runId, load])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      openDocument: () => setTab('document'),
      act: () => (duplicateRef.current ? setDiscardOpen(true) : setOverrideOpen(true)),
    }
  }, [handleRef])

  const saveOverride = async (who: string) => {
    if (!data) return
    await recordOverride(data.run.id, who)
    await load()
    onChanged?.()
  }

  const remove = async () => {
    if (!data) return
    setRemoving(true)
    try {
      await removeFailedRun(data.run.id, data.run.invoice_id)
      onRemoved?.()
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This could not be removed. Try again in a moment.')
    } finally {
      setRemoving(false)
    }
  }

  const saveDiscard = async (who: string) => {
    if (!data) return
    await discardRun(data.run.id, who)
    await load()
    onChanged?.()
  }

  /**
   * Decides the invoice again, against the master as it stands now.
   *
   * Offered where a run's reason no longer holds, which today means a vendor added
   * since it was decided. It is an ordinary run through the same seven stages: the
   * rules decide it, not this button.
   */
  const recheck = async () => {
    if (!data?.invoice) return
    setRechecking(true)
    setError(null)
    try {
      let newRunId: string | null = null
      const outcome = await runInvoice(data.invoice.id, {
        onRunCreated: (created) => {
          newRunId = created.id
        },
      })
      onChanged?.()
      navigate(`/decisions/${newRunId ?? outcome.run.id}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This invoice could not be checked again.')
      setRechecking(false)
    }
  }

  const copyAudit = async () => {
    if (!data) return
    const lines = [
      `Run: ${data.run.id}`,
      `Invoice record: ${data.invoice?.id ?? 'none'}`,
      `Document hash: ${data.invoice?.file_hash ?? 'none'}`,
      `Stored at: ${data.invoice?.storage_path ?? data.invoice?.file_path ?? 'none'}`,
      `Started: ${data.run.started_at}`,
      `Finished: ${data.run.finished_at ?? 'not finished'}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(lines)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  if (!runId) {
    return (
      <Panel className="flex h-full items-center justify-center">
        <EmptyState>Choose an invoice on the left to see why it stopped.</EmptyState>
      </Panel>
    )
  }

  // The header is part of the frame rather than part of the decision, so the pane
  // keeps its shape while the contents are fetched.
  if (loading && !data) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-ground p-4">
          <DecisionSkeleton />
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <Panel className="p-4">
        <ErrorNote title="This decision could not be shown">{error}</ErrorNote>
      </Panel>
    )
  }

  if (!data) return null

  const toneName = verdictTone(data.run.verdict)
  const classes = tone(toneName)
  const tally = data.orderTally
  const fields = readFields(data, { money: (value) => money(value), date: (value) => shortDate(value) })
  const orderLines: OrderLine[] = Array.isArray(data.order?.line_items) ? (data.order.line_items as OrderLine[]) : []
  const selected = fields.find((field) => field.key === selectedField) ?? null

  const approver = approverOf(data.run)
  // Days since this vendor's account moved, when that was recent enough to matter.
  const recentBankChange =
    data.vendor && bankChangedRecently(data.vendor) ? daysSinceBankChange(data.vendor) : null
  const duplicateOf = duplicateFromStages(data.stages)
  const isDuplicate = data.codes.includes('EXACT_DUPLICATE')
  const failed = data.run.status === 'failed'
  duplicateRef.current = isDuplicate

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: what it is, what was decided, what you can do about it. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <OutcomeChip run={data.run} />
        <h2 className="identifier text-base font-medium text-ink">
          {data.invoice?.invoice_number ?? 'This invoice'}
        </h2>
        <span className="text-sm text-muted">{data.vendor?.legal_name ?? data.invoice?.vendor_name_as_printed ?? ''}</span>
        <span className="ml-auto flex items-center gap-2">
          {failed ? (
            /* Nothing was decided, so there is nothing to approve or question.
               The only useful move is to take it off the list. */
            <Button type="button" size="sm" variant="outline" onClick={remove} disabled={removing}>
              {removing ? 'Removing' : 'Remove'}
            </Button>
          ) : isDuplicate ? (
            /* There is nothing to ask the vendor about a document we have already
               been through, and approving it would pay the same invoice twice,
               which is the thing the check exists to prevent. One action. */
            <Button
              type="button"
              size="sm"
              onClick={() => setDiscardOpen(true)}
              disabled={data.run.discarded_at !== null}
            >
              {data.run.discarded_at !== null ? 'Discarded' : 'Discard duplicate'}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setAskOpen(true)}>
                Ask the vendor
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setOverrideOpen(true)}
                disabled={data.run.touched_by_human}
              >
                {approverOf(data.run) ? 'Approved by a person' : 'Override and approve'}
              </Button>
            </>
          )}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 border-b border-line bg-surface px-3" role="tablist" aria-label="Invoice detail">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm transition-colors',
              tab === entry.id
                ? 'border-ink font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-ground p-4">
        {tab === 'decision' ? (
          <div className="space-y-4">
            {failed ? (
              <Panel className={cn('border-l-4 px-5 py-4', tone('block').border)}>
                <p className="prose-serif max-w-[72ch] text-[17px] text-ink-soft">{FAILED_RUN_SENTENCE}</p>
                <p className="mt-2 text-sm text-muted">
                  Nothing was decided about it, so there is nothing to approve or question. Remove it and send the
                  document again.
                </p>
              </Panel>
            ) : null}

            {/* The verdict card. Reason codes appear here and nowhere else.
                A duplicate's card says which invoice it repeats and links to it,
                in place of an explanation that would only say the same thing in
                looser words. */}
            {approver ? (
              <Panel className={cn('border-l-4 px-5 py-4', tone('approve').border)}>
                <p className={cn('text-xs font-medium', tone('approve').text)}>{APPROVED_BY_PERSON_LABEL}</p>
                <p className="mt-1 text-sm text-ink-soft">
                  {approvedByPersonSentence(
                    approver,
                    data.run.approved_at ? dateAndTime(data.run.approved_at) : 'a date that was not recorded',
                    data.run.verdict,
                  )}
                </p>
              </Panel>
            ) : null}

            <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
              <p className="prose-serif max-w-[72ch] text-[17px] text-ink-soft">
                {duplicateOf
                  ? duplicateOfSentence(
                      duplicateOf.invoiceNumber,
                      shortDate(duplicateOf.decidedAt ?? data.run.started_at),
                    )
                  : (data.run.explanation ?? 'No explanation was recorded for this run.')}
              </p>

              {duplicateOf?.runId ? (
                <Link
                  to={`/decisions/${duplicateOf.runId}`}
                  className="mt-2 inline-block text-sm text-ink underline underline-offset-4"
                >
                  Open {duplicateOf.invoiceNumber}
                </Link>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-1.5">
                {data.codes.map((code) => (
                  <span
                    key={code}
                    className="identifier inline-flex items-center rounded border border-line bg-line-soft px-1.5 py-0.5 text-xs text-ink-soft"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </Panel>

            {/* The disagreement, before anything else. */}
            {data.disputes.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.disputes.map((dispute) => (
                  <Panel key={dispute.label} className={cn('border px-4 py-3', classes.panel)}>
                    <p className={cn('text-xs font-medium', classes.text)}>{dispute.label}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-3">
                      <div>
                        <dt className={cn('text-xs', classes.text)}>{dispute.printedLabel}</dt>
                        <dd className={cn('identifier mt-0.5 text-sm font-medium', classes.text)}>
                          {evidenceValue(dispute.printed)}
                        </dd>
                      </div>
                      <div>
                        <dt className={cn('text-xs', classes.text)}>{dispute.onFileLabel}</dt>
                        <dd className={cn('identifier mt-0.5 text-sm font-medium', classes.text)}>
                          {evidenceValue(dispute.onFile)}
                        </dd>
                      </div>
                    </dl>
                  </Panel>
                ))}
              </div>
            ) : null}

            {/* Shown only when a check reached its answer by comparing this
                invoice with others. Those others are the judgement. */}
            {data.othersLikeThis.length > 0 ? (
              <Panel>
                <PanelHeading
                  right={<span className="text-xs text-muted tnum">{data.othersLikeThis.length} shown</span>}
                >
                  {OTHERS_LIKE_THIS_LABEL}
                </PanelHeading>
                <div className="px-5 py-4">
                  <p className="text-sm text-muted">{comparedBySentence(data.comparedBy)}</p>
                  <RelatedInvoiceList rows={data.othersLikeThis} showGap />
                </div>
              </Panel>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
                <Panel>
                  {/* What the checks found, which is not the same question as
                      what happens to the invoice: a person may have approved it
                      since. The chip and the banner above carry the outcome. */}
                  <PanelHeading>What the checks found</PanelHeading>
                  <ul className="space-y-2 px-5 py-4">
                    {data.codes.map((code) => (
                      <li key={code} className="text-sm text-ink-soft">
                        {reasonSentence(code)}
                      </li>
                    ))}
                  </ul>
                </Panel>

                {data.businessChanges.length > 0 || data.fileReplacedOnly ? (
                  <Panel>
                    <PanelHeading>What changed since the last submission</PanelHeading>
                    <div className="px-5 py-4">
                      {data.fileReplacedOnly ? (
                        <p className="text-sm text-ink-soft">The document file was replaced.</p>
                      ) : (
                        <ul className="space-y-3">
                          {data.businessChanges.map((change) => (
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
                      )}
                    </div>
                  </Panel>
                ) : data.run.parent_run_id ? (
                  <Panel>
                    <PanelHeading>What changed since the last submission</PanelHeading>
                    <p className="px-5 py-4 text-sm text-ink-soft">Nothing on the invoice changed.</p>
                  </Panel>
                ) : null}
              </div>

              <Panel>
                <PanelHeading
                  right={
                    data.order ? (
                      <Link
                        to={`/orders/${encodeURIComponent(data.order.po_number)}`}
                        className="text-xs text-muted underline underline-offset-4 transition-colors hover:text-ink"
                      >
                        Open the order
                      </Link>
                    ) : null
                  }
                >
                  The order
                </PanelHeading>
                <div className="px-5 py-4">
                  {data.order && tally ? (
                    <>
                      {/* The arithmetic, done. A reviewer should not have to take
                          the order's value, subtract what is already committed
                          against it and compare the remainder with this invoice
                          in their head. */}
                      <LabelValueGrid
                        fields={[
                          { label: 'Order', value: data.order.po_number, mono: true },
                          { label: 'Order value', value: money(tally.orderValue, tally.currency) },
                          { label: 'Already billed', value: money(tally.billedBefore, tally.currency) },
                          { label: 'This invoice', value: money(tally.thisInvoice, tally.currency) },
                          ...(tally.overage !== null
                            ? [
                                {
                                  label: ORDER_OVERAGE_LABEL,
                                  value: money(tally.overage, tally.currency),
                                  flagged: true,
                                },
                              ]
                            : []),
                        ]}
                        flagTone={toneName}
                      />
                      {orderLines.length > 0 ? (
                        <div className="mt-4 border-t border-line-soft pt-3">
                          <h3 className="text-xs text-muted">Lines on the order</h3>
                          <ul className="mt-2 space-y-1.5">
                            {orderLines.map((line, index) => (
                              <li key={index} className="flex items-baseline justify-between gap-4 text-sm">
                                <span className="min-w-0 truncate text-ink-soft">{line.description ?? 'No description'}</span>
                                <span className="shrink-0 text-ink tnum">{money(line.amount ?? null, data.order?.currency)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {/* Every other invoice on this order. For a set billed just
                          under the limit one at a time, this is the whole pattern
                          in one place, which is what nobody could see from inside
                          any one of them. */}
                      <div className="mt-4 border-t border-line-soft pt-3">
                        <h3 className="text-xs text-muted">{ORDER_INVOICES_LABEL}</h3>
                        {data.siblingsOnOrder.length === 0 ? (
                          <p className="mt-2 text-sm text-muted">{ORDER_INVOICES_EMPTY}</p>
                        ) : (
                          <RelatedInvoiceList rows={data.siblingsOnOrder} showGap={false} />
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted">
                      No order was matched, so there is nothing to compare this invoice against.
                    </p>
                  )}
                </div>
              </Panel>
            </div>

            {/* A vendor whose account moved recently, on an invoice being decided
                now. Not a verdict and not a rule: a changed account is routine and
                so is the fraud that imitates it, and the difference is something
                only the person deciding can weigh. They can only weigh it if they
                are told. */}
            {recentBankChange !== null ? (
              <Panel className={cn('border-l-4 px-5 py-4', tone('block').border)}>
                <p className={cn('text-xs font-medium', tone('block').text)}>{BANK_CHANGED_RECENTLY_LABEL}</p>
                <p className="mt-1 text-sm text-ink-soft">{bankChangedRecentlySentence(recentBankChange)}</p>
                {data.vendor?.bank_confirmed_by ? (
                  <p className="mt-2 text-xs text-muted">
                    {BANK_CONFIRMED_LABEL}: {data.vendor.bank_confirmed_by}
                    {data.vendor.bank_confirmed_at ? `, ${shortDate(data.vendor.bank_confirmed_at)}` : ''}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted">{BANK_CONFIRMED_MISSING}</p>
                )}
              </Panel>
            ) : null}

            {/* A held invoice citing no order had nothing a person could do about
                it, so an uploaded document could never reach approved. */}
            {data.codes.includes('NO_PO_MATCH') ? (
              <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
                <p className="text-sm text-ink-soft">
                  Nothing on file says this work was ordered. If it was, record the order and we will check this
                  invoice against it again.
                </p>
                <Button asChild className="mt-3" size="sm">
                  <Link to={`/orders/new?from=${data.run.id}`}>Raise an order</Link>
                </Button>
              </Panel>
            ) : null}

            {/* Offered only while the company is still unknown. The reason code
                says what was true when this run was decided; if somebody has added
                the vendor since, the useful action is to check the invoice again,
                not to add a company that is already there. */}
            {data.codes.includes('UNKNOWN_VENDOR') && data.vendorUnknownNow ? (
              <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
                <p className="text-sm text-ink-soft">
                  This company is not on the approved vendor list yet. Add it, confirm where its payments go, and we
                  will check this invoice again.
                </p>
                <Button asChild className="mt-3" size="sm">
                  <Link to={`/vendors/new?from=${data.run.id}`}>Add this vendor</Link>
                </Button>
              </Panel>
            ) : data.codes.includes('UNKNOWN_VENDOR') && data.vendor ? (
              <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
                <p className="text-sm text-ink-soft">
                  {vendorAddedSinceSentence(data.vendor.legal_name)}
                </p>
                <Button type="button" className="mt-3" size="sm" onClick={recheck} disabled={rechecking}>
                  {rechecking ? 'Checking again' : 'Check this invoice again'}
                </Button>
              </Panel>
            ) : null}
          </div>
        ) : null}

        {tab === 'document' ? (
          <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-h-0 flex-col gap-3">
              {data.disputes.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.disputes.map((dispute) => (
                    <div key={dispute.label} className={cn('rounded-lg border px-3 py-2', classes.panel)}>
                      <p className={cn('text-xs font-medium', classes.text)}>{dispute.label}</p>
                      <div className="mt-1 flex items-baseline justify-between gap-3">
                        <span className={cn('identifier text-sm', classes.text)}>{evidenceValue(dispute.printed)}</span>
                        <span className={cn('identifier text-sm', classes.text)}>{evidenceValue(dispute.onFile)}</span>
                      </div>
                      <div className={cn('mt-0.5 flex items-baseline justify-between gap-3 text-xs', classes.text)}>
                        <span>{dispute.printedLabel}</span>
                        <span>{dispute.onFileLabel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <DocumentViewer url={data.documentUrl} isImage={data.documentIsImage} className="min-h-0 flex-1" />
            </div>

            <div className="space-y-3">
              {selected ? (
                <Panel className={cn('px-4 py-3', selected.flagged ? classes.panel : '')}>
                  <p className={cn('text-xs', selected.flagged ? classes.text : 'text-muted')}>{selected.label}</p>
                  <p
                    className={cn(
                      'mt-1 break-words text-2xl font-semibold tnum',
                      selected.mono && 'identifier',
                      selected.flagged ? classes.text : 'text-ink',
                    )}
                  >
                    {selected.value}
                  </p>
                  <p className="mt-2 text-xs text-muted">Find this on the page beside it and check the two agree.</p>
                </Panel>
              ) : (
                <Panel className="px-4 py-3">
                  <p className="text-sm text-muted">Choose a field to see it large enough to compare against the page.</p>
                </Panel>
              )}

              <Panel>
                <PanelHeading>What we read</PanelHeading>
                <ul className="divide-y divide-line-soft">
                  {fields.map((field) => (
                    <li key={field.key}>
                      <button
                        type="button"
                        onClick={() => setSelectedField(field.key)}
                        aria-pressed={selectedField === field.key}
                        className={cn(
                          'flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-line-soft',
                          selectedField === field.key && 'bg-line-soft',
                        )}
                      >
                        <span className="shrink-0 text-xs text-muted">{field.label}</span>
                        <span
                          className={cn(
                            'min-w-0 truncate text-sm tnum',
                            field.mono && 'identifier',
                            field.flagged ? cn('font-medium', classes.text) : 'text-ink',
                          )}
                        >
                          {field.value}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        ) : null}

        {tab === 'history' ? (
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel>
              <PanelHeading>The trail</PanelHeading>
              <ol className="px-5 py-4">
                <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm first:pt-0">
                  <span className="text-ink-soft">Received</span>
                  <span className="text-muted tnum">{dateAndTime(data.invoice?.created_at)}</span>
                </li>
                <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm">
                  <span className="text-ink-soft">Checks started</span>
                  <span className="text-muted tnum">{dateAndTime(data.run.started_at)}</span>
                </li>
                <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm">
                  <span className="text-ink-soft">Decided</span>
                  <span className="text-muted tnum">{dateAndTime(data.run.finished_at)}</span>
                </li>
                {data.run.parent_run_id ? (
                  <li className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 text-sm">
                    <span className="text-ink-soft">Earlier attempt</span>
                    <Link to={`/decisions/${data.run.parent_run_id}`} className="text-ink underline underline-offset-4">
                      See what was submitted before
                    </Link>
                  </li>
                ) : null}
                {/* Only where somebody actually overrode the verdict, and only with
                    the name they gave. An approval with no name against it is not
                    an approval anyone can be asked about, and this line was
                    appearing on invoices that were blocked and stayed blocked. */}
                {approver ? (
                  <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
                    <span className="text-ink-soft">Approved by</span>
                    <span className="text-muted">
                      {approver},{' '}
                      <span className="tnum">
                        {data.run.approved_at ? dateAndTime(data.run.approved_at) : 'date not recorded'}
                      </span>
                    </span>
                  </li>
                ) : null}
                {data.run.discarded_at ? (
                  <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
                    <span className="text-ink-soft">Filed away by</span>
                    <span className="text-muted">
                      {data.run.discarded_by ?? 'Not recorded'}, {dateAndTime(data.run.discarded_at)}
                    </span>
                  </li>
                ) : null}
              </ol>
            </Panel>

            <Panel>
              <PanelHeading
                right={
                  <button
                    type="button"
                    onClick={copyAudit}
                    className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                }
              >
                For an auditor
              </PanelHeading>
              <div className="px-5 py-4">
                <p className="text-sm text-muted">
                  The references a support engineer or an auditor would ask for. Nothing here is needed to work an
                  invoice.
                </p>
                <dl className="mt-3 space-y-2">
                  {[
                    ['Run', data.run.id],
                    ['Invoice record', data.invoice?.id ?? 'None'],
                    ['Document hash', data.invoice?.file_hash ?? 'None'],
                    ['File', fileNameOf(data.invoice) ?? 'None'],
                    ['Stored at', data.invoice?.storage_path ?? data.invoice?.file_path ?? 'None'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted">{label}</dt>
                      <dd className="identifier mt-0.5 break-all text-xs text-ink-soft">{value}</dd>
                    </div>
                  ))}
                </dl>

                {/* The out-of-band check on this vendor's account, which is what
                    the bank-detail rule compares every invoice against. Collecting
                    it and never showing it made it a box somebody filled in; shown
                    here it is the evidence that the check actually happened. */}
                {data.vendor ? (
                  <div className="mt-4 border-t border-line-soft pt-3">
                    <h3 className="text-xs text-muted">{BANK_CONFIRMED_LABEL}</h3>
                    {data.vendor.bank_confirmed_by ? (
                      <>
                        <p className="mt-1 text-sm text-ink-soft">{data.vendor.bank_confirmed_by}</p>
                        <p className="mt-0.5 text-xs text-muted tnum">
                          {data.vendor.bank_confirmed_at
                            ? `Confirmed ${dateAndTime(data.vendor.bank_confirmed_at)}`
                            : 'No date was recorded against this confirmation.'}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-ink-soft">{BANK_CONFIRMED_MISSING}</p>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      Account on file: <span className="identifier">{data.vendor.bank_account ?? 'None'}</span>
                      {data.vendor.bank_ifsc ? (
                        <>
                          , <span className="identifier">{data.vendor.bank_ifsc}</span>
                        </>
                      ) : null}
                    </p>
                    {data.vendor.bank_changed_at ? (
                      <p className="mt-0.5 text-xs text-muted tnum">
                        Last changed {dateAndTime(data.vendor.bank_changed_at)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel className="xl:col-span-2">
              <PanelHeading>How it ran</PanelHeading>
              <ol className="divide-y divide-line-soft">
                {data.stages.map((stage) => (
                  <li key={stage.id} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0 text-sm text-ink-soft">{stage.reasoning ?? 'No note recorded.'}</span>
                    <span className="shrink-0 text-xs text-muted tnum">
                      {stage.duration_ms != null ? `${stage.duration_ms}ms` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
        ) : null}
      </div>

      <AskVendorDialog open={askOpen} onOpenChange={setAskOpen} data={data} />
      <DiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        duplicateOf={duplicateOf?.invoiceNumber ?? null}
        onConfirm={saveDiscard}
      />
      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        invoiceNumber={data.invoice?.invoice_number ?? null}
        onConfirm={saveOverride}
      />
    </div>
  )
}
