// The exceptions, and the one you are looking at, side by side.
//
// A finance manager works a list. Choosing a row changes the pane on the right and
// nothing else: no navigation, no scroll position lost, no wait.
//
// Selection is keyed on the run, not on the invoice number. Numbers repeat, both
// across a resubmission and its original and across every copy of a file somebody
// forwards twice, and keying on the number highlighted both and opened neither.
// The URL keeps the number so a link still reads as something, and adds the run so
// it points at one record.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { DecisionDetail, type DecisionDetailHandle } from '@/components/DecisionDetail.tsx'
import { Explainer } from '@/components/Explainer.tsx'
import { ProportionBar } from '@/components/ProportionBar.tsx'
import { EmptyState, ErrorNote, Loading, OutcomeChip, Spinner } from '@/components/Primitives.tsx'
import { useUpload } from '@/components/uploadContext.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count, money, waitingSince } from '@/lib/format.ts'
import {
  countByVerdict,
  loadFeed,
  matchesSearch,
  needsAPerson,
  rowForShortId,
  shortRunId,
  sortRows,
  vendorNameFor,
  type FeedRow,
  type SortKey,
} from '@/lib/feed.ts'
import { dismissExplainer, explainerDismissed } from '@/lib/localSettings.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { getInvoicesWithoutCompletedRun } from '@/lib/queries.ts'
import { VERDICT_LABEL } from '@/lib/reasonCopy.ts'
import type { Verdict } from '@/lib/database.types.ts'

type OutcomeFilter = Verdict | 'all'

// The three verdicts that put a document in front of a person. A run that failed
// is not among them: nothing was decided about it, so there is no exception to
// work. Those live on Invoices under the Failed filter, where they can be removed.
const OUTCOMES: { value: OutcomeFilter; label: string }[] = [
  { value: 'all', label: 'Every outcome' },
  { value: 'REVIEW', label: VERDICT_LABEL.REVIEW },
  { value: 'HOLD', label: VERDICT_LABEL.HOLD },
  { value: 'BLOCK', label: VERDICT_LABEL.BLOCK },
]

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'age', label: 'Oldest first' },
  { value: 'amount', label: 'Largest amount' },
]

export default function Exceptions() {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [vendorFilter, setVendorFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey>('age')
  const [explainerOpen, setExplainerOpen] = useState(() => !explainerDismissed())
  const [fetching, setFetching] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const { openUpload, finishedAt } = useUpload()
  const detail = useRef<DecisionDetailHandle | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const load = useCallback(async () => {
    try {
      const feed = await loadFeed()
      setRows(feed.rows)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The list could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, finishedAt])

  const queue = useMemo(() => {
    const open = (rows ?? []).filter((row) => needsAPerson(row.run) && matchesSearch(row, search))
    const byOutcome = open.filter((row) => outcome === 'all' || row.run.verdict === outcome)
    const byVendor =
      vendorFilter === 'all' ? byOutcome : byOutcome.filter((row) => vendorNameFor(row) === vendorFilter)
    // Oldest first means the smallest start time first; largest amount means the
    // biggest number first.
    return sortRows(byVendor, sortKey, sortKey === 'amount' ? 'desc' : 'asc')
  }, [rows, search, outcome, vendorFilter, sortKey])

  const vendorOptions = useMemo(() => {
    const names = new Set((rows ?? []).filter((row) => needsAPerson(row.run)).map(vendorNameFor))
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [rows])

  const counts = useMemo(() => countByVerdict(rows ?? []), [rows])
  const decided = (rows ?? []).filter((row) => row.run.status === 'complete')
  const cleared = decided.filter((row) => row.run.verdict === 'AUTO_APPROVE').length

  const selected = rowForShortId(queue, params.get('run'))
  const selectedIndex = selected ? queue.findIndex((row) => row.run.id === selected.run.id) : -1

  const select = useCallback(
    (row: FeedRow | null, replace = false) => {
      const next = new URLSearchParams(params)
      if (row) {
        // The number is there so the link reads as something. The run is what
        // actually identifies the record.
        if (row.invoice?.invoice_number) next.set('invoice', row.invoice.invoice_number)
        else next.delete('invoice')
        next.set('run', shortRunId(row.run.id))
      } else {
        next.delete('invoice')
        next.delete('run')
      }
      setParams(next, { replace })
    },
    [params, setParams],
  )

  // Never an empty pane. The first exception is opened as soon as there is one,
  // replacing the history entry so the back button does not land on nothing.
  useEffect(() => {
    if (rows === null || queue.length === 0) return
    if (selected) return
    select(queue[0], true)
  }, [rows, queue, selected, select])

  // Working the list from the keyboard. Ignored while the reader is typing into
  // something, so a search box does not swallow the shortcuts and vice versa.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      if (queue.length === 0) return

      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        const step = event.key === 'j' ? 1 : -1
        const from = selectedIndex < 0 ? (step === 1 ? -1 : queue.length) : selectedIndex
        const next = Math.min(queue.length - 1, Math.max(0, from + step))
        select(queue[next])
        listRef.current?.querySelectorAll('li')[next]?.scrollIntoView({ block: 'nearest' })
        return
      }

      if (event.key === 'Enter' && selected) {
        event.preventDefault()
        detail.current?.openDocument()
        return
      }

      if (event.key === 'a' && selected) {
        event.preventDefault()
        detail.current?.act()
        return
      }

      if (event.key === 'Escape') select(null)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [queue, selectedIndex, selected, select])

  const fetchNew = async () => {
    setFetching('Looking')
    setError(null)
    try {
      const pending = await getInvoicesWithoutCompletedRun()
      for (const [index, invoice] of pending.entries()) {
        setFetching(`${index + 1} of ${pending.length}`)
        await runInvoice(invoice.id).catch(() => undefined)
      }
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The new invoices could not be fetched.')
    } finally {
      setFetching(null)
    }
  }

  const dismiss = () => {
    dismissExplainer()
    setExplainerOpen(false)
  }

  const selectClass =
    'h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink'

  return (
    <AppShell openExceptions={queue.length}>
      <div className="shrink-0 border-b border-line bg-surface px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <h1 className="text-lg font-semibold text-ink tnum">
            {rows === null ? 'Loading' : `${count(queue.length)} open exceptions`}
          </h1>

          <div className="min-w-[16rem] flex-1">
            <ProportionBar counts={counts} compact />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="queue-search" className="sr-only">
              Search invoices and vendors
            </label>
            <input
              id="queue-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search invoices and vendors"
              className="h-8 w-52 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-muted"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fetchNew}
              disabled={fetching !== null}
              className="gap-2"
            >
              {fetching ? <Spinner /> : null}
              {fetching ?? 'Fetch new invoices'}
            </Button>
          </div>
        </div>

        {explainerOpen ? (
          <div className="mt-3">
            <Explainer onDismiss={dismiss} onUpload={openUpload} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExplainerOpen(true)}
            className="mt-2 flex h-9 w-full items-center gap-2 rounded-md border border-line px-3 text-sm text-muted transition-colors hover:text-ink"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
            How Clearline decides
          </button>
        )}
      </div>

      {error ? (
        <div className="px-6 pt-4">
          <ErrorNote title="The list could not be loaded">
            {error} Check the connection to the database, then reload the page.
          </ErrorNote>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <section
          aria-label="Open exceptions"
          className="flex w-[496px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
        >
          {/* Filter and sort */}
          <div className="flex shrink-0 flex-wrap gap-2 border-b border-line-soft px-3 py-2">
            <label htmlFor="filter-outcome" className="sr-only">
              Filter by outcome
            </label>
            <select
              id="filter-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
              className={selectClass}
            >
              {OUTCOMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor="filter-vendor" className="sr-only">
              Filter by vendor
            </label>
            <select
              id="filter-vendor"
              value={vendorFilter}
              onChange={(event) => setVendorFilter(event.target.value)}
              className={cn(selectClass, 'min-w-0 flex-1')}
            >
              <option value="all">Every vendor</option>
              {vendorOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <label htmlFor="sort-by" className="sr-only">
              Sort the list
            </label>
            <select
              id="sort-by"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
              className={selectClass}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid shrink-0 grid-cols-[7rem_minmax(0,1fr)_4.75rem_4rem_1.75rem] gap-2 border-b border-line-soft px-3 py-1.5 text-[11px] tracking-wide text-faint">
            <span>Invoice</span>
            <span>Vendor</span>
            <span className="text-right">Amount</span>
            <span>Outcome</span>
            <span className="text-right">Age</span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {rows === null ? (
              <Loading>Loading the list</Loading>
            ) : queue.length === 0 ? (
              <EmptyState
                action={
                  <Button type="button" onClick={openUpload}>
                    Upload an invoice
                  </Button>
                }
              >
                {search.trim().length > 0 || outcome !== 'all' || vendorFilter !== 'all'
                  ? 'Nothing matches these filters. Widen them to see the rest of the list.'
                  : `Nothing needs you. ${count(cleared)} invoices cleared on their own this month.`}
              </EmptyState>
            ) : (
              <ul ref={listRef}>
                {queue.map((row) => {
                  const active = selected?.run.id === row.run.id
                  return (
                    <li key={row.run.id}>
                      <button
                        type="button"
                        onClick={() => select(row)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'grid h-10 w-full grid-cols-[7rem_minmax(0,1fr)_4.75rem_4rem_1.75rem] items-center gap-2 border-b border-line-soft px-3 text-left transition-colors',
                          active ? 'bg-line-soft' : 'hover:bg-line-soft/60',
                        )}
                      >
                        <span className="identifier truncate text-sm text-ink">
                          {row.invoice?.invoice_number ?? 'Not read yet'}
                        </span>

                        {row.duplicateOf ? (
                          /* A duplicate's vendor and amount are the original's, so
                             neither tells the reader anything. What it repeats does,
                             and it needs the room to be readable rather than
                             truncated to nothing. */
                          <span className="col-span-2 truncate text-sm text-muted">
                            Copy of {row.duplicateOf.invoiceNumber}
                          </span>
                        ) : (
                          <>
                            <span className="truncate text-sm text-muted" title={vendorNameFor(row)}>
                              {vendorNameFor(row)}
                            </span>
                            <span className="text-right text-sm text-ink tnum">
                              {money(row.invoice?.total, row.invoice?.currency ?? 'INR')}
                            </span>
                          </>
                        )}

                        <OutcomeChip run={row.run} size="sm" />
                        <span className="text-right text-xs text-muted tnum">{waitingSince(row.run.started_at)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
            <span className="identifier">j</span> and <span className="identifier">k</span> move,{' '}
            <span className="identifier">Enter</span> opens the document,{' '}
            <span className="identifier">a</span> acts, <span className="identifier">Esc</span> clears
          </div>
        </section>

        <section
          aria-label="The selected invoice"
          className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface"
        >
          {/* Keyed on the run so React remounts rather than reusing the previous
              invoice's state. Clearing on selection is belt and braces; the key is
              what makes it structural. */}
          <DecisionDetail
            key={selected?.run.id ?? 'nothing-selected'}
            runId={selected?.run.id ?? null}
            onChanged={load}
            onRemoved={() => select(null, true)}
            handleRef={detail}
          />
        </section>
      </div>
    </AppShell>
  )
}
