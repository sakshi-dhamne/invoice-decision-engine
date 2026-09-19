// The queue, and the invoice you are looking at, side by side.
//
// A finance manager works a list. Choosing a row changes the pane on the right and
// nothing else: no navigation, no scroll position lost, no wait. The selection is
// in the URL so it can be linked and the back button does what it should.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { DecisionDetail, type DecisionDetailHandle } from '@/components/DecisionDetail.tsx'
import { Explainer } from '@/components/Explainer.tsx'
import { ProportionBar } from '@/components/ProportionBar.tsx'
import { EmptyState, ErrorNote, Loading, Spinner, VerdictChip } from '@/components/Primitives.tsx'
import { useUpload } from '@/components/uploadContext.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count, money, waitingSince } from '@/lib/format.ts'
import { countByVerdict, loadFeed, matchesSearch, needsAPerson, vendorNameFor, type FeedRow } from '@/lib/feed.ts'
import { dismissExplainer, explainerDismissed } from '@/lib/localSettings.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { getInvoicesWithoutCompletedRun } from '@/lib/queries.ts'

export default function NeedsYou() {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [explainerOpen, setExplainerOpen] = useState(() => !explainerDismissed())
  const [fetching, setFetching] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const { openUpload, finishedAt } = useUpload()
  const detail = useRef<DecisionDetailHandle | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selectedNumber = params.get('invoice')

  const load = useCallback(async () => {
    try {
      const feed = await loadFeed()
      setRows(feed.rows)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The queue could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, finishedAt])

  const queue = useMemo(
    () => (rows ?? []).filter((row) => needsAPerson(row.run) && matchesSearch(row, search)),
    [rows, search],
  )

  const counts = useMemo(() => countByVerdict(rows ?? []), [rows])
  const decided = (rows ?? []).filter((row) => row.run.status === 'complete')
  const cleared = decided.filter((row) => row.run.verdict === 'AUTO_APPROVE').length

  const selectedIndex = queue.findIndex((row) => row.invoice?.invoice_number === selectedNumber)
  const selected = selectedIndex >= 0 ? queue[selectedIndex] : null

  const select = useCallback(
    (row: FeedRow | null) => {
      const next = new URLSearchParams(params)
      if (row?.invoice?.invoice_number) next.set('invoice', row.invoice.invoice_number)
      else next.delete('invoice')
      setParams(next, { replace: false })
    },
    [params, setParams],
  )

  // Working the queue from the keyboard. Ignored while the reader is typing into
  // something, so a search box does not swallow the shortcuts and vice versa.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true
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
        detail.current?.approve()
        return
      }

      if (event.key === 'Escape') {
        select(null)
      }
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

  return (
    <AppShell waitingCount={queue.length}>
      {/* Header strip: the count, the shape of the whole pile, the search. */}
      <div className="shrink-0 border-b border-line bg-surface px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <h1 className="text-lg font-semibold text-ink tnum">
            {rows === null ? 'Loading' : `${count(queue.length)} waiting on you`}
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
              className="h-8 w-56 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-muted"
            />
            <Button type="button" variant="outline" size="sm" onClick={fetchNew} disabled={fetching !== null} className="gap-2">
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
          <ErrorNote title="The queue could not be loaded">
            {error} Check the connection to the database, then reload the page.
          </ErrorNote>
        </div>
      ) : null}

      {/* The work itself. */}
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <section
          aria-label="Invoices waiting for a person"
          className="flex w-[420px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
        >
          <div className="grid shrink-0 grid-cols-[7rem_minmax(0,1fr)_4.75rem_4rem_2rem] gap-2 border-b border-line-soft px-3 py-1.5 text-[11px] tracking-wide text-faint">
            <span>Invoice</span>
            <span>Vendor</span>
            <span className="text-right">Amount</span>
            <span>Outcome</span>
            <span className="text-right">Age</span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {rows === null ? (
              <Loading>Loading the queue</Loading>
            ) : queue.length === 0 ? (
              <EmptyState
                action={
                  <Button type="button" onClick={openUpload}>
                    Upload an invoice
                  </Button>
                }
              >
                {search.trim().length > 0
                  ? 'No waiting invoice matches that search. Clear the search to see the whole queue.'
                  : `Nothing needs you. ${count(cleared)} invoices cleared on their own this month.`}
              </EmptyState>
            ) : (
              <ul ref={listRef}>
                {queue.map((row) => {
                  const active = row.invoice?.invoice_number === selectedNumber
                  return (
                    <li key={row.run.id}>
                      <button
                        type="button"
                        onClick={() => select(row)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'grid h-10 w-full grid-cols-[7rem_minmax(0,1fr)_4.75rem_4rem_2rem] items-center gap-2 border-b border-line-soft px-3 text-left transition-colors',
                          active ? 'bg-line-soft' : 'hover:bg-line-soft/60',
                        )}
                      >
                        <span className="identifier truncate text-sm text-ink">
                          {row.invoice?.invoice_number ?? 'Not read yet'}
                        </span>
                        <span className="truncate text-sm text-muted" title={vendorNameFor(row)}>
                          {vendorNameFor(row)}
                        </span>
                        <span className="text-right text-sm text-ink tnum">
                          {money(row.invoice?.total, row.invoice?.currency ?? 'INR')}
                        </span>
                        <VerdictChip verdict={row.run.verdict} size="sm" />
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
            <span className="identifier">a</span> approves, <span className="identifier">Esc</span> clears
          </div>
        </section>

        <section aria-label="The selected invoice" className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface">
          <DecisionDetail runId={selected?.run.id ?? null} onChanged={load} handleRef={detail} />
        </section>
      </div>
    </AppShell>
  )
}
