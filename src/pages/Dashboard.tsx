// Every run, and what the numbers say about them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  Loading,
  Panel,
  PanelHeading,
  Statistic,
  VerdictChip,
} from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { count, duration, money, percent, shortDate } from '@/lib/format.ts'
import { loadFeed, matchesSearch, vendorNameFor, type FeedRow } from '@/lib/feed.ts'
import { reasonSentence, VERDICT_LABEL, verdictTone } from '@/lib/reasonCopy.ts'
import { DECISION_RULES } from '@/rules/decide.ts'
import type { Verdict } from '@/lib/database.types.ts'

// Each bar takes the colour of the verdict its code produces, because colour in
// this product means a verdict and nothing else. A code the table does not select
// a verdict for stays neutral rather than borrowing one.
const VERDICT_BY_CODE = new Map<string, Verdict>(
  DECISION_RULES.flatMap((row) => (row.verdict ? [[row.code, row.verdict] as const] : [])),
)

// What one document costs to put through: one extraction call and one explanation
// call. Published list prices, recorded here so the figure on screen can be traced
// to something rather than appearing from nowhere.
const COST_PER_DOCUMENT_INR = 1.6

const FILTERS: { value: Verdict | 'all'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'AUTO_APPROVE', label: VERDICT_LABEL.AUTO_APPROVE },
  { value: 'REVIEW', label: VERDICT_LABEL.REVIEW },
  { value: 'HOLD', label: VERDICT_LABEL.HOLD },
  { value: 'BLOCK', label: VERDICT_LABEL.BLOCK },
  { value: 'ROUTED_NOT_PAID', label: VERDICT_LABEL.ROUTED_NOT_PAID },
]

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export default function Dashboard() {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Verdict | 'all'>('all')

  const load = useCallback(async () => {
    try {
      const feed = await loadFeed()
      setRows(feed.rows)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The runs could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const decided = useMemo(() => (rows ?? []).filter((row) => row.run.status === 'complete'), [rows])

  const approvedWithoutReview = decided.filter((row) => row.run.verdict === 'AUTO_APPROVE').length

  const medianMs = useMemo(
    () =>
      median(
        decided
          .map((row) =>
            row.run.finished_at ? new Date(row.run.finished_at).getTime() - new Date(row.run.started_at).getTime() : null,
          )
          .filter((value): value is number => value !== null && Number.isFinite(value)),
      ),
    [decided],
  )

  // Value that never reached a payment file: everything blocked, held or sent for
  // review before anyone could pay it.
  const valueStopped = decided
    .filter((row) => row.run.verdict === 'BLOCK' || row.run.verdict === 'HOLD' || row.run.verdict === 'REVIEW')
    .reduce((sum, row) => sum + (row.invoice?.total ?? 0), 0)

  // Why documents stopped, most frequent first. Every reason code carried on a run
  // that did not approve counts once.
  const stoppedBy = useMemo(() => {
    const tally = new Map<string, number>()
    for (const row of decided) {
      if (row.run.verdict === 'AUTO_APPROVE') continue
      for (const code of row.run.reason_codes ?? []) {
        tally.set(code, (tally.get(code) ?? 0) + 1)
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])
  }, [decided])

  const mostFrequent = stoppedBy[0]?.[1] ?? 1

  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (row) => (filter === 'all' || row.run.verdict === filter) && matchesSearch(row, search),
      ),
    [rows, filter, search],
  )

  return (
    <AppShell search={search} onSearchChange={setSearch}>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-ink">All runs</h1>

        {error ? (
          <ErrorNote title="The runs could not be loaded">
            {error} Check the connection to the database, then reload the page.
          </ErrorNote>
        ) : null}

        <Panel className="grid gap-8 px-6 py-6 sm:grid-cols-2 lg:grid-cols-4">
          <Statistic
            label="Approved without review"
            value={decided.length > 0 ? percent(approvedWithoutReview / decided.length) : 'No data yet'}
            note={`${count(approvedWithoutReview)} of ${count(decided.length)} invoices`}
          />
          <Statistic
            label="Median time to decision"
            value={medianMs != null ? duration(medianMs) : 'No data yet'}
            note="From receiving the document to a verdict"
          />
          <Statistic
            label="Cost per document"
            value={money(COST_PER_DOCUMENT_INR)}
            note="Reading the page, and writing the explanation"
          />
          <Statistic
            label="Value stopped before payment"
            value={money(valueStopped)}
            note="Held, blocked or sent for review"
          />
        </Panel>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel>
            <PanelHeading right={<span className="text-xs text-muted">{count(visible.length)} shown</span>}>
              Runs
            </PanelHeading>

            <div className="flex flex-wrap gap-2 border-b border-line-soft px-5 py-3">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  aria-pressed={filter === option.value}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    filter === option.value
                      ? 'border-ink-soft bg-line-soft font-medium text-ink'
                      : 'border-line text-muted hover:text-ink',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {rows === null ? (
              <Loading>Loading the runs</Loading>
            ) : visible.length === 0 ? (
              <EmptyState>
                No run matches these filters. Choose a different outcome, or clear the search.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[820px]">
                  <div
                    className="grid grid-cols-[7rem_minmax(0,1fr)_12rem_8rem_7rem] gap-4 border-b border-line-soft px-5 py-2.5 text-xs font-medium text-muted"
                    aria-hidden="true"
                  >
                    <span>Outcome</span>
                    <span>Invoice</span>
                    <span>Vendor</span>
                    <span className="text-right">Amount</span>
                    <span className="text-right">Date</span>
                  </div>

                  <ul>
                    {visible.map((row) => (
                      <li key={row.run.id} className="border-b border-line-soft last:border-0">
                        <Link
                          to={`/decisions/${row.run.id}`}
                          className="grid grid-cols-[7rem_minmax(0,1fr)_12rem_8rem_7rem] items-start gap-4 px-5 py-3.5 transition-colors hover:bg-line-soft/60"
                        >
                          <VerdictChip verdict={row.run.verdict} size="sm" />
                          <span className="min-w-0">
                            <span className="identifier block text-sm text-ink">
                              {row.invoice?.invoice_number ?? 'Not read yet'}
                            </span>
                            <span className="mt-0.5 block truncate text-sm text-muted">
                              {row.primaryCode ? reasonSentence(row.primaryCode) : 'No reason was recorded.'}
                            </span>
                          </span>
                          <span className="truncate text-sm text-ink-soft">{vendorNameFor(row)}</span>
                          <span className="text-right text-sm text-ink tnum">
                            {money(row.invoice?.total, row.invoice?.currency ?? 'INR')}
                          </span>
                          <span className="text-right text-sm text-muted tnum">
                            {shortDate(row.invoice?.invoice_date)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeading>Why invoices stopped</PanelHeading>
            {rows === null ? (
              <Loading>Loading</Loading>
            ) : stoppedBy.length === 0 ? (
              <EmptyState>Nothing has stopped yet. Run some invoices to see what they catch.</EmptyState>
            ) : (
              <ul className="space-y-3.5 px-5 py-4">
                {stoppedBy.map(([code, total]) => (
                  <li key={code}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-ink-soft">{reasonSentence(code)}</span>
                      <span className="shrink-0 text-sm font-medium text-ink tnum">{count(total)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                      <div
                        className={VERDICT_BY_CODE.has(code) ? tone(verdictTone(VERDICT_BY_CODE.get(code))).fill : 'bg-line'}
                        style={{ width: `${(total / mostFrequent) * 100}%`, height: '100%' }}
                      />
                    </div>
                    <p className="identifier mt-1 text-xs text-muted">{code}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  )
}
