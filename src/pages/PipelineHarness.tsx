import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { InvoiceRow, Verdict } from '@/lib/database.types.ts'
import { loadPipelineContext, runInvoice, type PipelineContext } from '@/lib/pipeline.ts'
import { resetDemoData } from '@/lib/queries.ts'
import { cn } from '@/lib/utils'

// The batch is the only place stage 7 would fire 27 model calls in a row, and the
// explanation is presentational — the verdict is identical either way. Off by
// default; a single re-run from a row turns it on.
const EXPLAIN_IN_BATCH = false

type RowStatus = 'idle' | 'running' | 'done' | 'error'

interface PipelineRow {
  invoice: InvoiceRow
  status: RowStatus
  verdict?: Verdict
  reasonCodes?: string[]
  matchedPo?: string | null
  explanation?: string
  error?: string
}

const VERDICT_STYLES: Record<string, string> = {
  AUTO_APPROVE: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  REVIEW: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  HOLD: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  BLOCK: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  ROUTED_NOT_PAID: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
}

function VerdictChip({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', VERDICT_STYLES[verdict] ?? 'bg-muted')}>
      {verdict}
    </span>
  )
}

function PipelineHarness() {
  const [context, setContext] = useState<PipelineContext | null>(null)
  const [rows, setRows] = useState<PipelineRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    loadPipelineContext()
      .then((loaded) => {
        setContext(loaded)
        // Receipt order: a resubmission has to see its parent, and a near-duplicate
        // has to see the invoice it duplicates.
        const ordered = [...loaded.invoices].sort((a, b) => {
          const byDate = String(a.invoice_date).localeCompare(String(b.invoice_date))
          return byDate !== 0 ? byDate : a.invoice_number.localeCompare(b.invoice_number)
        })
        setRows(ordered.map((invoice) => ({ invoice, status: 'idle' })))
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])

  const summary = useMemo(() => {
    const decided = rows.filter((row) => row.verdict)
    const agreed = decided.filter((row) => row.verdict === row.invoice.expected_verdict).length
    const byVerdict: Record<string, number> = {}
    for (const row of decided) byVerdict[row.verdict!] = (byVerdict[row.verdict!] ?? 0) + 1
    return {
      decided: decided.length,
      agreed,
      disagreed: decided.length - agreed,
      errors: rows.filter((row) => row.status === 'error').length,
      byVerdict,
    }
  }, [rows])

  async function runOne(index: number, explain: boolean): Promise<void> {
    const row = rows[index]
    setRows((previous) => previous.map((entry, i) => (i === index ? { ...entry, status: 'running' } : entry)))

    try {
      const outcome = await runInvoice(row.invoice.id, { context: context ?? undefined, explain })
      setRows((previous) =>
        previous.map((entry, i) =>
          i === index
            ? {
                ...entry,
                status: 'done',
                verdict: outcome.verdict,
                reasonCodes: outcome.reasonCodes,
                matchedPo: outcome.matchedPo,
                explanation: outcome.explanation,
                error: undefined,
              }
            : entry,
        ),
      )
    } catch (error) {
      setRows((previous) =>
        previous.map((entry, i) =>
          i === index
            ? { ...entry, status: 'error', error: error instanceof Error ? error.message : String(error) }
            : entry,
        ),
      )
    }
  }

  async function runAll(): Promise<void> {
    setRunning(true)
    setProgress({ done: 0, total: rows.length })
    // Prior runs are cleared first. Re-submitting a document unchanged is correctly
    // an exact duplicate, so without this every second pass would block.
    await resetDemoData()
    setRows((previous) => previous.map((row) => ({ invoice: row.invoice, status: 'idle' })))

    for (let index = 0; index < rows.length; index++) {
      await runOne(index, EXPLAIN_IN_BATCH)
      setProgress({ done: index + 1, total: rows.length })
    }

    setRunning(false)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Pipeline</CardTitle>
          <p className="text-muted-foreground mt-1 text-sm">
            Runs stages 1–7 for every invoice and compares the verdict against the fixture's{' '}
            <code>expected_verdict</code>. Extraction reads through the cache, so this makes no model calls; stage 7
            phrasing is skipped in the batch and falls back to the deterministic reason-code summary.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {progress && (
            <span className="text-muted-foreground text-sm">
              {running ? 'Running' : 'Done'} {progress.done} / {progress.total}
            </span>
          )}
          <Button onClick={() => setConfirmOpen(true)} disabled={running || rows.length === 0}>
            {running ? 'Running…' : `Run pipeline on all ${rows.length}`}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {loadError && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Could not load pipeline context: {loadError}
          </div>
        )}

        <div className="flex flex-wrap gap-8 text-sm">
          <div>
            <div className="text-muted-foreground">Decided</div>
            <div className="text-lg font-semibold">
              {summary.decided} / {rows.length}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Match expected</div>
            <div className="text-lg font-semibold">{summary.agreed}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Differ</div>
            <div className="text-lg font-semibold">{summary.disagreed}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Errors</div>
            <div className="text-lg font-semibold">{summary.errors}</div>
          </div>
          {Object.entries(summary.byVerdict).map(([verdict, count]) => (
            <div key={verdict}>
              <div className="text-muted-foreground">{verdict}</div>
              <div className="text-lg font-semibold">{count}</div>
            </div>
          ))}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Agrees</TableHead>
              <TableHead>Matched PO</TableHead>
              <TableHead>Reason codes</TableHead>
              <TableHead>Explanation</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground text-center">
                  {loadError ? 'Unavailable.' : 'Loading invoices…'}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, index) => {
              const agrees = row.verdict ? row.verdict === row.invoice.expected_verdict : null
              return (
                <TableRow key={row.invoice.id}>
                  <TableCell className="font-medium">
                    {row.invoice.invoice_number}
                    <div className="text-muted-foreground text-xs">{row.invoice.invoice_date}</div>
                  </TableCell>
                  <TableCell>
                    {row.status === 'idle' && <Badge variant="secondary">idle</Badge>}
                    {row.status === 'running' && <Badge variant="outline">running…</Badge>}
                    {row.status === 'done' && <Badge>done</Badge>}
                    {row.status === 'error' && (
                      <Badge variant="destructive" title={row.error}>
                        error
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <VerdictChip verdict={row.invoice.expected_verdict} />
                  </TableCell>
                  <TableCell>
                    <VerdictChip verdict={row.verdict} />
                  </TableCell>
                  <TableCell>
                    {agrees === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : agrees ? (
                      <span className="text-emerald-700 dark:text-emerald-300">yes</span>
                    ) : (
                      <span className="font-semibold text-red-700 dark:text-red-300">no</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{row.matchedPo ?? '—'}</TableCell>
                  <TableCell className="text-xs">
                    {row.reasonCodes?.length ? row.reasonCodes.join(', ') : '—'}
                  </TableCell>
                  <TableCell className="max-w-[28rem] text-xs" title={row.explanation}>
                    {row.explanation ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={running || row.status === 'running'}
                      onClick={() => void runOne(index, true)}
                      title="Re-runs this invoice with stage 7 enabled"
                    >
                      Re-run
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run the pipeline on all {rows.length} invoices?</DialogTitle>
            <DialogDescription>
              This deletes every existing run first. Resubmitting a document unchanged is correctly an exact
              duplicate, so a second pass over the same corpus would otherwise block everything it had already
              approved. No model calls are made: extraction reads the cache and stage 7 falls back to the
              deterministic summary.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false)
                void runAll()
              }}
            >
              Clear runs and go
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default PipelineHarness
