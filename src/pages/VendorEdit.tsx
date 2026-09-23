// Changing a vendor we already pay.
//
// The form is split the same way the onboarding form is, and for the same reason.
// Identity edits freely: names, addresses and tax numbers are corrected all the
// time and nothing about where money goes depends on them.
//
// The account number and the IFSC are the reference every future invoice from this
// vendor is checked against. A vendor legitimately moves banks, and a redirected
// payment looks exactly like a vendor moving banks; what separates them is who
// said so and how they were reached. So changing either one requires a fresh
// verification note before it will save, and records the old value, the new value,
// who made the change and when.
//
// The policy lives in src/lib/vendorEdit.ts, which is pure and tested. This page
// collects the values and shows what is about to happen.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { ErrorNote, Loading, PageBody, Panel, PanelHeading, Spinner } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dateAndTime } from '@/lib/format.ts'
import { applyVendorEdit, getVendorById } from '@/lib/queries.ts'
import { BANK_CONFIRMED_LABEL, BANK_CONFIRMED_MISSING, vendorFieldLabel } from '@/lib/reasonCopy.ts'
import {
  changeRowsFor,
  diffVendorValues,
  editIsComplete,
  touchesPaymentDetails,
  valuesFromVendor,
  vendorPatchFor,
  type VendorEditValues,
} from '@/lib/vendorEdit.ts'
import type { VendorRow } from '@/lib/database.types.ts'

const labelClass = 'block text-xs text-muted'
const inputClass =
  'mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted'

export default function VendorEdit() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [vendor, setVendor] = useState<VendorRow | null>(null)
  const [values, setValues] = useState<VendorEditValues | null>(null)
  const [changedBy, setChangedBy] = useState('')
  // Never carried over from the record. The note explaining how the previous
  // account was confirmed says nothing about the new one.
  const [verificationNote, setVerificationNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const found = await getVendorById(id)
      if (!found) {
        setError('That vendor is not on the list. Go back and choose one from it.')
        setLoaded(true)
        return
      }
      setVendor(found)
      setValues(valuesFromVendor(found))
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That vendor could not be loaded.')
      setLoaded(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const original = useMemo(() => (vendor ? valuesFromVendor(vendor) : null), [vendor])
  const changes = useMemo(
    () => (original && values ? diffVendorValues(original, values) : []),
    [original, values],
  )
  const movesMoney = touchesPaymentDetails(changes)
  const ready = editIsComplete({ changes, changedBy, verificationNote })

  const set = <K extends keyof VendorEditValues>(field: K, value: VendorEditValues[K]) =>
    setValues((current) => (current ? { ...current, [field]: value } : current))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || !vendor || !values) return

    setSaving(true)
    setError(null)
    const at = new Date()

    try {
      await applyVendorEdit({
        vendorId: vendor.id,
        patch: vendorPatchFor({ values, changes, changedBy, verificationNote, at }),
        changes: changeRowsFor({ changes, changedBy, verificationNote, at }),
      })
      navigate('/vendors')
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} Nothing on the vendor was changed. Try again in a moment.`
          : 'This change could not be saved. Nothing on the vendor was changed.',
      )
      setSaving(false)
    }
  }

  const blockClasses = tone('block')

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <Link to="/vendors" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the vendor list
          </Link>

          {error ? <ErrorNote title="This vendor could not be changed">{error}</ErrorNote> : null}

          {!loaded ? (
            <Panel>
              <Loading>Loading the vendor</Loading>
            </Panel>
          ) : !vendor || !values ? null : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <form onSubmit={submit} className="space-y-6">
                <Panel className="px-6 py-6">
                  <h1 className="text-2xl font-semibold text-ink">{vendor.legal_name}</h1>
                  <p className="prose-serif mt-3 max-w-[72ch] text-[17px] text-ink-soft">
                    Correct anything here that is wrong. Changing where payment goes needs a fresh confirmation with
                    the vendor, because that account is what every invoice from them is checked against.
                  </p>
                </Panel>

                <Panel>
                  <PanelHeading>Who they are</PanelHeading>
                  <div className="space-y-4 px-5 py-5">
                    <div>
                      <label htmlFor="legal-name" className={labelClass}>
                        {vendorFieldLabel('legal_name')}
                      </label>
                      <input
                        id="legal-name"
                        className={inputClass}
                        value={values.legal_name}
                        onChange={(event) => set('legal_name', event.target.value)}
                        required
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="gstin" className={labelClass}>
                          {vendorFieldLabel('gstin')}
                        </label>
                        <input
                          id="gstin"
                          className={cn(inputClass, 'identifier')}
                          value={values.gstin}
                          onChange={(event) => set('gstin', event.target.value)}
                        />
                      </div>
                      <div>
                        <label htmlFor="email-domain" className={labelClass}>
                          {vendorFieldLabel('email_domain')}
                        </label>
                        <input
                          id="email-domain"
                          className={inputClass}
                          value={values.email_domain}
                          onChange={(event) => set('email_domain', event.target.value)}
                          placeholder="example.com"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="address" className={labelClass}>
                        {vendorFieldLabel('address')}
                      </label>
                      <input
                        id="address"
                        className={inputClass}
                        value={values.address}
                        onChange={(event) => set('address', event.target.value)}
                      />
                    </div>

                    <div>
                      <label htmlFor="aka" className={labelClass}>
                        {vendorFieldLabel('aliases')}
                      </label>
                      <input
                        id="aka"
                        className={inputClass}
                        value={values.aliases.join(', ')}
                        onChange={(event) =>
                          set(
                            'aliases',
                            event.target.value
                              .split(',')
                              .map((alias) => alias.trim())
                              .filter((alias) => alias.length > 0),
                          )
                        }
                        placeholder="Other names this company invoices under, separated by commas"
                      />
                    </div>

                    <div>
                      <label htmlFor="vendor-status" className={labelClass}>
                        {vendorFieldLabel('status')}
                      </label>
                      <select
                        id="vendor-status"
                        className={inputClass}
                        value={values.status}
                        onChange={(event) => set('status', event.target.value as VendorRow['status'])}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">No longer active</option>
                      </select>
                    </div>
                  </div>
                </Panel>

                <Panel className={cn('border', blockClasses.border)}>
                  <div className={cn('rounded-t-lg px-5 py-3.5', blockClasses.chip)}>
                    <h2 className="text-sm font-semibold">Where payment goes</h2>
                    <p className="mt-0.5 text-xs">Changing either of these needs confirming with the vendor first</p>
                  </div>

                  <div className={cn('space-y-4 px-5 py-5', blockClasses.panel, 'rounded-b-lg border-0')}>
                    <p className={cn('prose-serif max-w-[72ch] text-[15px]', blockClasses.text)}>
                      Confirm the new details with the vendor on a phone number you already have, not one printed on a
                      recent invoice or email. A vendor changing bank account and somebody redirecting your payments
                      look identical from here.
                    </p>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="bank-account" className={cn(labelClass, blockClasses.text)}>
                          {vendorFieldLabel('bank_account')}
                        </label>
                        <input
                          id="bank-account"
                          className={cn(inputClass, 'identifier')}
                          value={values.bank_account}
                          onChange={(event) => set('bank_account', event.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label htmlFor="ifsc" className={cn(labelClass, blockClasses.text)}>
                          {vendorFieldLabel('bank_ifsc')}
                        </label>
                        <input
                          id="ifsc"
                          className={cn(inputClass, 'identifier')}
                          value={values.bank_ifsc}
                          onChange={(event) => set('bank_ifsc', event.target.value)}
                          autoComplete="off"
                        />
                      </div>
                    </div>

                    {/* Only asked for when it is needed, so it never reads as a box
                        to fill in out of habit. */}
                    {movesMoney ? (
                      <div>
                        <label htmlFor="verification" className={cn(labelClass, blockClasses.text)}>
                          Who confirmed these, and how (required)
                        </label>
                        <input
                          id="verification"
                          className={inputClass}
                          value={verificationNote}
                          onChange={(event) => setVerificationNote(event.target.value)}
                          placeholder="Name, and the number you called"
                          autoComplete="off"
                          required
                        />
                      </div>
                    ) : null}
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading>Your name</PanelHeading>
                  <div className="px-5 py-5">
                    <label htmlFor="changed-by" className={labelClass}>
                      Who is making this change (required)
                    </label>
                    <input
                      id="changed-by"
                      className={inputClass}
                      value={changedBy}
                      onChange={(event) => setChangedBy(event.target.value)}
                      placeholder="Your name"
                      required
                    />
                  </div>
                </Panel>

                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!ready || saving} className="gap-2">
                    {saving ? <Spinner className="border-t-primary-foreground" /> : null}
                    {saving ? 'Saving the change' : 'Save this change'}
                  </Button>
                  {changes.length === 0 ? (
                    <p className="text-sm text-muted">Nothing has been changed yet.</p>
                  ) : !ready ? (
                    <p className="text-sm text-muted">
                      {movesMoney
                        ? 'Fill in your name and who confirmed the new details to continue.'
                        : 'Fill in your name to continue.'}
                    </p>
                  ) : null}
                </div>
              </form>

              {/* Right rail */}
              <div className="space-y-6">
                <Panel>
                  <PanelHeading>What this will record</PanelHeading>
                  <div className="px-5 py-4">
                    {changes.length === 0 ? (
                      <p className="text-sm text-muted">Nothing yet. Change a field and it will be listed here.</p>
                    ) : (
                      <ul className="space-y-3">
                        {changes.map((change) => (
                          <li key={change.field} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
                            <p className={cn('text-xs', change.kind === 'payment' ? blockClasses.text : 'text-muted')}>
                              {vendorFieldLabel(change.field)}
                            </p>
                            <div className="mt-1 flex flex-wrap items-baseline gap-2 text-sm">
                              <span className="text-muted line-through">{change.from || 'Nothing'}</span>
                              <span aria-hidden="true" className="text-muted">
                                to
                              </span>
                              <span className="font-medium text-ink">{change.to || 'Nothing'}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Panel>

                <Panel>
                  <PanelHeading>The account on file now</PanelHeading>
                  <div className="space-y-2 px-5 py-4">
                    <p className="identifier text-sm text-ink">
                      {vendor.bank_account ?? 'No account on file'}
                      {vendor.bank_ifsc ? `, ${vendor.bank_ifsc}` : ''}
                    </p>
                    <p className="text-xs text-muted">
                      {vendor.bank_confirmed_by
                        ? `${BANK_CONFIRMED_LABEL}: ${vendor.bank_confirmed_by}`
                        : BANK_CONFIRMED_MISSING}
                    </p>
                    {vendor.bank_confirmed_at ? (
                      <p className="text-xs text-muted tnum">Confirmed {dateAndTime(vendor.bank_confirmed_at)}</p>
                    ) : null}
                    {vendor.bank_changed_at ? (
                      <p className="text-xs text-muted tnum">Last changed {dateAndTime(vendor.bank_changed_at)}</p>
                    ) : null}
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
