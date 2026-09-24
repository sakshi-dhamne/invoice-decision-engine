// A new order, with no invoice in front of you.
//
// The counterpart to raising one from a held invoice. That flow reacts to an
// invoice that has already arrived with nothing on file authorising it; this is
// the ordinary way round, where the order exists before the invoice does. Both
// write the same kind of record, and the rules read them identically.
//
// Every field is typed here, and the warnings the other form carries are absent
// on purpose. Those exist because copying a figure off an invoice makes the
// invoice check itself. There is no invoice on this screen to copy anything from.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { EmptyState, ErrorNote, Loading, PageBody, Panel, PanelHeading, Spinner } from '@/components/Primitives.tsx'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { money } from '@/lib/format.ts'
import {
  NEW_ORDER_INCOMPLETE,
  NEW_ORDER_INTRO,
  NEW_ORDER_NUMBER_NOTE,
  NEW_ORDER_SUBMIT,
  NEW_ORDER_TITLE,
  NEW_ORDER_VENDOR_EMPTY,
} from '@/lib/reasonCopy.ts'
import { getPurchaseOrders, getVendors } from '@/lib/queries.ts'
import {
  createOrder,
  emptyNewOrder,
  newOrderIsComplete,
  orderableVendors,
  suggestOrderNumber,
  vendorsMatching,
  type NewOrderInputs,
} from '@/lib/newOrder.ts'
import { parseOrderValue } from '@/lib/orderForm.ts'
import type { PurchaseOrderRow, VendorRow } from '@/lib/database.types.ts'

const labelClass = 'block text-xs text-muted'
const inputClass =
  'mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function OrderCreate() {
  const navigate = useNavigate()

  const [vendors, setVendors] = useState<VendorRow[] | null>(null)
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([])
  const [inputs, setInputs] = useState<NewOrderInputs>(() => emptyNewOrder(today()))
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    try {
      const [vendorRows, orderRows] = await Promise.all([getVendors(), getPurchaseOrders()])
      setVendors(orderableVendors(vendorRows))
      setOrders(orderRows)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The vendor list could not be loaded.')
      setVendors([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const matches = useMemo(() => vendorsMatching(vendors ?? [], search), [vendors, search])
  const vendor = useMemo(
    () => (vendors ?? []).find((entry) => entry.id === inputs.vendorId) ?? null,
    [vendors, inputs.vendorId],
  )

  const set = <K extends keyof NewOrderInputs>(field: K, value: NewOrderInputs[K]) =>
    setInputs((current) => ({ ...current, [field]: value }))

  /**
   * Choosing a vendor suggests the next number in whatever sequence that vendor's
   * orders already use. It replaces a suggestion, never something typed: somebody
   * who has entered their own number and then corrects the vendor should not lose
   * it silently.
   */
  const chooseVendor = (chosen: VendorRow) => {
    setSearch(chosen.legal_name)
    setInputs((current) => {
      const suggested = suggestOrderNumber(chosen, orders)
      const previous = vendors?.find((entry) => entry.id === current.vendorId) ?? null
      const wasSuggested =
        current.poNumber.length === 0 || (previous !== null && current.poNumber === suggestOrderNumber(previous, orders))
      return { ...current, vendorId: chosen.id, poNumber: wasSuggested ? suggested : current.poNumber }
    })
  }

  const ready = useMemo(() => newOrderIsComplete(inputs), [inputs])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || !vendor || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const order = await createOrder(inputs, vendor)
      navigate(`/orders/${encodeURIComponent(order.po_number)}`)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} An order may already exist under that number. Change it and try again.`
          : 'The order could not be raised. Try again in a moment.',
      )
      setSubmitting(false)
    }
  }

  const value = parseOrderValue(inputs.totalAmount)

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <Link to="/orders" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the orders
          </Link>

          {error ? <ErrorNote title="This order could not be raised">{error}</ErrorNote> : null}

          {vendors === null ? (
            <Panel>
              <Loading>Loading the vendors</Loading>
            </Panel>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <form onSubmit={submit} className="space-y-6">
                <Panel className="px-6 py-6">
                  <h1 className="text-2xl font-semibold text-ink">{NEW_ORDER_TITLE}</h1>
                  <p className="prose-serif mt-3 max-w-[72ch] text-[17px] text-ink-soft">{NEW_ORDER_INTRO}</p>
                </Panel>

                <Panel>
                  <PanelHeading>Who it is with</PanelHeading>
                  <div className="space-y-4 px-5 py-5">
                    <div>
                      <label htmlFor="order-vendor-search" className={labelClass}>
                        Vendor (required)
                      </label>
                      <input
                        id="order-vendor-search"
                        type="search"
                        className={inputClass}
                        value={search}
                        onChange={(event) => {
                          setSearch(event.target.value)
                          // Typing again reopens the choice rather than leaving a
                          // vendor selected that the box no longer names.
                          if (inputs.vendorId) set('vendorId', '')
                        }}
                        placeholder="Search the approved vendors"
                        autoComplete="off"
                        role="combobox"
                        aria-expanded={vendor === null}
                        aria-controls="order-vendor-list"
                      />

                      {vendor ? (
                        <p className="mt-2 flex items-center gap-1.5 text-sm text-ink">
                          <Check className="size-4 text-muted" aria-hidden="true" />
                          {vendor.legal_name}
                        </p>
                      ) : matches.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">{NEW_ORDER_VENDOR_EMPTY}</p>
                      ) : (
                        <ul
                          id="order-vendor-list"
                          role="listbox"
                          aria-label="Approved vendors"
                          className="mt-2 max-h-56 overflow-auto rounded-md border border-line"
                        >
                          {matches.map((entry) => (
                            <li key={entry.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={false}
                                onClick={() => chooseVendor(entry)}
                                className="flex w-full flex-col items-start gap-0.5 border-b border-line-soft px-3 py-2 text-left transition-colors last:border-0 hover:bg-line-soft/60"
                              >
                                <span className="text-sm text-ink">{entry.legal_name}</span>
                                {entry.aliases && entry.aliases.length > 0 ? (
                                  <span className="text-xs text-muted">{entry.aliases.join(', ')}</span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <label htmlFor="order-number" className={labelClass}>
                        Order number (required)
                      </label>
                      <input
                        id="order-number"
                        className={cn(inputClass, 'identifier')}
                        value={inputs.poNumber}
                        onChange={(event) => set('poNumber', event.target.value)}
                        placeholder="Choose a vendor and we will suggest one"
                        required
                      />
                      <p className="mt-1 text-xs text-muted">{NEW_ORDER_NUMBER_NOTE}</p>
                    </div>
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading>What was agreed</PanelHeading>
                  <div className="space-y-4 px-5 py-5">
                    <div>
                      <label htmlFor="order-description" className={labelClass}>
                        Description (required)
                      </label>
                      <input
                        id="order-description"
                        className={inputClass}
                        value={inputs.description}
                        onChange={(event) => set('description', event.target.value)}
                        placeholder="What this order covers"
                        required
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label htmlFor="order-value" className={labelClass}>
                          Order value (required)
                        </label>
                        <input
                          id="order-value"
                          className={cn(inputClass, 'tnum')}
                          value={inputs.totalAmount}
                          onChange={(event) => set('totalAmount', event.target.value)}
                          inputMode="decimal"
                          placeholder="0"
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="order-currency" className={labelClass}>
                          Currency
                        </label>
                        <input
                          id="order-currency"
                          className={cn(inputClass, 'identifier uppercase')}
                          value={inputs.currency}
                          onChange={(event) => set('currency', event.target.value)}
                          maxLength={3}
                          required
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <label htmlFor="order-date" className={labelClass}>
                          Issued on
                        </label>
                        <input
                          id="order-date"
                          type="date"
                          className={inputClass}
                          value={inputs.issuedDate}
                          onChange={(event) => set('issuedDate', event.target.value)}
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="order-status" className={labelClass}>
                          Status
                        </label>
                        <select
                          id="order-status"
                          className={inputClass}
                          value={inputs.status}
                          onChange={(event) => set('status', event.target.value as NewOrderInputs['status'])}
                        >
                          <option value="open">Open</option>
                          <option value="closed">Closed</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="order-tax" className={labelClass}>
                          Figures include tax
                        </label>
                        <select
                          id="order-tax"
                          className={inputClass}
                          value={inputs.taxTreatment}
                          onChange={(event) => set('taxTreatment', event.target.value as NewOrderInputs['taxTreatment'])}
                        >
                          <option value="exclusive">No, tax is added on top</option>
                          <option value="inclusive">Yes, the value includes tax</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </Panel>

                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!ready || submitting} className="gap-2">
                    {submitting ? <Spinner className="border-t-primary-foreground" /> : null}
                    {submitting ? 'Raising the order' : NEW_ORDER_SUBMIT}
                  </Button>
                  {!ready ? <p className="text-sm text-muted">{NEW_ORDER_INCOMPLETE}</p> : null}
                </div>
              </form>

              {/* Right rail */}
              <div className="space-y-6">
                <Panel>
                  <PanelHeading>What you are recording</PanelHeading>
                  {vendor ? (
                    <div className="space-y-3 px-5 py-4">
                      <div>
                        <p className="text-xs text-muted">Vendor</p>
                        <p className="mt-0.5 text-sm text-ink">{vendor.legal_name}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted">Order</p>
                        <p className="identifier mt-0.5 text-sm text-ink">{inputs.poNumber || 'Not chosen yet'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted">Order value</p>
                        <p className="mt-0.5 text-sm text-ink tnum">
                          {value === null ? 'Not entered yet' : money(value, inputs.currency.toUpperCase())}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <EmptyState>Choose a vendor to start.</EmptyState>
                  )}
                </Panel>

                <Panel>
                  <PanelHeading>What happens next</PanelHeading>
                  <ol className="space-y-4 px-5 py-4">
                    {[
                      'We record the order against this vendor with the value you entered.',
                      'The next invoice from this vendor is matched against it, by its number or by what it bills for.',
                      'If the invoice is within tolerance of the order, it clears. If it is not, it stops and says why.',
                    ].map((step, index) => (
                      <li key={step} className="flex gap-3">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-xs text-muted tnum">
                          {index + 1}
                        </span>
                        <span className="text-sm text-ink-soft">{step}</span>
                      </li>
                    ))}
                  </ol>
                </Panel>
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}
