import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { extractInvoice } from '@/lib/extraction.ts'
import type { ExtractionResult } from '@/lib/extractionSchema.ts'
import { getInvoices } from '@/lib/queries.ts'
import type { InvoiceRow } from '@/lib/database.types.ts'
import { cn } from '@/lib/utils'

// Free tier is roughly 15 requests/minute — a burst of 27 will throttle, so runs are
// sequential with a delay between calls rather than parallel.
const REQUEST_DELAY_MS = 4500

type RunStatus = 'idle' | 'running' | 'success' | 'error'
type CellStatus = 'match' | 'mismatch' | 'expected-null'

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
  durationMs?: number
  error?: string
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

function compareCell(extracted: unknown, expected: unknown): CellStatus {
  const e = expected === undefined ? null : expected
  const x = extracted === undefined ? null : extracted

  if (e === null && x === null) return 'expected-null'
  if (typeof e === 'number' && typeof x === 'number') {
    return Math.abs(e - x) < 0.01 ? 'match' : 'mismatch'
  }
  return String(e) === String(x) ? 'match' : 'mismatch'
}

const CELL_STYLES: Record<CellStatus, string> = {
  match: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  mismatch: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
  'expected-null': 'bg-muted text-muted-foreground',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ExtractionHarness() {
  const [rows, setRows] = useState<HarnessRow[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    getInvoices()
      .then((invoices) => {
        setRows(
          invoices.map((invoice) => ({
            invoice,
            pdfUrl: pdfUrlFor(invoice),
            status: 'idle',
          })),
        )
      })
      .finally(() => setLoading(false))
  }, [])

  const summary = useMemo(() => {
    let matches = 0
    let mismatches = 0
    let expectedNulls = 0

    for (const row of rows) {
      if (!row.result) continue
      for (const field of COMPARE_FIELDS) {
        const status = compareCell(row.result[field.key], row.invoice[field.expectedKey])
        if (status === 'match') matches++
        else if (status === 'mismatch') mismatches++
        else expectedNulls++
      }
    }

    const total = matches + mismatches + expectedNulls
    const accuracy = total > 0 ? ((matches + expectedNulls) / total) * 100 : 0
    return { matches, mismatches, expectedNulls, total, accuracy }
  }, [rows])

  async function runAll() {
    setRunning(true)
    setProgress({ done: 0, total: rows.length })

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'running' } : r)))

      try {
        const outcome = await extractInvoice(row.pdfUrl, row.invoice.invoice_number)
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? {
                  ...r,
                  status: 'success',
                  result: outcome.data,
                  model: outcome.model,
                  durationMs: outcome.duration_ms,
                  error: undefined,
                }
              : r,
          ),
        )
      } catch (err) {
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: 'error', error: err instanceof Error ? err.message : String(err) } : r,
          ),
        )
      }

      setProgress({ done: i + 1, total: rows.length })
      if (i < rows.length - 1) await sleep(REQUEST_DELAY_MS)
    }

    setRunning(false)
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Extraction Harness</h1>
          <p className="text-muted-foreground text-sm">
            Dev tool — runs Gemini extraction against all fixture invoices and compares the result to the fixture
            truth stored in the invoices table.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {progress && (
            <span className="text-muted-foreground text-sm">
              {running ? 'Running' : 'Done'} {progress.done} / {progress.total}
            </span>
          )}
          <Button onClick={runAll} disabled={running || loading || rows.length === 0}>
            {running ? 'Running…' : 'Run all 27'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-8 text-sm">
          <div>
            <div className="text-muted-foreground">Fields compared</div>
            <div className="text-lg font-semibold">{summary.total}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Matches</div>
            <div className="text-lg font-semibold">{summary.matches + summary.expectedNulls}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Mismatches</div>
            <div className="text-lg font-semibold">{summary.mismatches}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Accuracy</div>
            <div className="text-lg font-semibold">{summary.total > 0 ? `${summary.accuracy.toFixed(1)}%` : '—'}</div>
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
            <TableHead>Duration</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Raw</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow>
              <TableCell colSpan={COMPARE_FIELDS.length + 5} className="text-muted-foreground text-center">
                Loading invoices…
              </TableCell>
            </TableRow>
          )}
          {!loading && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={COMPARE_FIELDS.length + 5} className="text-muted-foreground text-center">
                No invoices found.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
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
                const status = compareCell(extracted, expected)
                return (
                  <TableCell key={field.key} className={cn(CELL_STYLES[status])} title={`expected: ${formatValue(expected)}`}>
                    {formatValue(extracted)}
                  </TableCell>
                )
              })}
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export default ExtractionHarness
