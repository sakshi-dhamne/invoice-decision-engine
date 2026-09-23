// Adding a vendor we have never paid before.
//
// The split down this form is the whole point of it, and it is a control rather
// than a layout choice.
//
// Identity comes off the invoice, because who the company says it is is exactly
// what the document is for. Payment details do not, and cannot. The bank check
// compares what is printed on an invoice against what we hold on file. If we fill
// the file in from the invoice, the two sides of that comparison are the same
// piece of paper, every future invoice from this vendor agrees with itself, and
// the control that catches a redirected payment is switched off at the moment it
// is created. So those three fields start empty, stay required, and are confirmed
// out of band.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { ErrorNote, Loading, PageBody, Panel, PanelHeading, Spinner, UnfilledInput } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { money, shortDate } from '@/lib/format.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { createVendor, getInvoiceById, getRunById, getStageLogs, updateRun } from '@/lib/queries.ts'
import { recordVendorCreated } from '@/lib/vendorHistory.ts'
import { emptyPaymentFields, identityPrefill, paymentFieldsComplete } from '@/lib/vendorForm.ts'
import type { InvoiceRow, RunRow } from '@/lib/database.types.ts'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// Vendor ids are a text primary key. Derive something legible from the name and
// keep it unique without asking the person to invent a code.
function vendorIdFor(name: string): string {
  const stem = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 6)
  return `${stem || 'VENDOR'}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

const labelClass = 'block text-xs text-muted'
const inputClass =
  'mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted'

export default function VendorNew() {
  const [params] = useSearchParams()
  const fromRunId = params.get('from') ?? ''
  const navigate = useNavigate()

  const [run, setRun] = useState<RunRow | null>(null)
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null)
  const [extraction, setExtraction] = useState<Record<string, unknown> | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)

  // From the invoice. Prefilled, editable.
  const [legalName, setLegalName] = useState('')
  const [gstin, setGstin] = useState('')
  const [address, setAddress] = useState('')
  const [emailDomain, setEmailDomain] = useState('')
  const [alsoKnownAs, setAlsoKnownAs] = useState('')

  // Where payment goes. Never prefilled, and the initial value comes from a
  // function that takes no document, so there is nothing here for a later change
  // to thread an extracted value into. See src/lib/vendorForm.ts.
  const [bankAccount, setBankAccount] = useState(emptyPaymentFields().bankAccount)
  const [ifsc, setIfsc] = useState(emptyPaymentFields().ifsc)
  const [confirmedBy, setConfirmedBy] = useState(emptyPaymentFields().confirmedBy)
  // Who is doing the adding. Recorded on the vendor so the list can say who put
  // each company on it, which is the first question asked of a vendor nobody
  // recognises.
  const [addedBy, setAddedBy] = useState('')

  const load = useCallback(async () => {
    if (!fromRunId) {
      setError('This page needs to be opened from a held invoice, so it knows which company you are adding.')
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
      const [doc, stages] = await Promise.all([getInvoiceById(fresh.invoice_id), getStageLogs(fromRunId)])
      const read = asRecord(stages.find((stage) => stage.stage === 'extract')?.output)

      setRun(fresh)
      setInvoice(doc)
      setExtraction(read)

      // Identity, taken from the document. This is the half that may be prefilled,
      // and the only half: identityPrefill returns nothing about payment.
      const identity = identityPrefill(read, doc?.vendor_name_as_printed ?? null)
      setLegalName(identity.legalName)
      setAlsoKnownAs(identity.alsoKnownAs)
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The held invoice could not be loaded.')
      setLoaded(true)
    }
  }, [fromRunId])

  useEffect(() => {
    void load()
  }, [load])

  const printedBankAccount = useMemo(() => {
    const fromExtraction = typeof extraction?.bank_account === 'string' ? extraction.bank_account : null
    return fromExtraction ?? invoice?.bank_account_printed ?? 'Not read'
  }, [extraction, invoice])

  // Shown beside the account for the same reason the account is shown: both have
  // to be read back on the phone, and an account number alone does not identify a
  // branch.
  const printedIfsc = useMemo(
    () => (typeof extraction?.bank_ifsc === 'string' ? extraction.bank_ifsc : null) ?? 'Not read',
    [extraction],
  )

  const ready =
    legalName.trim().length > 0 &&
    addedBy.trim().length > 0 &&
    paymentFieldsComplete({ bankAccount, ifsc, confirmedBy })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || !run?.invoice_id) return

    setSubmitting('Adding the vendor')
    setError(null)

    try {
      const now = new Date().toISOString()
      const vendorId = vendorIdFor(legalName)

      await createVendor({
        id: vendorId,
        legal_name: legalName.trim(),
        status: 'active',
        aliases: alsoKnownAs
          .split(',')
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 0 && alias !== legalName.trim()),
        bank_account: bankAccount.trim(),
        bank_ifsc: ifsc.trim(),
        bank_confirmed_by: confirmedBy.trim(),
        // Dated, so the confirmation can be aged. A note with no date cannot say
        // whether the check happened this week or three years ago.
        bank_confirmed_at: now,
        gstin: gstin.trim() || null,
        address: address.trim() || null,
        email_domain: emailDomain.trim() || null,
        added_by: addedBy.trim(),
      })

      // The first entry in this vendor's history, so the account it was created
      // with is on the trail rather than only in the row it will later be edited
      // out of. Best effort: the vendor exists either way, and a missing history
      // table must not strand a person on a held invoice.
      await recordVendorCreated({
        vendorId,
        account: bankAccount.trim(),
        ifsc: ifsc.trim(),
        addedBy: addedBy.trim(),
        verificationNote: confirmedBy.trim(),
        at: now,
      }).catch(() => undefined)

      setSubmitting('Checking the invoice again')
      let newRunId: string | null = null
      const outcome = await runInvoice(run.invoice_id, {
        onRunCreated: (created) => {
          newRunId = created.id
        },
      })

      // Link the second attempt to the first so the trail shows both. The rules
      // engine sets this itself when it recognises a resubmission; it cannot here,
      // because the first attempt resolved to no vendor at all and the two runs
      // have no vendor in common to match on.
      if (newRunId && !outcome.run.parent_run_id) {
        await updateRun(newRunId, { parent_run_id: run.id }).catch(() => undefined)
      }

      navigate(`/decisions/${newRunId ?? outcome.run.id}`)
      return
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} The vendor may already exist. Check the vendor list, then try again.`
          : 'The vendor could not be added. Try again in a moment.',
      )
      setSubmitting(null)
    }
  }

  const blockClasses = tone('block')

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

        {error ? <ErrorNote title="This vendor could not be added">{error}</ErrorNote> : null}

        {!loaded ? (
          <Panel>
            <Loading>Loading the held invoice</Loading>
          </Panel>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <form onSubmit={submit} className="space-y-6">
              <Panel className="px-6 py-6">
                <h1 className="text-2xl font-semibold text-ink">
                  {legalName || 'This company'} is not on the approved vendor list
                </h1>
                <p className="prose-serif mt-3 max-w-[72ch] text-[17px] text-ink-soft">
                  We hold an invoice when we cannot match the company that sent it to one we already pay. Add the company
                  here and confirm where its money should go, and we will run the same checks on the invoice again.
                </p>
              </Panel>

              <Panel>
                <PanelHeading>From the invoice</PanelHeading>
                <div className="space-y-4 px-5 py-5">
                  <p className="text-sm text-muted">
                    Read from the document. Correct anything the page got wrong.
                  </p>

                  <div>
                    <label htmlFor="legal-name" className={labelClass}>
                      Registered name
                    </label>
                    <input
                      id="legal-name"
                      className={inputClass}
                      value={legalName}
                      onChange={(event) => setLegalName(event.target.value)}
                      required
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="gstin" className={labelClass}>
                        Tax registration number
                      </label>
                      <input
                        id="gstin"
                        className={cn(inputClass, 'identifier')}
                        value={gstin}
                        onChange={(event) => setGstin(event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="email-domain" className={labelClass}>
                        Billing domain
                      </label>
                      <input
                        id="email-domain"
                        className={inputClass}
                        value={emailDomain}
                        onChange={(event) => setEmailDomain(event.target.value)}
                        placeholder="example.com"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="address" className={labelClass}>
                      Address
                    </label>
                    <input
                      id="address"
                      className={inputClass}
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                    />
                  </div>

                  <div>
                    <label htmlFor="aka" className={labelClass}>
                      Also known as
                    </label>
                    <input
                      id="aka"
                      className={inputClass}
                      value={alsoKnownAs}
                      onChange={(event) => setAlsoKnownAs(event.target.value)}
                      placeholder="Other names this company invoices under, separated by commas"
                    />
                  </div>
                </div>
              </Panel>

              <Panel className={cn('border', blockClasses.border)}>
                <div className={cn('rounded-t-lg px-5 py-3.5', blockClasses.chip)}>
                  <h2 className="text-sm font-semibold">Where payment goes</h2>
                  <p className="mt-0.5 text-xs">Not taken from the invoice</p>
                </div>

                <div className={cn('space-y-4 px-5 py-5', blockClasses.panel, 'rounded-b-lg border-0')}>
                  <p className={cn('prose-serif max-w-[72ch] text-[15px]', blockClasses.text)}>
                    Confirm these with the vendor on a phone number you already have. If we copied them off the invoice,
                    the invoice would be checking itself and the fraud control would stop working.
                  </p>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="bank-account" className={cn(labelClass, blockClasses.text)}>
                        Account number (required)
                      </label>
                      <UnfilledInput
                        id="bank-account"
                        className={cn(inputClass, 'identifier')}
                        value={bankAccount}
                        onValueChange={setBankAccount}
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="ifsc" className={cn(labelClass, blockClasses.text)}>
                        IFSC (required)
                      </label>
                      <UnfilledInput
                        id="ifsc"
                        className={cn(inputClass, 'identifier')}
                        value={ifsc}
                        onValueChange={setIfsc}
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="confirmed-by" className={cn(labelClass, blockClasses.text)}>
                      Who confirmed these, and how (required)
                    </label>
                    <UnfilledInput
                      id="confirmed-by"
                      className={inputClass}
                      value={confirmedBy}
                      onValueChange={setConfirmedBy}
                      placeholder="Name, and the number you called"
                      required
                    />
                  </div>
                </div>
              </Panel>

              <Panel>
                <PanelHeading>Your name</PanelHeading>
                <div className="px-5 py-5">
                  <label htmlFor="added-by" className={labelClass}>
                    Who is adding this vendor (required)
                  </label>
                  <input
                    id="added-by"
                    className={inputClass}
                    value={addedBy}
                    onChange={(event) => setAddedBy(event.target.value)}
                    placeholder="Your name"
                    required
                  />
                </div>
              </Panel>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={!ready || submitting !== null} className="gap-2">
                  {submitting ? <Spinner className="border-t-primary-foreground" /> : null}
                  {submitting ?? 'Add the vendor and check again'}
                </Button>
                {!ready ? (
                  <p className="text-sm text-muted">
                    Fill in the registered name, your name and all three payment fields to continue.
                  </p>
                ) : null}
              </div>
            </form>

            {/* Right rail */}
            <div className="space-y-6">
              <Panel>
                <PanelHeading>What happens next</PanelHeading>
                <ol className="space-y-4 px-5 py-4">
                  {[
                    'We add the company to the approved vendor list with the account you confirmed.',
                    'We run the same checks on this invoice again, from the top.',
                    'Both attempts stay on the record, so anyone can see what changed and why.',
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
                    <p className="text-xs text-muted">Total</p>
                    <p className="mt-0.5 text-sm text-ink tnum">
                      {money(invoice?.total, invoice?.currency ?? 'INR')}
                    </p>
                  </div>

                  <div className={cn('rounded-md border px-3 py-2.5', blockClasses.panel)}>
                    <p className={cn('text-xs font-medium', blockClasses.text)}>Bank account printed on the invoice</p>
                    <p className={cn('identifier mt-1 text-sm', blockClasses.text)}>{printedBankAccount}</p>
                    <p className={cn('mt-2 text-xs font-medium', blockClasses.text)}>IFSC printed on the invoice</p>
                    <p className={cn('identifier mt-1 text-sm', blockClasses.text)}>{printedIfsc}</p>
                    <p className={cn('mt-2 text-xs', blockClasses.text)}>
                      Shown so you can read both back to the vendor on the phone. Neither is filled into the form.
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
