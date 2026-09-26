// Adding a vendor with no invoice in front of you.
//
// The counterpart to the flow opened from a held invoice. That one reacts to a
// document from a company we cannot match and prefills identity from what the page
// said; this is the ordinary way round, where a vendor goes on the list before its
// first invoice arrives. Both write the same row, through the same module, and the
// rules read them identically.
//
// Every field here is typed, including the identity half, because there is no
// document to read one off. The payment section is the one thing that is not
// different: account number, IFSC and the verification note are required, start
// empty, and are confirmed out of band. The account on file is what every future
// invoice from this vendor is checked against, so where it came from is the whole
// value of the check, and that is as true on a screen with no invoice as on one
// holding a suspicious document.

import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { ErrorNote, PageBody, Panel, PanelHeading, Spinner, UnfilledInput } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  NEW_VENDOR_INCOMPLETE,
  NEW_VENDOR_INTRO,
  NEW_VENDOR_SUBMIT,
  NEW_VENDOR_TITLE,
  PAYMENT_CONFIRMATION_NOTE,
} from '@/lib/reasonCopy.ts'
import { createVendorWithTrail } from '@/lib/newVendor.ts'
import { emptyPaymentFields, paymentFieldsComplete } from '@/lib/vendorForm.ts'

const labelClass = 'block text-xs text-muted'
const inputClass =
  'mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted'

export default function VendorCreate() {
  const navigate = useNavigate()

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)

  // Identity. Typed, because there is no document here to read it from.
  const [legalName, setLegalName] = useState('')
  const [gstin, setGstin] = useState('')
  const [address, setAddress] = useState('')
  const [emailDomain, setEmailDomain] = useState('')
  const [alsoKnownAs, setAlsoKnownAs] = useState('')

  // Where payment goes. Seeded from a function that takes no document, exactly as
  // the invoice-driven form does, so there is nothing here for a later change to
  // thread a value into. See src/lib/vendorForm.ts.
  const [bankAccount, setBankAccount] = useState(emptyPaymentFields().bankAccount)
  const [ifsc, setIfsc] = useState(emptyPaymentFields().ifsc)
  const [confirmedBy, setConfirmedBy] = useState(emptyPaymentFields().confirmedBy)
  const [addedBy, setAddedBy] = useState('')

  const ready =
    legalName.trim().length > 0 &&
    addedBy.trim().length > 0 &&
    paymentFieldsComplete({ bankAccount, ifsc, confirmedBy })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || submitting !== null) return

    setSubmitting('Adding the vendor')
    setError(null)

    try {
      await createVendorWithTrail({
        legalName,
        gstin,
        address,
        emailDomain,
        alsoKnownAs,
        bankAccount,
        ifsc,
        confirmedBy,
        addedBy,
      })
      navigate('/vendors')
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
            to="/vendors"
            className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the vendors
          </Link>

          {error ? <ErrorNote title="This vendor could not be added">{error}</ErrorNote> : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <form onSubmit={submit} className="space-y-6">
              <Panel className="px-6 py-6">
                <h1 className="text-2xl font-semibold text-ink">{NEW_VENDOR_TITLE}</h1>
                <p className="prose-serif mt-3 max-w-[72ch] text-[17px] text-ink-soft">{NEW_VENDOR_INTRO}</p>
              </Panel>

              <Panel>
                <PanelHeading>Who they are</PanelHeading>
                <div className="space-y-4 px-5 py-5">
                  <div>
                    <label htmlFor="legal-name" className={labelClass}>
                      Registered name (required)
                    </label>
                    <input
                      id="legal-name"
                      className={inputClass}
                      value={legalName}
                      onChange={(event) => setLegalName(event.target.value)}
                      placeholder="The name the company is registered under"
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
                    <p className="mt-1 text-xs text-muted">
                      A company that invoices under one name and asks to be paid under another is one vendor with two
                      names. Both are needed to recognise its next invoice.
                    </p>
                  </div>
                </div>
              </Panel>

              {/* The same section, the same rule and the same sentence as the
                  invoice-driven form. Nothing is prefilled on either, and here
                  there is nothing that could be. */}
              <Panel className={cn('border', blockClasses.border)}>
                <div className={cn('rounded-t-lg px-5 py-3.5', blockClasses.chip)}>
                  <h2 className="text-sm font-semibold">Where payment goes</h2>
                  <p className="mt-0.5 text-xs">Confirmed with the vendor, not taken from a document</p>
                </div>

                <div className={cn('space-y-4 px-5 py-5', blockClasses.panel, 'rounded-b-lg border-0')}>
                  <p className={cn('prose-serif max-w-[72ch] text-[15px]', blockClasses.text)}>
                    {PAYMENT_CONFIRMATION_NOTE}
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
                  <p className="mt-1 text-xs text-muted">
                    Recorded against the company, so the list can say who put it there. That is the first question asked
                    of a vendor nobody recognises.
                  </p>
                </div>
              </Panel>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={!ready || submitting !== null} className="gap-2">
                  {submitting ? <Spinner className="border-t-primary-foreground" /> : null}
                  {submitting ?? NEW_VENDOR_SUBMIT}
                </Button>
                {!ready ? <p className="text-sm text-muted">{NEW_VENDOR_INCOMPLETE}</p> : null}
              </div>
            </form>

            {/* Right rail */}
            <div className="space-y-6">
              <Panel>
                <PanelHeading>What happens next</PanelHeading>
                <ol className="space-y-4 px-5 py-4">
                  {[
                    'We add the company to the approved vendor list with the account you confirmed.',
                    'Invoices that arrive from it are matched to it, by the registered name or by one of its other names.',
                    'Every invoice is checked against the account on file. One printed with a different account stops and says so.',
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
        </div>
      </PageBody>
    </AppShell>
  )
}
