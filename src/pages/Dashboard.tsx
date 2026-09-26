// Every run, and what the numbers say about them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronUp } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  Loading,
  OutcomeChip,
  PageBody,
  Panel,
  PanelHeading,
  Statistic,
} from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { count, duration, money, percent, shortDate } from '@/lib/format.ts'
import {
  approvedByPerson,
  effectiveVerdict,
  hasFailed,
  loadFeed,
  matchesSearch,
  sortRows,
  vendorNameFor,
  wasUploaded,
  type FeedRow,
  type SortDirection,
  type SortKey,
} from '@/lib/feed.ts'
import { getExtractionDurations } from '@/lib/queries.ts'
import {
  APPROVED_BY_PERSON_LABEL,
  duplicateOfSentence,
  FAILED_RUN_SENTENCE,
  reasonSentence,
  runFailureSentence,
  VERDICT_LABEL,
  verdictTone,
} from '@/lib/reasonCopy.ts'
import { DECISION_RULES } from '@/rules/decide.ts'
import type { Verdict } from '@/lib/database.types.ts'

// Each bar takes the colour of the verdict its code produces, because colour in
// this product means a verdict and nothing else. A code the table does not select
// a verdict for stays neutral rather than borrowing one.
const VERDICT_BY_CODE = new Map<string, Verdict>(
  DECISION_RULES.flatMap((row) => (row.verdict ? [[row.code, row.verdict] as const] : [])),
)

// Outcomes, then the two things that are not outcomes: a run that never reached
// one, and how the document arrived. Both are filters on the same list rather than
// sections of their own, because an uploaded invoice is an invoice.
type InvoiceFilter = Verdict | 'all' | 'failed' | 'uploaded' | 'overridden'

const FILTERS: { value: InvoiceFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'AUTO_APPROVE', label: VERDICT_LABEL.AUTO_APPROVE },
  { value: 'REVIEW', label: VERDICT_LABEL.REVIEW },
  { value: 'HOLD', label: VERDICT_LABEL.HOLD },
  { value: 'BLOCK', label: VERDICT_LABEL.BLOCK },
  { value: 'ROUTED_NOT_PAID', label: VERDICT_LABEL.ROUTED_NOT_PAID },
  { value: 'failed', label: 'Failed' },
  { value: 'uploaded', label: 'Uploaded' },
  // Every invoice a person passed over the rules, in one list. Without it the only
  // way to audit human approvals was to open each invoice and look.
  { value: 'overridden', label: APPROVED_BY_PERSON_LABEL },
]

/**
 * The line under an invoice number in the list.
 *
 * A failed run says why it failed, from the sentence the run recorded, which for an
 * extraction is the edge function's own account of what it tried. It used to read
 * "The file could not be read." whatever had actually happened, which told a person
 * nothing they could act on. The cell truncates, so the same text is the tooltip.
 */
function rowNote(row: FeedRow): string {
  if (hasFailed(row.run)) return runFailureSentence(row.run.explanation) ?? FAILED_RUN_SENTENCE
  if (row.duplicateOf) {
    return duplicateOfSentence(
      row.duplicateOf.invoiceNumber,
      shortDate(row.duplicateOf.decidedAt ?? row.run.started_at),
    )
  }
  return row.primaryCode ? reasonSentence(row.primaryCode) : FAILED_RUN_SENTENCE
}

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
  const [filter, setFilter] = useState<InvoiceFilter>('all')
  const [readDurations, setReadDurations] = useState<number[]>([])
  const [vendorFilter, setVendorFilter] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'date', direction: 'desc' })

  // Who approved it and when replace the invoice date while that filter is on:
  // those are the two facts the list exists to show, and the date is already on
  // every other view of the same row.
  const showApprover = filter === 'overridden'

  const load = useCallback(async () => {
    try {
      const [feed, durations] = await Promise.all([loadFeed(), getExtractionDurations()])
      setRows(feed.rows)
      setReadDurations(durations)
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

  // How long reading a page actually takes, measured from the extract stage rather
  // than assumed. A cost per document would need the token counts and the price
  // list, and neither is recorded, so this reports the thing that is.
  const medianReadMs = useMemo(
    () => median(readDurations.filter((value) => Number.isFinite(value))),
    [readDurations],
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

  const vendorOptions = useMemo(
    () => [...new Set((rows ?? []).map(vendorNameFor))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const visible = useMemo(() => {
    const matched = (rows ?? []).filter((row) => {
      if (!matchesSearch(row, search)) return false
      if (filter === 'failed' && !hasFailed(row.run)) return false
      if (filter === 'uploaded' && !wasUploaded(row)) return false
      if (filter === 'overridden' && !approvedByPerson(row.run)) return false
      // Verdict filters read the outcome, so an invoice a person approved is found
      // under Approved rather than under whatever the rules had decided.
      if (
        filter !== 'all' &&
        filter !== 'failed' &&
        filter !== 'uploaded' &&
        filter !== 'overridden' &&
        effectiveVerdict(row.run) !== filter
      ) {
        return false
      }
      if (vendorFilter !== 'all' && vendorNameFor(row) !== vendorFilter) return false
      const date = row.invoice?.invoice_date ?? ''
      if (fromDate && date < fromDate) return false
      if (toDate && date > toDate) return false
      return true
    })
    return sortRows(matched, sort.key, sort.direction)
  }, [rows, filter, search, vendorFilter, fromDate, toDate, sort])

  // Clicking a heading sorts by it, and clicking it again turns the order around.
  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        // Most recent, or largest, first. Those are the orders a person means when
        // they click a heading like this for the first time.
        : { key, direction: key === 'amount' || key === 'date' || key === 'approved' ? 'desc' : 'asc' },
    )

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-ink">Invoices</h1>
          <div>
            <label htmlFor="runs-search" className="sr-only">
              Search invoices and vendors
            </label>
            <input
              id="runs-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search invoices and vendors"
              className="h-9 w-64 rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
            />
          </div>
        </div>

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
            label="Reading time per document"
            value={medianReadMs != null ? duration(medianReadMs) : 'No data yet'}
            note="How long the model spends on a page, at the median"
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

            <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-2.5">
              <label htmlFor="runs-vendor" className="text-xs text-muted">
                Vendor
              </label>
              <select
                id="runs-vendor"
                value={vendorFilter}
                onChange={(event) => setVendorFilter(event.target.value)}
                className="h-8 max-w-[14rem] rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="all">Every vendor</option>
                {vendorOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              <label htmlFor="runs-from" className="ml-2 text-xs text-muted">
                Dated from
              </label>
              <input
                id="runs-from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              />
              <label htmlFor="runs-to" className="text-xs text-muted">
                to
              </label>
              <input
                id="runs-to"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              />
            </div>

            {rows === null ? (
              <Loading>Loading the invoices</Loading>
            ) : visible.length === 0 ? (
              <EmptyState>
                No invoice matches these filters. Widen them, or clear the search.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[820px]">
                  <div
                    className={cn(
                      'grid gap-4 border-b border-line-soft px-5 py-1.5',
                      showApprover
                        ? 'grid-cols-[7rem_minmax(0,1fr)_10rem_7rem_9rem_7rem]'
                        : 'grid-cols-[7rem_minmax(0,1fr)_12rem_8rem_7rem]',
                    )}
                  >
                    {(
                      (showApprover
                        ? [
                            ['outcome', 'Outcome', 'left'],
                            ['invoice', 'Invoice', 'left'],
                            ['vendor', 'Vendor', 'left'],
                            ['amount', 'Amount', 'right'],
                            ['approver', 'Approved by', 'left'],
                            ['approved', 'Approved on', 'right'],
                          ]
                        : [
                            ['outcome', 'Outcome', 'left'],
                            ['invoice', 'Invoice', 'left'],
                            ['vendor', 'Vendor', 'left'],
                            ['amount', 'Amount', 'right'],
                            ['date', 'Date', 'right'],
                          ]) as [SortKey, string, 'left' | 'right'][]
                    ).map(([key, label, align]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleSort(key)}
                        aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={cn(
                          'flex items-center gap-1 text-[11px] tracking-wide transition-colors hover:text-ink',
                          align === 'right' && 'justify-end',
                          sort.key === key ? 'text-ink' : 'text-faint',
                        )}
                      >
                        {label}
                        {sort.key === key ? (
                          <ChevronUp
                            className={cn('size-3', sort.direction === 'desc' && 'rotate-180')}
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    ))}
                  </div>

                  <ul>
                    {visible.map((row) => (
                      <li key={row.run.id} className="border-b border-line-soft last:border-0">
                        <Link
                          to={`/decisions/${row.run.id}`}
                          className={cn(
                            'grid items-start gap-4 px-5 py-3.5 transition-colors hover:bg-line-soft/60',
                            showApprover
                              ? 'grid-cols-[7rem_minmax(0,1fr)_10rem_7rem_9rem_7rem]'
                              : 'grid-cols-[7rem_minmax(0,1fr)_12rem_8rem_7rem]',
                          )}
                        >
                          <OutcomeChip run={row.run} size="sm" />
                          <span className="min-w-0">
                            <span className="identifier block text-sm text-ink">
                              {row.invoice?.invoice_number ?? 'Not read yet'}
                            </span>
                            <span className="mt-0.5 block truncate text-sm text-muted" title={rowNote(row)}>
                              {rowNote(row)}
                            </span>
                          </span>
                          <span className="truncate text-sm text-ink-soft">{vendorNameFor(row)}</span>
                          <span className="text-right text-sm text-ink tnum">
                            {money(row.invoice?.total, row.invoice?.currency ?? 'INR')}
                          </span>
                          {showApprover ? (
                            <>
                              <span className="truncate text-sm text-ink-soft" title={row.run.touched_by ?? undefined}>
                                {row.run.touched_by ?? 'Not recorded'}
                              </span>
                              <span className="text-right text-sm text-muted tnum">
                                {row.run.approved_at ? shortDate(row.run.approved_at) : 'Not recorded'}
                              </span>
                            </>
                          ) : (
                            <span className="text-right text-sm text-muted tnum">
                              {shortDate(row.invoice?.invoice_date)}
                            </span>
                          )}
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
      </PageBody>
    </AppShell>
  )
}
