// Every purchase order, and what is left of each one.
//
// Orders could be raised from a held invoice and were then invisible: nothing in
// the product listed them, so the value an order had left, and which invoices had
// eaten into it, were things only the rules engine knew.
//
// What each one has been billed is derived from the invoices approved against it,
// by the same function the pipeline uses before it checks an invoice, so this
// page and the decision agree by construction rather than by being kept in step.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronUp, Plus } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  Loading,
  PageBody,
  Panel,
  PanelHeading,
} from '@/components/Primitives.tsx'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count, money, shortDate } from '@/lib/format.ts'
import { NEW_ORDER_LABEL, ORDERS_EMPTY } from '@/lib/reasonCopy.ts'
import {
  loadOrders,
  matchesOrderSearch,
  orderStatusLabel,
  sortOrders,
  type OrderSortKey,
  type OrderSummary,
  type SortDirection,
} from '@/lib/orders.ts'
import type { PurchaseOrderStatus } from '@/lib/database.types.ts'

type OrderFilter = PurchaseOrderStatus | 'all'

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'open', label: orderStatusLabel('open') },
  { value: 'closed', label: orderStatusLabel('closed') },
  { value: 'cancelled', label: orderStatusLabel('cancelled') },
]

const COLUMNS: [OrderSortKey, string, 'left' | 'right'][] = [
  ['order', 'Order', 'left'],
  ['vendor', 'Vendor', 'left'],
  ['value', 'Order value', 'right'],
  ['billed', 'Billed to date', 'right'],
  ['remaining', 'Remaining', 'right'],
  ['status', 'Status', 'left'],
  ['raised', 'Raised', 'right'],
]

const GRID = 'grid-cols-[8rem_minmax(0,1fr)_8rem_8rem_8rem_6rem_7rem]'

export default function Orders() {
  const [rows, setRows] = useState<OrderSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<OrderFilter>('all')
  const [vendorFilter, setVendorFilter] = useState('all')
  const [sort, setSort] = useState<{ key: OrderSortKey; direction: SortDirection }>({
    key: 'raised',
    direction: 'desc',
  })

  const load = useCallback(async () => {
    try {
      const data = await loadOrders()
      setRows(data.orders)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The orders could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const vendorOptions = useMemo(
    () =>
      [...new Set((rows ?? []).map((row) => row.vendor?.legal_name).filter((name): name is string => Boolean(name)))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [rows],
  )

  const visible = useMemo(() => {
    const matched = (rows ?? []).filter((row) => {
      if (!matchesOrderSearch(row, search)) return false
      if (filter !== 'all' && row.order.status !== filter) return false
      if (vendorFilter !== 'all' && row.vendor?.legal_name !== vendorFilter) return false
      return true
    })
    return sortOrders(matched, sort.key, sort.direction)
  }, [rows, search, filter, vendorFilter, sort])

  const toggleSort = (key: OrderSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'order' || key === 'vendor' || key === 'status' ? 'asc' : 'desc' },
    )

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-ink">Orders</h1>
              <p className="mt-1 text-sm text-muted">
                What was authorised, what has been billed against it, and what is left.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label htmlFor="orders-search" className="sr-only">
                Search orders and vendors
              </label>
              <input
                id="orders-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search orders and vendors"
                className="h-9 w-64 rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
              />
              {/* An order raised before any invoice exists, which is the ordinary
                  way round. The other flow starts from an invoice that arrived
                  without one. */}
              <Button asChild className="gap-2">
                <Link to="/orders/new">
                  <Plus className="size-4" aria-hidden="true" />
                  {NEW_ORDER_LABEL}
                </Link>
              </Button>
            </div>
          </div>

          {error ? (
            <ErrorNote title="The orders could not be loaded">
              {error} Check the connection to the database, then reload the page.
            </ErrorNote>
          ) : null}

          <Panel>
            <PanelHeading right={<span className="text-xs text-muted">{count(visible.length)} shown</span>}>
              Purchase orders
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
              <label htmlFor="orders-vendor" className="text-xs text-muted">
                Vendor
              </label>
              <select
                id="orders-vendor"
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
            </div>

            {rows === null ? (
              <Loading>Loading the orders</Loading>
            ) : visible.length === 0 ? (
              <EmptyState>{ORDERS_EMPTY}</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[880px]">
                  <div className={cn('grid gap-4 border-b border-line-soft px-5 py-1.5', GRID)}>
                    {COLUMNS.map(([key, label, align]) => (
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
                      <li key={row.order.po_number} className="border-b border-line-soft last:border-0">
                        <Link
                          to={`/orders/${encodeURIComponent(row.order.po_number)}`}
                          className={cn(
                            'grid items-baseline gap-4 px-5 py-3.5 transition-colors hover:bg-line-soft/60',
                            GRID,
                          )}
                        >
                          <span className="identifier text-sm text-ink">{row.order.po_number}</span>
                          <span className="min-w-0 truncate text-sm text-ink-soft" title={row.vendor?.legal_name}>
                            {row.vendor?.legal_name ?? 'Not identified'}
                          </span>
                          <span className="text-right text-sm text-ink tnum">
                            {money(row.order.total_amount, row.order.currency)}
                          </span>
                          <span className="text-right text-sm text-ink-soft tnum">
                            {money(row.billedToDate, row.order.currency)}
                          </span>
                          <span className="text-right text-sm text-ink tnum">
                            {money(row.remaining, row.order.currency)}
                          </span>
                          <span className="text-sm text-muted">{orderStatusLabel(row.order.status)}</span>
                          <span className="text-right text-sm text-muted tnum">
                            {shortDate(row.order.issued_date)}
                          </span>
                        </Link>
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
