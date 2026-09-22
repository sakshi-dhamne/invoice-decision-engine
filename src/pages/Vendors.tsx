// The approved vendor list.
//
// Who we are willing to pay, and since when. An invoice from a company that is not
// on this list is held, so this is the list that decides what clears.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { AppShell } from '@/components/AppShell.tsx'
import { EmptyState, ErrorNote, Loading, PageBody, Panel, PanelHeading } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { count, shortDate } from '@/lib/format.ts'
import { getVendorsWithActivity } from '@/lib/queries.ts'
import type { VendorRow } from '@/lib/database.types.ts'

type StatusFilter = 'all' | 'active' | 'inactive'

interface Entry {
  vendor: VendorRow
  openOrders: number
}

export default function Vendors() {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const load = useCallback(async () => {
    try {
      setEntries(await getVendorsWithActivity())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The vendor list could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (entries ?? [])
      .filter((entry) => (status === 'all' ? true : entry.vendor.status === status))
      .filter((entry) =>
        needle.length === 0
          ? true
          : [entry.vendor.legal_name, ...(entry.vendor.aliases ?? []), entry.vendor.gstin ?? '']
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
      .sort((a, b) => a.vendor.legal_name.localeCompare(b.vendor.legal_name))
  }, [entries, search, status])

  const inactive = (entries ?? []).filter((entry) => entry.vendor.status === 'inactive').length

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-ink">Vendors</h1>
              <p className="mt-1 text-sm text-muted">
                An invoice from a company that is not on this list is held until somebody adds it.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="vendor-status" className="sr-only">
                Filter by status
              </label>
              <select
                id="vendor-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="all">Every vendor</option>
                <option value="active">Active</option>
                <option value="inactive">No longer active</option>
              </select>

              <label htmlFor="vendor-search" className="sr-only">
                Search vendors
              </label>
              <input
                id="vendor-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search vendors"
                className="h-9 w-56 rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
              />
            </div>
          </div>

          {error ? (
            <ErrorNote title="The vendor list could not be loaded">
              {error} Check the connection to the database, then reload the page.
            </ErrorNote>
          ) : null}

          <Panel>
            <PanelHeading
              right={
                <span className="text-xs text-muted tnum">
                  {count(visible.length)} shown
                  {inactive > 0 ? `, ${count(inactive)} no longer active` : ''}
                </span>
              }
            >
              Approved to pay
            </PanelHeading>

            {entries === null ? (
              <Loading>Loading the vendor list</Loading>
            ) : visible.length === 0 ? (
              <EmptyState>
                No vendor matches that. Clear the search to see the whole list.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[820px]">
                  <div
                    className="grid grid-cols-[minmax(0,1fr)_14rem_8rem_7rem_7rem] gap-4 border-b border-line-soft px-5 py-1.5 text-[11px] tracking-wide text-faint"
                    aria-hidden="true"
                  >
                    <span>Vendor</span>
                    <span>Also known as</span>
                    <span className="text-right">Open orders</span>
                    <span>Status</span>
                    <span className="text-right">Added</span>
                  </div>

                  <ul>
                    {visible.map((entry) => (
                      <li
                        key={entry.vendor.id}
                        className="grid grid-cols-[minmax(0,1fr)_14rem_8rem_7rem_7rem] items-center gap-4 border-b border-line-soft px-5 py-2.5 last:border-0"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-ink">{entry.vendor.legal_name}</span>
                          {entry.vendor.gstin ? (
                            <span className="identifier block truncate text-xs text-muted">{entry.vendor.gstin}</span>
                          ) : null}
                        </span>
                        <span className="truncate text-sm text-muted" title={(entry.vendor.aliases ?? []).join(', ')}>
                          {(entry.vendor.aliases ?? []).join(', ') || 'Nothing recorded'}
                        </span>
                        <span className="text-right text-sm text-ink tnum">{count(entry.openOrders)}</span>
                        <span>
                          {entry.vendor.status === 'active' ? (
                            <span className="text-sm text-ink-soft">Active</span>
                          ) : (
                            <span className={cn('rounded-full px-2 py-0.5 text-xs', tone('block').chip)}>
                              No longer active
                            </span>
                          )}
                        </span>
                        <span className="text-right text-sm text-muted tnum">{shortDate(entry.vendor.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Panel>
        </div>
      </PageBody>
    </AppShell>
  )
}
