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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getCurrentExtractions, getOrExtract, providerForModel } from '@/lib/extraction.ts'
import type { ExtractionProviderName, ExtractionResult } from '@/lib/extractionSchema.ts'
import { getInvoices } from '@/lib/queries.ts'
import type { InvoiceRow } from '@/lib/database.types.ts'
import { cn } from '@/lib/utils'

// Free tier is roughly 15 requests/minute — a burst of 27 will throttle, so live
// calls are paced with a delay between them rather than fired in parallel. Cache
// hits skip this delay entirely, since they never touch the network.
const REQUEST_DELAY_MS = 4500

// Gemini free tier: 20 requests/day on this account.
const DAILY_QUOTA = 20

type RunStatus = 'idle' | 'running' | 'success' | 'error'
type CellStatus = 'match' | 'correct-abstain' | 'mismatch'

interface CompareField {
  key: keyof ExtractionResult
  expectedKey: keyof InvoiceRow
  label: string
}

const COMPARE_FIELDS: CompareField[] = [
  { key: 'invoice_number', expectedKey: 'invoice_number', label: 'Invoice #' },
  { key: 'invoice_date', expectedKey: 'invoice_date', label: 'Date' },
  { key: 'po_reference', expectedKey: 'po_reference', label: 'PO Ref' },
  { key: 'subtotal', expectedKey: 'subtotal', label: 'Subtotal' },
  { key: 'tax', expectedKey: 'tax', label: 'Tax' },
  { key: 'total', expectedKey: 'total', label: 'Total' },
  { key: 'bank_account', expectedKey: 'bank_account_printed', label: 'Bank A/C' },
  { key: 'remit_to_name', expectedKey: 'remit_to_name', label: 'Remit To' },
  { key: 'document_type', expectedKey: 'document_type', label: 'Doc Type' },
]

interface HarnessRow {
  invoice: InvoiceRow
  pdfUrl: string
  status: RunStatus
  result?: ExtractionResult
  model?: string
  durationMs?: number | null
  fromCache?: boolean
  extractedAt?: string
  // Whether this invoice has a current (is_current=true) cached extraction —
  // distinct from `fromCache`, since a `?provider=` test run never touches the
  // primary cache. Drives the quota guard's "invoices lacking a current
  // extraction" count.
  hasCurrentExtraction: boolean
  error?: string
}

interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
}

function pdfUrlFor(invoice: InvoiceRow): string {
  const filename = invoice.file_path?.split('/').pop() ?? `${invoice.invoice_number}.pdf`
  return `/invoices/${filename}`
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') return value.toLocaleString('en-IN')
  return String(value)
}

function compareCell(field: CompareField, extracted: unknown, expected: unknown, fieldsNotPrinted: string[] | null): CellStatus {
  const x = extracted === undefined ? null : extracted

  // A field the source document never printed: null is the correct (forbidden-
  // to-derive) answer, and any non-null value means the model derived something
  // it was told not to — a genuine prompt failure, never scored as correct.
  if (fieldsNotPrinted?.includes(field.key)) {
    return x === null ? 'correct-abstain' : 'mismatch'
  }

  const e = expected === undefined ? null : expected
  if (typeof e === 'number' && typeof x === 'number') {
    return Math.abs(e - x) < 0.01 ? 'match' : 'mismatch'
  }
  return String(e) === String(x) ? 'match' : 'mismatch'
}

const CELL_STYLES: Record<CellStatus, string> = {
  match: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  mismatch: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
  'correct-abstain': 'bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ExtractionHarness() {
  const [rows, setRows] = useState<HarnessRow[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [forcedProvider] = useState<ExtractionProviderName | null>(() => {
    const requested = new URLSearchParams(window.location.search).get('provider')
    if (requested === 'gemini' || requested === 'anthropic') return requested
    if (requested) console.warn(`Ignoring unknown ?provider=${requested} — expected "gemini" or "anthropic"`)
    return null
  })

  useEffect(() => {
    Promise.all([getInvoices(), getCurrentExtractions()])
      .then(([invoices, currentExtractions]) => {
        setRows(
          invoices.map((invoice) => {
            const cached = currentExtractions.get(invoice.id)
            return {
              invoice,
              pdfUrl: pdfUrlFor(invoice),
              status: cached ? 'success' : 'idle',
              result: cached ? (cached.extracted_data as unknown as ExtractionResult) : undefined,
              model: cached?.model,
              durationMs: cached?.duration_ms,
              fromCache: cached ? true : undefined,
              extractedAt: cached?.created_at,
              hasCurrentExtraction: !!cached,
            }
          }),
        )
      })
      .finally(() => setLoading(false))
  }, [])

  const summary = useMemo(() => {
    let matches = 0
    let correctAbstentions = 0
    let mismatches = 0

    for (const row of rows) {
      if (!row.result) continue
      for (const field of COMPARE_FIELDS) {
        const status = compareCell(
          field,
          row.result[field.key],
          row.invoice[field.expectedKey],
          row.invoice.fields_not_printed,
        )
        if (status === 'match') matches++
        else if (status === 'correct-abstain') correctAbstentions++
        else mismatches++
      }
    }

    const total = matches + correctAbstentions + mismatches
    const accuracy = total > 0 ? ((matches + correctAbstentions) / total) * 100 : 0
    return { matches, correctAbstentions, mismatches, total, accuracy }
  }, [rows])

  const missingCount = rows.filter((r) => !r.hasCurrentExtraction).length

  // Runs (or re-runs) extraction for one row. Returns true if a live call was
  // made, so callers can decide whether to pace the next request.
  async function runRow(idx: number, opts: { force?: boolean } = {}): Promise<boolean> {
    const row = rows[idx]
    const touchesCurrentCache = !forcedProvider

    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, status: 'running' } : r)))

    try {
      const outcome = await getOrExtract(row.invoice.id, row.pdfUrl, row.invoice.invoice_number, {
        force: opts.force,
        provider: forcedProvider ?? undefined,
      })
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx
            ? {
                ...r,
                status: 'success',
                result: outcome.data,
                model: outcome.model,
                durationMs: outcome.duration_ms,
                fromCache: outcome.fromCache,
                extractedAt: outcome.extractedAt,
                hasCurrentExtraction: touchesCurrentCache ? true : r.hasCurrentExtraction,
                error: undefined,
              }
            : r,
        ),
      )
      return !outcome.fromCache
    } catch (err) {
      setRows((prev) =>
        prev.map((r, i) =>
          i === idx ? { ...r, status: 'error', error: err instanceof Error ? err.message : String(err) } : r,
        ),
      )
      return true
    }
  }

  async function runAll() {
    setRunning(true)
    setProgress({ done: 0, total: rows.length })

    for (let i = 0; i < rows.length; i++) {
      const madeLiveCall = await runRow(i, { force: false })
      setProgress({ done: i + 1, total: rows.length })
      if (madeLiveCall && i < rows.length - 1) await sleep(REQUEST_DELAY_MS)
    }

    setRunning(false)
  }

  async function forceReExtractAll() {
    setRunning(true)
    setProgress({ done: 0, total: rows.length })

    for (let i = 0; i < rows.length; i++) {
      await runRow(i, { force: true })
      setProgress({ done: i + 1, total: rows.length })
      if (i < rows.length - 1) await sleep(REQUEST_DELAY_MS)
    }

    setRunning(false)
  }

  function handleRunAllClick() {
    if (missingCount > DAILY_QUOTA) {
      setConfirm({
        title: 'This run may exceed today’s quota',
        description: `${missingCount} of ${rows.length} invoices don’t have a cached extraction yet. Extracting them would make up to ${missingCount} live calls against a ${DAILY_QUOTA}-per-day quota.`,
        confirmLabel: 'Run anyway',
        onConfirm: () => void runAll(),
      })
      return
    }
    void runAll()
  }

  function handleForceReExtractAllClick() {
    setConfirm({
      title: 'Force re-extract all 27 invoices?',
      description: `This bypasses the cache for every invoice and makes ${rows.length} live calls${
        forcedProvider ? ` against ${forcedProvider}` : ''
      } — a full day’s quota (${DAILY_QUOTA}/day) in one run.`,
      confirmLabel: 'Force re-extract all',
      destructive: true,
      onConfirm: () => void forceReExtractAll(),
    })
  }

  return (
    <div className="mx-auto flex max-w-[1700px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Extraction Harness</h1>
          <p className="text-muted-foreground text-sm">
            Dev tool — runs extraction against all fixture invoices and compares the result to the fixture truth
            stored in the invoices table. Results are cached; re-running only extracts what's missing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {progress && (
            <span className="text-muted-foreground text-sm">
              {running ? 'Running' : 'Done'} {progress.done} / {progress.total}
            </span>
          )}
          <Button variant="destructive" onClick={handleForceReExtractAllClick} disabled={running || loading || rows.length === 0}>
            Force re-extract all
          </Button>
          <Button onClick={handleRunAllClick} disabled={running || loading || rows.length === 0}>
            {running ? 'Running…' : 'Run all 27'}
          </Button>
        </div>
      </div>

      {forcedProvider && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Testing mode — <code>?provider={forcedProvider}</code> forces every extraction in this session through{' '}
          <strong>{forcedProvider}</strong> only, bypassing the fallback chain and the cache. Results here are
          recorded for history but never replace an invoice's primary cached extraction.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-8 text-sm">
          <div>
            <div className="text-muted-foreground">Fields compared</div>
            <div className="text-lg font-semibold">{summary.total}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Matches</div>
            <div className="text-lg font-semibold">{summary.matches}</div>
          </div>
          <div>
            <div className="text-muted-foreground" title="Field not printed on the document; correctly returned null">
              Correct abstentions
            </div>
            <div className="text-lg font-semibold">{summary.correctAbstentions}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Mismatches</div>
            <div className="text-lg font-semibold">{summary.mismatches}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Accuracy</div>
            <div className="text-lg font-semibold">{summary.total > 0 ? `${summary.accuracy.toFixed(1)}%` : '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Missing cache</div>
            <div className="text-lg font-semibold">
              {missingCount} / {rows.length}
            </div>
          </div>
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Status</TableHead>
            {COMPARE_FIELDS.map((field) => (
              <TableHead key={field.key}>{field.label}</TableHead>
            ))}
            <TableHead>Cache</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Raw</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow>
              <TableCell colSpan={COMPARE_FIELDS.length + 8} className="text-muted-foreground text-center">
                Loading invoices…
              </TableCell>
            </TableRow>
          )}
          {!loading && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={COMPARE_FIELDS.length + 8} className="text-muted-foreground text-center">
                No invoices found.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row, idx) => (
            <TableRow key={`${row.invoice.id}-${row.pdfUrl}`}>
              <TableCell className="font-medium">
                {row.invoice.invoice_number}
                <div className="text-muted-foreground text-xs">{row.pdfUrl}</div>
              </TableCell>
              <TableCell>
                {row.status === 'idle' && <Badge variant="secondary">idle</Badge>}
                {row.status === 'running' && <Badge variant="outline">running…</Badge>}
                {row.status === 'success' && <Badge>done</Badge>}
                {row.status === 'error' && (
                  <Badge variant="destructive" title={row.error}>
                    error
                  </Badge>
                )}
              </TableCell>
              {COMPARE_FIELDS.map((field) => {
                if (!row.result) {
                  return (
                    <TableCell key={field.key} className="text-muted-foreground">
                      —
                    </TableCell>
                  )
                }
                const extracted = row.result[field.key]
                const expected = row.invoice[field.expectedKey]
                const status = compareCell(field, extracted, expected, row.invoice.fields_not_printed)
                const title = status === 'correct-abstain' ? 'not printed on document' : `expected: ${formatValue(expected)}`
                return (
                  <TableCell key={field.key} className={cn(CELL_STYLES[status])} title={title}>
                    {formatValue(extracted)}
                  </TableCell>
                )
              })}
              <TableCell>
                {row.status === 'success' && (
                  <Badge
                    variant={row.fromCache ? 'outline' : 'secondary'}
                    title={row.extractedAt ? new Date(row.extractedAt).toLocaleString() : undefined}
                  >
                    {row.fromCache ? 'cached' : 'live'}
                  </Badge>
                )}
                {row.extractedAt && (
                  <div className="text-muted-foreground mt-1 text-xs">{new Date(row.extractedAt).toLocaleString()}</div>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {row.model ? providerForModel(row.model) : '—'}
              </TableCell>
              <TableCell>{row.durationMs != null ? `${row.durationMs}ms` : '—'}</TableCell>
              <TableCell>{row.model ?? '—'}</TableCell>
              <TableCell>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={!row.result}>
                      View JSON
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>{row.invoice.invoice_number} — raw extraction</DialogTitle>
                    </DialogHeader>
                    <pre className="bg-muted overflow-x-auto rounded-md p-4 text-xs">
                      {JSON.stringify(row.result, null, 2)}
                    </pre>
                  </DialogContent>
                </Dialog>
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={running || row.status === 'running'}
                  onClick={() => void runRow(idx, { force: true })}
                >
                  Re-extract
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle>{confirm.title}</DialogTitle>
                <DialogDescription>{confirm.description}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant={confirm.destructive ? 'destructive' : 'default'}
                  onClick={() => {
                    const action = confirm.onConfirm
                    setConfirm(null)
                    action()
                  }}
                >
                  {confirm.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ExtractionHarness
