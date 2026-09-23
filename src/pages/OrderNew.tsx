// Raising an order for an invoice that cites none.
//
// An invoice held for NO_PO_MATCH had nowhere to go: there is nothing on file
// authorising the work, and no screen that let anybody put it there. An uploaded
// invoice could therefore never reach approved, however legitimate it was.
//
// Vendor and description come off the invoice. The order value does not, for the
// same reason the vendor form does not take bank details off the invoice: the
// tolerance check compares what is billed against what was ordered, and an order
// copied from the invoice makes that comparison meaningless. Whoever agreed the
// work knows the figure and types it.
//
// On save the order is created and the invoice is checked again from the top. The
// rules decide it exactly as they would any other invoice against any other order;
// nothing here is a shortcut past them.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { ErrorNote, Loading, PageBody, Panel, PanelHeading, Spinner, UnfilledInput } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { money, shortDate } from '@/lib/format.ts'
import { raiseOrder } from '@/lib/raiseOrder.ts'
import { getInvoiceById, getRunById, getStageLogs } from '@/lib/queries.ts'
import { loadVendorMaster, resolveVendorForDocument } from '@/lib/vendorLookup.ts'
import { asRecord } from '@/lib/decisionData.ts'
import {
  describeFromLines,
  emptyOrderInputs,
  orderIsComplete,
  parseOrderValue,
  type OrderInputs,
} from '@/lib/orderForm.ts'
import type { InvoiceRow, RunRow, VendorRow } from '@/lib/database.types.ts'

const labelClass = 'block text-xs text-muted'
const inputClass =
  'mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function OrderNew() {
  const [params] = useSearchParams()
  const fromRunId = params.get('from') ?? ''
  const navigate = useNavigate()

  const [run, setRun] = useState<RunRow | null>(null)
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null)
  const [vendor, setVendor] = useState<VendorRow | null>(null)
  const [description, setDescription] = useState('')
  // The order value starts empty and there is nothing in scope here to fill it
  // from. See src/lib/orderForm.ts.
  const [inputs, setInputs] = useState<OrderInputs>(() => emptyOrderInputs(today()))
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!fromRunId) {
      setError('This page needs to be opened from a held invoice, so it knows what the order is for.')
      setLoaded(true)
      return
    }
    try {
      const fresh = await getRunById(fromRunId)
      if (!fresh?.invoice_id) {
        setError('That held invoice could not be found. Go back to the queue and open it again.')
        setLoaded(true)
        return
      }
      const [doc, stages, master] = await Promise.all([
        getInvoiceById(fresh.invoice_id),
        getStageLogs(fromRunId),
        loadVendorMaster(),
      ])
      const read = asRecord(stages.find((stage) => stage.stage === 'extract')?.output)

      setRun(fresh)
      setInvoice(doc)

      // Resolved now, against the vendor master as it stands. Reading the invoice
      // row's stored column instead meant a vendor added after this run was
      // decided was invisible here, which is exactly the vendor somebody raising
      // an order is most likely to have just added.
      setVendor(
        resolveVendorForDocument({
          printedName:
            (typeof read?.vendor_name === 'string' ? read.vendor_name : null) ?? doc?.vendor_name_as_printed ?? null,
          storedVendorId: doc?.vendor_id,
          vendors: master.vendors,
          rules: master.rules,
        }).vendor,
      )
      setDescription(
        describeFromLines(Array.isArray(read?.line_items) ? (read.line_items as { description?: string }[]) : []),
      )
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The held invoice could not be loaded.')
      setLoaded(true)
    }
  }, [fromRunId])

  useEffect(() => {
    void load()
  }, [load])

  // The required fields, and nothing else. Whether we know the vendor decides
  // whether the form is offered at all, below.
  const ready = useMemo(() => orderIsComplete(inputs), [inputs])
  const set = <K extends keyof OrderInputs>(field: K, value: OrderInputs[K]) =>
    setInputs((current) => ({ ...current, [field]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = parseOrderValue(inputs.totalAmount)
    if (!ready || !vendor || !run?.invoice_id || value === null) return

    setSubmitting('Raising the order')
    setError(null)

    try {
      const raised = await raiseOrder({
        vendor,
        invoiceId: run.invoice_id,
        description,
        currency: invoice?.currency ?? 'INR',
        inputs,
      })
      navigate(`/decisions/${raised.runId}`)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} The order may already exist. Check the orders on this vendor, then try again.`
          : 'The order could not be raised. Try again in a moment.',
      )
      setSubmitting(null)
    }
  }

  const holdClasses = tone('hold')

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <Link
            to={fromRunId ? `/decisions/${fromRunId}` : '/'}
            className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the invoice
          </Link>

          {error ? <ErrorNote title="This order could not be raised">{error}</ErrorNote> : null}

          {!loaded ? (
            <Panel>
              <Loading>Loading the held invoice</Loading>
            </Panel>
          ) : !vendor ? (
            /* The printed name resolves to nobody on the approved list as it
               stands, so there is genuinely no vendor to raise an order with. The
               form is not shown at all rather than shown and refusing to submit. */
            <Panel className={cn('border-l-4 px-5 py-4', tone('block').border)}>
              <p className="text-sm text-ink-soft">
                This invoice does not match any company on the approved vendor list, so there is nobody to raise an
                order with. Add the vendor first and we will bring you back here.
              </p>
              <Button asChild className="mt-3" size="sm">
                <Link to={`/vendors/new?from=${fromRunId}`}>Add this vendor</Link>
              </Button>
            </Panel>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <form onSubmit={submit} className="space-y-6">
                <Panel className="px-6 py-6">
                  <h1 className="text-2xl font-semibold text-ink">Raise an order for this invoice</h1>
                  <p className="prose-serif mt-3 max-w-[72ch] text-[17px] text-ink-soft">
                    This invoice cites no order, so there is nothing on file saying the work was agreed. Record what
                    was ordered and we will check the invoice against it from the top.
                  </p>
                </Panel>


                <Panel>
                  <PanelHeading>What was ordered</PanelHeading>
                  <div className="space-y-4 px-5 py-5">
                    <div>
                      <label htmlFor="order-vendor" className={labelClass}>
                        Vendor
                      </label>
                      <input
                        id="order-vendor"
                        className={cn(inputClass, 'text-muted')}
                        value={vendor.legal_name}
                        readOnly
                      />
                    </div>

                    <div>
                      <label htmlFor="order-description" className={labelClass}>
                        Description
                      </label>
                      <input
                        id="order-description"
                        className={inputClass}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="What this order covers"
                      />
                      <p className="mt-1 text-xs text-muted">
                        Taken from the lines on the invoice. Correct it if the order covered something else.
                      </p>
                    </div>
                  </div>
                </Panel>

                <Panel className={cn('border', holdClasses.border)}>
                  <div className={cn('rounded-t-lg px-5 py-3.5', holdClasses.chip)}>
                    <h2 className="text-sm font-semibold">What it was agreed at</h2>
                    <p className="mt-0.5 text-xs">Not taken from the invoice</p>
                  </div>

                  <div className={cn('space-y-4 px-5 py-5', holdClasses.panel, 'rounded-b-lg border-0')}>
                    <p className={cn('prose-serif max-w-[72ch] text-[15px]', holdClasses.text)}>
                      Enter the value that was actually agreed with the vendor. If we copied it off the invoice, the
                      invoice would be checking itself and the amount check would stop working.
                    </p>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="order-value" className={cn(labelClass, holdClasses.text)}>
                          Order value (required)
                        </label>
                        <UnfilledInput
                          id="order-value"
                          className={cn(inputClass, 'tnum')}
                          value={inputs.totalAmount}
                          onValueChange={(next) => set('totalAmount', next)}
                          inputMode="decimal"
                          placeholder="0"
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="order-date" className={cn(labelClass, holdClasses.text)}>
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
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="order-status" className={cn(labelClass, holdClasses.text)}>
                          Status
                        </label>
                        <select
                          id="order-status"
                          className={inputClass}
                          value={inputs.status}
                          onChange={(event) => set('status', event.target.value as OrderInputs['status'])}
                        >
                          <option value="open">Open</option>
                          <option value="closed">Closed</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="order-tax" className={cn(labelClass, holdClasses.text)}>
                          Figures include tax
                        </label>
                        <select
                          id="order-tax"
                          className={inputClass}
                          value={inputs.taxTreatment}
                          onChange={(event) => set('taxTreatment', event.target.value as OrderInputs['taxTreatment'])}
                        >
                          <option value="exclusive">No, tax is added on top</option>
                          <option value="inclusive">Yes, the value includes tax</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </Panel>

                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!ready || submitting !== null} className="gap-2">
                    {submitting ? <Spinner className="border-t-primary-foreground" /> : null}
                    {submitting ?? 'Raise the order and check again'}
                  </Button>
                  {!ready ? <p className="text-sm text-muted">Enter the order value to continue.</p> : null}
                </div>
              </form>

              {/* Right rail */}
              <div className="space-y-6">
                <Panel>
                  <PanelHeading>What happens next</PanelHeading>
                  <ol className="space-y-4 px-5 py-4">
                    {[
                      'We record the order against this vendor with the value you entered.',
                      'We run the same checks on this invoice again, from the top.',
                      'If the invoice is within tolerance of the order, it clears. If it is not, it stops again and says why.',
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

                <Panel>
                  <PanelHeading>What this invoice says</PanelHeading>
                  <div className="space-y-3 px-5 py-4">
                    <div>
                      <p className="text-xs text-muted">Invoice</p>
                      <p className="identifier mt-0.5 text-sm text-ink">{invoice?.invoice_number ?? 'Not read'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted">Invoice date</p>
                      <p className="mt-0.5 text-sm text-ink tnum">{shortDate(invoice?.invoice_date)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted">Total on the invoice</p>
                      <p className="mt-0.5 text-sm text-ink tnum">
                        {money(invoice?.total, invoice?.currency ?? 'INR')}
                      </p>
                      <p className={cn('mt-1 text-xs', holdClasses.text)}>
                        Shown so you can see what is being claimed. It is deliberately not filled into the order.
                      </p>
                    </div>
                  </div>
                </Panel>
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}
