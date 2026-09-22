// One invoice, fully explained. Used by the queue's detail pane and by the
// standalone decision page, so both show exactly the same thing.
//
// Three tabs. Decision is the verdict and why. Document is the page itself beside
// what was read off it. History is the trail, and the only place in the product
// where an internal identifier appears.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dateAndTime, evidenceValue, fileNameOf, humanKey, money, shortDate } from '@/lib/format.ts'
import { duplicateOfSentence, FAILED_RUN_SENTENCE, reasonSentence, verdictTone } from '@/lib/reasonCopy.ts'
import { loadDecision, readFields, type DecisionData, type OrderLine } from '@/lib/decisionData.ts'
import { discardRun, recordOverride, removeFailedRun } from '@/lib/queries.ts'
import { duplicateFromStages } from '@/lib/feed.ts'
import { AskVendorDialog } from './AskVendorDialog.tsx'
import { DiscardDialog } from './DiscardDialog.tsx'
import { DocumentViewer } from './DocumentViewer.tsx'
import { OverrideDialog } from './OverrideDialog.tsx'
import {
  EmptyState,
  ErrorNote,
  LabelValueGrid,
  Loading,
  OutcomeChip,
  Panel,
  PanelHeading,
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
  // Read by the keyboard handler, which is registered once and must not close over
  // a stale idea of what this invoice is.
  const duplicateRef = useRef(false)

  const load = useCallback(async () => {
    if (!runId) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const fresh = await loadDecision(runId)
      if (!fresh) setError('That decision is no longer here. Choose another invoice from the list.')
      setData(fresh)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This decision could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    setTab('decision')
    setSelectedField(null)
    void load()
  }, [load])

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

  if (loading && !data) {
    return (
      <Panel className="flex h-full items-center justify-center">
        <Loading>Loading the decision</Loading>
      </Panel>
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
  const fields = readFields(data, { money: (value) => money(value), date: (value) => shortDate(value) })
  const orderLines: OrderLine[] = Array.isArray(data.order?.line_items) ? (data.order.line_items as OrderLine[]) : []
  const selected = fields.find((field) => field.key === selectedField) ?? null

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
                {data.run.touched_by_human ? 'Approved by a person' : 'Override and approve'}
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

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
                <Panel>
                  <PanelHeading>Why this outcome</PanelHeading>
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
                <PanelHeading>The order</PanelHeading>
                <div className="px-5 py-4">
                  {data.order ? (
                    <>
                      <LabelValueGrid
                        fields={[
                          { label: 'Order', value: data.order.po_number, mono: true },
                          { label: 'Order value', value: money(data.order.total_amount, data.order.currency) },
                          { label: 'Billed before this', value: money(data.order.amount_billed_to_date, data.order.currency) },
                          { label: 'This invoice', value: money(data.invoice?.total ?? null, data.order.currency) },
                        ]}
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
                    </>
                  ) : (
                    <p className="text-sm text-muted">
                      No order was matched, so there is nothing to compare this invoice against.
                    </p>
                  )}
                </div>
              </Panel>
            </div>

            {data.codes.includes('UNKNOWN_VENDOR') ? (
              <Panel className={cn('border-l-4 px-5 py-4', classes.border)}>
                <p className="text-sm text-ink-soft">
                  This company is not on the approved vendor list yet. Add it, confirm where its payments go, and we
                  will check this invoice again.
                </p>
                <Button asChild className="mt-3" size="sm">
                  <Link to={`/vendors/new?from=${data.run.id}`}>Add this vendor</Link>
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
                {data.run.touched_by_human ? (
                  <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
                    <span className="text-ink-soft">Approved by</span>
                    <span className="text-muted">{data.run.touched_by ?? 'A person'}</span>
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
