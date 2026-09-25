// Watching a document go through.
//
// Stages arrive over Realtime as the pipeline writes them, so this view never
// polls and never sits still while something is happening. A stage that is
// running shows a spinner and a clock that keeps counting, because a frozen screen
// and a slow one look identical otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  ErrorNote,
  EvidenceGrid,
  LabelValueGrid,
  Loading,
  PageBody,
  Panel,
  PanelHeading,
  Spinner,
  VerdictChip,
  type Field,
} from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { asRecord, duration, money, shortDate } from '@/lib/format.ts'
import { orderTallyFrom } from '@/lib/orders.ts'
import { stageLabel, verdictTone } from '@/lib/reasonCopy.ts'
import { PIPELINE_STAGES } from '@/lib/pipeline.ts'
import { getInvoiceById, getPurchaseOrders, getRunById, getStageLogs } from '@/lib/queries.ts'
import { supabase } from '@/lib/supabase.ts'
import type { InvoiceRow, PurchaseOrderRow, RunRow, StageLogRow } from '@/lib/database.types.ts'

// A clock that ticks while something is in flight and stops when it is not.
function useElapsed(since: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [active])
  if (!since) return 0
  const start = new Date(since).getTime()
  return Number.isNaN(start) ? 0 : Math.max(0, now - start)
}

function StageRow({ stage, log }: { stage: string; log: StageLogRow | undefined }) {
  const status = log?.status ?? 'pending'
  const running = status === 'running'
  const elapsed = useElapsed(log?.created_at ?? null, running)
  const flagged = status === 'flagged' || status === 'failed'
  const classes = tone(status === 'failed' ? 'block' : 'review')

  const evidence =
    flagged && log?.output && typeof log.output === 'object' && !Array.isArray(log.output)
      ? (log.output as Record<string, unknown>)
      : null

  return (
    <li
      className={cn(
        'rounded-lg border px-4 py-3.5',
        status === 'pending' && 'border-dashed border-line opacity-60',
        (status === 'passed' || running) && 'border-line',
        flagged && classes.panel,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          {running ? (
            <Spinner />
          ) : status === 'passed' ? (
            <Check className="size-4 text-approve" />
          ) : flagged ? (
            <AlertTriangle className={cn('size-4', classes.text)} />
          ) : (
            <span className="size-2 rounded-full bg-line" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-ink">{stageLabel(stage)}</h3>
            <span className="shrink-0 text-xs text-muted tnum">
              {running ? duration(elapsed) : log?.duration_ms != null ? duration(log.duration_ms) : ''}
            </span>
          </div>

          <p className="mt-1 text-sm text-muted">
            {log?.reasoning ?? (running ? 'Working on it.' : 'Waiting for the stages before it.')}
          </p>

          {evidence ? (
            <div className="mt-3 rounded-md border border-line bg-surface px-3 py-2.5">
              <EvidenceGrid evidence={evidence} />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export default function RunLive() {
  const { id = '' } = useParams()
  const [run, setRun] = useState<RunRow | null>(null)
  const [logs, setLogs] = useState<StageLogRow[]>([])
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null)
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const invoiceIdRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [fresh, stages] = await Promise.all([getRunById(id), getStageLogs(id)])
      if (!fresh) {
        setError('That run does not exist. It may have been cleared. Go back to the queue and open it again.')
        setLoaded(true)
        return
      }
      setRun(fresh)
      setLogs(stages)
      if (fresh.invoice_id && fresh.invoice_id !== invoiceIdRef.current) {
        invoiceIdRef.current = fresh.invoice_id
        setInvoice(await getInvoiceById(fresh.invoice_id))
      } else if (fresh.invoice_id) {
        // The row is rewritten from the extraction part-way through a run, so keep
        // reading it while the run is live.
        setInvoice(await getInvoiceById(fresh.invoice_id))
      }
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The run could not be loaded.')
      setLoaded(true)
    }
  }, [id])

  useEffect(() => {
    void refresh()
    void getPurchaseOrders().then(setOrders).catch(() => undefined)
  }, [refresh])

  // Realtime, not polling. Every stage write for this run wakes the view.
  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`run:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stage_logs', filter: `run_id=eq.${id}` }, () => {
        void refresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runs', filter: `id=eq.${id}` }, () => {
        void refresh()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [id, refresh])

  const byStage = useMemo(() => {
    const map = new Map<string, StageLogRow>()
    for (const log of logs) map.set(log.stage, log)
    return map
  }, [logs])

  const live = run?.status === 'running'
  const elapsed = useElapsed(run?.started_at ?? null, live === true)

  const extractLog = byStage.get('extract')
  const readFields: Field[] = useMemo(() => {
    const data =
      extractLog?.output && typeof extractLog.output === 'object' && !Array.isArray(extractLog.output)
        ? (extractLog.output as Record<string, unknown>)
        : null
    if (!data) return []
    const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : 'Not read')
    const num = (key: string) => (typeof data[key] === 'number' ? (data[key] as number) : null)
    return [
      { label: 'Invoice number', value: text('invoice_number'), mono: true },
      { label: 'Invoice date', value: shortDate(text('invoice_date')) },
      { label: 'Vendor as printed', value: text('vendor_name') },
      { label: 'Order cited', value: text('po_reference'), mono: true },
      { label: 'Subtotal', value: money(num('subtotal')) },
      { label: 'Tax', value: money(num('tax')) },
      { label: 'Total', value: money(num('total')) },
      { label: 'Bank account', value: text('bank_account'), mono: true },
      { label: 'IFSC', value: text('bank_ifsc'), mono: true },
      { label: 'Bank', value: text('bank_name') },
      { label: 'Pay to', value: text('remit_to_name') },
    ]
  }, [extractLog])

  const matchedOrder = orders.find((order) => order.po_number === run?.matched_po) ?? null
  // What the order had been billed when this run measured it, which is the
  // opening balance plus every invoice approved against it by then. The order row
  // carries only the opening balance.
  const tally = orderTallyFrom({
    validations: asRecord(logs.find((log) => log.stage === 'validate')?.output),
    order: matchedOrder,
    invoiceTotal: invoice?.total ?? null,
  })
  const orderFields: Field[] = matchedOrder
    ? [
        { label: 'Order', value: matchedOrder.po_number, mono: true },
        { label: 'Order value', value: money(tally?.orderValue ?? matchedOrder.total_amount, matchedOrder.currency) },
        { label: 'Billed so far', value: money(tally?.billedBefore ?? matchedOrder.amount_billed_to_date, matchedOrder.currency) },
        { label: 'Issued', value: shortDate(matchedOrder.issued_date) },
        { label: 'Status', value: matchedOrder.status === 'open' ? 'Open' : 'Closed' },
        { label: 'Figures include tax', value: matchedOrder.tax_treatment === 'inclusive' ? 'Yes' : 'No' },
      ]
    : []

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the queue
          </Link>

          <div className="flex items-center gap-3">
            {live ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-sm text-ink-soft">
                <Spinner label="Checks in progress" />
                Checking, {duration(elapsed)}
              </span>
            ) : run?.status === 'failed' ? (
              <span className={cn('rounded-full px-3 py-1 text-sm', tone('block').chip)}>Run failed</span>
            ) : run ? (
              <>
                <VerdictChip verdict={run.verdict} />
                <Button asChild variant="outline">
                  <Link to={`/decisions/${run.id}`}>See the decision</Link>
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {error ? <ErrorNote title="This run could not be shown">{error}</ErrorNote> : null}

        {!loaded ? (
          <Panel>
            <Loading>Loading the run</Loading>
          </Panel>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Panel className="p-5">
              <h1 className="mb-4 text-lg font-semibold text-ink">
                {invoice?.invoice_number ? (
                  <>
                    Checking <span className="identifier">{invoice.invoice_number}</span>
                  </>
                ) : (
                  'Checking this invoice'
                )}
              </h1>
              <ol className="space-y-2.5">
                {PIPELINE_STAGES.map((stage) => (
                  <StageRow key={stage} stage={stage} log={byStage.get(stage)} />
                ))}
              </ol>
            </Panel>

            <div className="space-y-6">
              <Panel>
                <PanelHeading>What we read from the document</PanelHeading>
                <div className="px-5 py-4">
                  {readFields.length > 0 ? (
                    <LabelValueGrid fields={readFields} flagTone={verdictTone(run?.verdict)} />
                  ) : (
                    <p className="text-sm text-muted">The document has not been read yet.</p>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHeading>The order it was checked against</PanelHeading>
                <div className="px-5 py-4">
                  {matchedOrder ? (
                    <LabelValueGrid fields={orderFields} />
                  ) : (
                    <p className="text-sm text-muted">No order has been matched to this invoice.</p>
                  )}
                </div>
              </Panel>

              <p className="prose-serif px-1 text-sm text-muted">
                The model reads the document. It never decides anything. Every verdict comes from the rules on the Rules
                page.
              </p>
            </div>
          </div>
        )}
        </div>
      </PageBody>
    </AppShell>
  )
}
