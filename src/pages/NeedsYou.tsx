// Landing. What is waiting on a person, and nothing else.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { AppShell } from '@/components/AppShell.tsx'
import { Explainer } from '@/components/Explainer.tsx'
import { ProportionBar } from '@/components/ProportionBar.tsx'
import { EmptyState, ErrorNote, Loading, Panel, Spinner, VerdictChip } from '@/components/Primitives.tsx'
import { useUpload } from '@/components/uploadContext.ts'
import { Button } from '@/components/ui/button'
import { count, money, waitingFor } from '@/lib/format.ts'
import { countByVerdict, loadFeed, matchesSearch, needsAPerson, vendorNameFor, type FeedRow } from '@/lib/feed.ts'
import { dismissExplainer, explainerDismissed } from '@/lib/localSettings.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { getInvoicesWithoutCompletedRun } from '@/lib/queries.ts'
import { reasonSentence } from '@/lib/reasonCopy.ts'

export default function NeedsYou() {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showExplainer, setShowExplainer] = useState(() => !explainerDismissed())
  const [fetching, setFetching] = useState<string | null>(null)
  const { openUpload } = useUpload()

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
  }, [load])

  const queue = useMemo(
    () => (rows ?? []).filter((row) => needsAPerson(row.run) && matchesSearch(row, search)),
    [rows, search],
  )

  const counts = useMemo(() => countByVerdict(rows ?? []), [rows])
  const decided = (rows ?? []).filter((row) => row.run.status === 'complete')
  const cleared = decided.filter((row) => row.run.verdict === 'AUTO_APPROVE').length
  const valueProcessed = decided.reduce((sum, row) => sum + (row.invoice?.total ?? 0), 0)

  // Runs any seeded invoice that has never reached a verdict. Pressing it again
  // once everything is decided does nothing, which is what the count reports.
  const fetchNew = async () => {
    setFetching('Looking for new invoices')
    setError(null)
    try {
      const pending = await getInvoicesWithoutCompletedRun()
      if (pending.length === 0) {
        setFetching(null)
        return
      }
      for (const [index, invoice] of pending.entries()) {
        setFetching(`Checking invoice ${index + 1} of ${pending.length}`)
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
    setShowExplainer(false)
  }

  return (
    <AppShell search={search} onSearchChange={setSearch}>
      <div className="space-y-6">
        {error ? (
          <ErrorNote title="The queue could not be loaded">
            {error} Check the connection to the database, then reload the page.
          </ErrorNote>
        ) : null}

        {showExplainer ? <Explainer onDismiss={dismiss} onUpload={openUpload} /> : null}

        <Panel className="px-6 py-6">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <h1 className="text-2xl font-semibold text-ink tnum">
                {rows === null ? ' ' : `${count(queue.length)} waiting on you`}
              </h1>
              <p className="mt-1 text-sm text-muted">
                Everything else cleared the checks on its own.
              </p>
            </div>

            <div className="flex items-end gap-8">
              <div className="text-right">
                <p className="text-xs text-muted">Received</p>
                <p className="mt-1 text-lg font-semibold text-ink tnum">{count(decided.length)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted">Value processed</p>
                <p className="mt-1 text-lg font-semibold text-ink tnum">{money(valueProcessed)}</p>
              </div>
              <Button type="button" variant="outline" onClick={fetchNew} disabled={fetching !== null} className="gap-2">
                {fetching ? <Spinner /> : null}
                {fetching ?? 'Fetch new invoices'}
              </Button>
            </div>
          </div>

          <div className="mt-6">
            <ProportionBar counts={counts} />
          </div>
        </Panel>

        <Panel>
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
            <div className="overflow-x-auto">
              <div className="min-w-[960px]">
                <div
                  className="grid grid-cols-[7rem_minmax(0,1fr)_14rem_9rem_7rem] gap-4 border-b border-line-soft px-5 py-2.5 text-xs font-medium text-muted"
                  aria-hidden="true"
                >
                  <span>Outcome</span>
                  <span>Invoice</span>
                  <span>Vendor</span>
                  <span className="text-right">Amount</span>
                  <span className="text-right">Waiting</span>
                </div>

                <ul>
                  {queue.map((row) => (
                    <li key={row.run.id} className="border-b border-line-soft last:border-0">
                      <Link
                        to={`/decisions/${row.run.id}`}
                        className="grid grid-cols-[7rem_minmax(0,1fr)_14rem_9rem_7rem] items-start gap-4 px-5 py-4 transition-colors hover:bg-line-soft/60"
                      >
                        <VerdictChip verdict={row.run.verdict} size="sm" />

                        <span className="min-w-0">
                          <span className="identifier block text-sm font-medium text-ink">
                            {row.invoice?.invoice_number ?? 'Not read yet'}
                          </span>
                          <span className="mt-1 block text-sm text-muted">
                            {row.primaryCode ? reasonSentence(row.primaryCode) : 'No reason was recorded.'}
                          </span>
                        </span>

                        <span className="truncate text-sm text-ink-soft">{vendorNameFor(row)}</span>

                        <span className="text-right text-sm text-ink tnum">
                          {money(row.invoice?.total, row.invoice?.currency ?? 'INR')}
                        </span>

                        <span className="text-right text-sm text-muted tnum">{waitingFor(row.run.started_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  )
}
