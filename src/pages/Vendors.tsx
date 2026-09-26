// The approved vendor list.
//
// Who we are willing to pay, and since when. An invoice from a company that is not
// on this list is held, so this is the list that decides what clears.
//
// The account number on a row is the reference every invoice from that vendor is
// checked against, which makes two things worth showing beside it: who confirmed
// it and how they were reached, and whether it has moved lately. An account nobody
// can say they verified is an account nobody verified, and an account that changed
// last week is the thing to notice before the next invoice against it arrives.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { EmptyState, ErrorNote, Loading, PageBody, Panel, PanelHeading } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count, dateAndTime, shortDate } from '@/lib/format.ts'
import { getAllVendorChanges, getVendorsWithActivity } from '@/lib/queries.ts'
import {
  BANK_CHANGED_RECENTLY_LABEL,
  BANK_CONFIRMED_LABEL,
  BANK_CONFIRMED_MISSING,
  IDENTITY_CHANGE_LABEL,
  NEW_VENDOR_LABEL,
  PAYMENT_CHANGE_LABEL,
  VENDOR_HISTORY_EMPTY,
  vendorAddedBy,
  vendorFieldLabel,
} from '@/lib/reasonCopy.ts'
import { bankChangedRecently, daysSinceBankChange } from '@/lib/vendorEdit.ts'
import type { VendorChangeRow, VendorRow } from '@/lib/database.types.ts'

type StatusFilter = 'all' | 'active' | 'inactive'

interface Entry {
  vendor: VendorRow
  openOrders: number
}

/** One edit, as a line in the history. */
function ChangeLine({ change }: { change: VendorChangeRow }) {
  const payment = change.kind === 'payment'
  const classes = tone('block')

  return (
    <li className="border-b border-line-soft py-2.5 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* Payment changes are marked distinctly from identity edits, because
            they are a different kind of event and the list has to be scannable
            for them. */}
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px]',
            payment ? classes.chip : 'border border-line text-muted',
          )}
        >
          {payment ? PAYMENT_CHANGE_LABEL : IDENTITY_CHANGE_LABEL}
        </span>
        <span className="text-sm text-ink">{vendorFieldLabel(change.field)}</span>
        <span className="ml-auto text-xs text-muted tnum">{dateAndTime(change.changed_at)}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-baseline gap-2 text-sm">
        <span className={cn('text-muted line-through', payment && 'identifier')}>{change.old_value ?? 'Nothing'}</span>
        <span aria-hidden="true" className="text-muted">
          to
        </span>
        <span className={cn('font-medium text-ink', payment && 'identifier')}>{change.new_value ?? 'Nothing'}</span>
      </div>

      <p className="mt-1 text-xs text-muted">Changed by {change.changed_by}</p>
      {change.verification_note ? (
        <p className={cn('mt-0.5 text-xs', classes.text)}>Confirmed with the vendor: {change.verification_note}</p>
      ) : null}
    </li>
  )
}

export default function Vendors() {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [changes, setChanges] = useState<Map<string, VendorChangeRow[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [withActivity, history] = await Promise.all([
        getVendorsWithActivity(),
        // The history table is added by 010_vendor_history.sql. A project that has
        // not had it applied yet still gets a working vendor list, with no history
        // under any of the rows.
        getAllVendorChanges().catch(() => new Map<string, VendorChangeRow[]>()),
      ])
      setEntries(withActivity)
      setChanges(history)
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

              {/* Adding a vendor without an invoice to react to. The same address as
                  the invoice-driven flow, which is the same act with a document in
                  front of you; /vendors/new decides which of the two it is by
                  whether it was given a run to work from. */}
              <Button asChild className="gap-2">
                <Link to="/vendors/new">
                  <Plus className="size-4" aria-hidden="true" />
                  {NEW_VENDOR_LABEL}
                </Link>
              </Button>
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
              <EmptyState>No vendor matches that. Clear the search to see the whole list.</EmptyState>
            ) : (
              <ul>
                {visible.map((entry) => {
                  const vendor = entry.vendor
                  const history = changes.get(vendor.id) ?? []
                  const open = expanded === vendor.id
                  const recentlyMoved = bankChangedRecently(vendor)
                  const sinceChange = daysSinceBankChange(vendor)
                  const blockClasses = tone('block')

                  return (
                    <li key={vendor.id} className="border-b border-line-soft last:border-0">
                      <div className="grid gap-4 px-5 py-3.5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_8rem_10rem]">
                        {/* Who they are */}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink" title={vendor.legal_name}>
                            {vendor.legal_name}
                          </p>
                          {vendor.gstin ? (
                            <p className="identifier truncate text-xs text-muted">{vendor.gstin}</p>
                          ) : null}
                          <p
                            className="mt-0.5 truncate text-xs text-muted"
                            title={(vendor.aliases ?? []).join(', ')}
                          >
                            {(vendor.aliases ?? []).length > 0
                              ? `Also known as ${(vendor.aliases ?? []).join(', ')}`
                              : ''}
                          </p>
                        </div>

                        {/* Where the money goes, and the evidence that somebody
                            checked it. This is the whole reason the note is
                            collected, and it was being collected and never shown. */}
                        <div className="min-w-0">
                          <p className="identifier truncate text-sm text-ink">
                            {vendor.bank_account ?? 'No account on file'}
                            {vendor.bank_ifsc ? `, ${vendor.bank_ifsc}` : ''}
                          </p>
                          <p className="mt-0.5 text-xs text-muted">
                            {vendor.bank_confirmed_by
                              ? `${BANK_CONFIRMED_LABEL}: ${vendor.bank_confirmed_by}${
                                  vendor.bank_confirmed_at ? `, ${shortDate(vendor.bank_confirmed_at)}` : ''
                                }`
                              : BANK_CONFIRMED_MISSING}
                          </p>
                          {recentlyMoved ? (
                            <p className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[11px]', blockClasses.chip)}>
                              {BANK_CHANGED_RECENTLY_LABEL}
                              {sinceChange !== null ? `, ${count(sinceChange)} days ago` : ''}
                            </p>
                          ) : null}
                        </div>

                        <div className="text-sm">
                          <p className="text-ink tnum">{count(entry.openOrders)} open orders</p>
                          {vendor.status === 'active' ? (
                            <p className="mt-0.5 text-xs text-muted">Active</p>
                          ) : (
                            <p className={cn('mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px]', blockClasses.chip)}>
                              No longer active
                            </p>
                          )}
                        </div>

                        {/* When, and by whom */}
                        <div className="text-xs text-muted">
                          {/* A vendor with no name against it came with the
                              starting data. The onboarding form has required one
                              since it started writing the column, so a null here
                              is the seed rather than a lapse. */}
                          <p className="truncate" title={vendor.added_by ?? undefined}>
                            {vendorAddedBy(vendor.added_by)}
                          </p>
                          <p className="tnum">{shortDate(vendor.created_at)}</p>
                          {vendor.updated_at ? (
                            <>
                              <p className="mt-1 truncate" title={vendor.updated_by ?? undefined}>
                                {vendor.updated_by ? `Changed by ${vendor.updated_by}` : 'Changed'}
                              </p>
                              <p className="tnum">{shortDate(vendor.updated_at)}</p>
                            </>
                          ) : (
                            <p className="mt-1">Never changed</p>
                          )}

                          <div className="mt-2 flex items-center gap-3">
                            <Button asChild size="sm" variant="outline">
                              <Link to={`/vendors/${encodeURIComponent(vendor.id)}/edit`}>Edit</Link>
                            </Button>
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : vendor.id)}
                              aria-expanded={open}
                              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ink"
                            >
                              {open ? (
                                <ChevronDown className="size-3.5" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="size-3.5" aria-hidden="true" />
                              )}
                              {count(history.length)} changes
                            </button>
                          </div>
                        </div>
                      </div>

                      {open ? (
                        <div className="border-t border-line-soft bg-ground px-5 py-3">
                          <h3 className="text-xs font-medium text-ink">Everything that has changed</h3>
                          {history.length === 0 ? (
                            <p className="mt-2 text-sm text-muted">{VENDOR_HISTORY_EMPTY}</p>
                          ) : (
                            <ul className="mt-1">
                              {history.map((change) => (
                                <ChangeLine key={change.id} change={change} />
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </PageBody>
    </AppShell>
  )
}
