// The vendor record: what the onboarding form may and may not take off a
// document, and what changing a vendor's bank details has to leave behind.

import { describe, expect, it } from 'vitest'

import {
  emptyPaymentFields,
  identityPrefill,
  paymentFieldsComplete,
} from '../src/lib/vendorForm.ts'
import {
  bankChangedRecently,
  changeRowsFor,
  daysSinceBankChange,
  diffVendorValues,
  editIsComplete,
  isPaymentField,
  PAYMENT_FIELDS,
  RECENT_BANK_CHANGE_DAYS,
  touchesPaymentDetails,
  valuesFromVendor,
  vendorPatchFor,
  type VendorEditValues,
} from '../src/lib/vendorEdit.ts'
import { aliasesFrom, newVendorIsComplete, vendorIdFor } from '../src/lib/newVendor.ts'
import { VENDOR_FROM_SEED, vendorAddedBy } from '../src/lib/reasonCopy.ts'
import type { VendorRow } from '../src/lib/database.types.ts'

// ---------------------------------------------------------------------------
// The onboarding split
// ---------------------------------------------------------------------------

// Whatever the model read off the page, including a full set of plausible payment
// details, the form's payment fields have to start empty. Filling them from the
// document would point the bank-detail check at the document it exists to check,
// and every future invoice from the vendor would then agree with itself.
describe('the vendor form never takes payment details off the invoice', () => {
  const extractionWithEverything = {
    vendor_name: 'Meridian Components Pvt Ltd',
    remit_to_name: 'Meridian Components',
    bank_account: '500100200300400',
    bank_ifsc: 'HDFC0001234',
    // The shapes a future schema change might add. None of them may leak either.
    account_number: '999888777666',
    ifsc: 'ICIC0004321',
    bank_name: 'Some Bank',
  }

  it('starts every payment field empty', () => {
    expect(emptyPaymentFields()).toEqual({ bankAccount: '', ifsc: '', confirmedBy: '' })
  })

  it.each([
    ['a full extraction', extractionWithEverything],
    ['an empty extraction', {}],
    ['no extraction at all', null],
  ])('renders the payment fields empty given %s', (_label, extraction) => {
    // identityPrefill is the only thing the form fills from the document, and the
    // payment fields are seeded from emptyPaymentFields() beside it. Together
    // these are the form's whole initial state.
    const prefill = identityPrefill(extraction, 'Meridian Components Pvt Ltd')
    const payment = emptyPaymentFields()

    expect(payment.bankAccount).toBe('')
    expect(payment.ifsc).toBe('')
    expect(payment.confirmedBy).toBe('')
    // And nothing resembling an account number rode in on the identity half.
    expect(JSON.stringify(prefill)).not.toContain('500100200300400')
    expect(JSON.stringify(prefill)).not.toContain('HDFC0001234')
    expect(JSON.stringify(prefill)).not.toContain('999888777666')
  })

  it('returns identity fields only, whatever the extraction holds', () => {
    const prefill = identityPrefill(extractionWithEverything, null)
    expect(Object.keys(prefill).sort()).toEqual(['alsoKnownAs', 'legalName'])
  })

  it('does prefill the identity half, which is the point of the split', () => {
    const prefill = identityPrefill(extractionWithEverything, null)
    expect(prefill.legalName).toBe('Meridian Components Pvt Ltd')
    expect(prefill.alsoKnownAs).toBe('Meridian Components Pvt Ltd, Meridian Components')
  })

  it('falls back to the name on the invoice row when the model read none', () => {
    expect(identityPrefill({}, 'Zenith Traders').legalName).toBe('Zenith Traders')
    expect(identityPrefill(null, null).legalName).toBe('')
  })

  it('does not repeat the legal name as an alias when the remit-to matches it', () => {
    const prefill = identityPrefill({ vendor_name: 'Acme Ltd', remit_to_name: 'Acme Ltd' }, null)
    expect(prefill.alsoKnownAs).toBe('Acme Ltd')
  })

  it('will not submit until all three payment fields are filled', () => {
    expect(paymentFieldsComplete(emptyPaymentFields())).toBe(false)
    expect(paymentFieldsComplete({ bankAccount: '123', ifsc: '', confirmedBy: 'Rang up Priya' })).toBe(false)
    expect(paymentFieldsComplete({ bankAccount: '123', ifsc: 'HDFC0001234', confirmedBy: '   ' })).toBe(false)
    expect(paymentFieldsComplete({ bankAccount: '123', ifsc: 'HDFC0001234', confirmedBy: 'Rang up Priya' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Editing a vendor
// ---------------------------------------------------------------------------

const vendor: VendorRow = {
  id: 'MER-1',
  legal_name: 'Meridian Components Pvt Ltd',
  aliases: ['Meridian Components'],
  bank_account: '500100200300400',
  bank_ifsc: 'HDFC0001234',
  bank_confirmed_by: 'Rang Priya on the number on the contract',
  bank_confirmed_at: '2026-01-10T00:00:00Z',
  bank_changed_at: null,
  gstin: '27AABCU9603R1ZX',
  address: 'Pune',
  email_domain: 'meridian.example',
  status: 'active',
  created_at: '2026-01-10T00:00:00Z',
  added_by: 'Asha',
  updated_at: null,
  updated_by: null,
}

const unchanged = (): VendorEditValues => valuesFromVendor(vendor)

describe('editing a vendor', () => {
  it('lets identity fields change with nothing beyond a name against them', () => {
    const changes = diffVendorValues(unchanged(), { ...unchanged(), address: 'Mumbai' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ field: 'address', kind: 'identity', from: 'Pune', to: 'Mumbai' })
    expect(touchesPaymentDetails(changes)).toBe(false)
    expect(editIsComplete({ changes, changedBy: 'Asha', verificationNote: '' })).toBe(true)
  })

  it('classifies the account and the IFSC as payment changes', () => {
    for (const field of PAYMENT_FIELDS) expect(isPaymentField(field)).toBe(true)
    expect(isPaymentField('address')).toBe(false)
    expect(isPaymentField('legal_name')).toBe(false)
  })

  it('refuses a bank change with no fresh verification note', () => {
    const changes = diffVendorValues(unchanged(), { ...unchanged(), bank_account: '600200300400500' })
    expect(touchesPaymentDetails(changes)).toBe(true)
    expect(editIsComplete({ changes, changedBy: 'Asha', verificationNote: '' })).toBe(false)
    expect(editIsComplete({ changes, changedBy: 'Asha', verificationNote: '   ' })).toBe(false)
    expect(editIsComplete({ changes, changedBy: 'Asha', verificationNote: 'Rang Priya back' })).toBe(true)
  })

  it('refuses any edit with no name against it', () => {
    const changes = diffVendorValues(unchanged(), { ...unchanged(), address: 'Mumbai' })
    expect(editIsComplete({ changes, changedBy: '', verificationNote: '' })).toBe(false)
  })

  it('has nothing to save when nothing changed', () => {
    expect(diffVendorValues(unchanged(), unchanged())).toEqual([])
    expect(editIsComplete({ changes: [], changedBy: 'Asha', verificationNote: 'x' })).toBe(false)
  })

  it('records the old value, the new value, who and when', () => {
    const at = new Date('2026-09-20T09:30:00Z')
    const changes = diffVendorValues(unchanged(), { ...unchanged(), bank_account: '600200300400500' })
    const rows = changeRowsFor({ changes, changedBy: 'Asha', verificationNote: 'Rang Priya back', at })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      kind: 'payment',
      field: 'bank_account',
      old_value: '500100200300400',
      new_value: '600200300400500',
      changed_by: 'Asha',
      verification_note: 'Rang Priya back',
      changed_at: at.toISOString(),
    })
  })

  it('attaches the verification note to the payment row and to nothing else', () => {
    const at = new Date('2026-09-20T09:30:00Z')
    const changes = diffVendorValues(unchanged(), {
      ...unchanged(),
      bank_ifsc: 'ICIC0004321',
      address: 'Mumbai',
    })
    const rows = changeRowsFor({ changes, changedBy: 'Asha', verificationNote: 'Rang Priya back', at })

    const payment = rows.find((row) => row.field === 'bank_ifsc')
    const identity = rows.find((row) => row.field === 'address')
    expect(payment?.verification_note).toBe('Rang Priya back')
    expect(identity?.verification_note).toBeNull()
    expect(identity?.kind).toBe('identity')
  })

  it('stamps the bank columns only when the bank details actually moved', () => {
    const at = new Date('2026-09-20T09:30:00Z')

    const identityOnly = diffVendorValues(unchanged(), { ...unchanged(), address: 'Mumbai' })
    const identityPatch = vendorPatchFor({
      values: { ...unchanged(), address: 'Mumbai' },
      changes: identityOnly,
      changedBy: 'Asha',
      verificationNote: '',
      at,
    })
    // An address correction must not make the account look freshly confirmed.
    expect(identityPatch.bank_changed_at).toBeUndefined()
    expect(identityPatch.bank_confirmed_at).toBeUndefined()
    expect(identityPatch.updated_by).toBe('Asha')

    const bankMoved = diffVendorValues(unchanged(), { ...unchanged(), bank_account: '600200300400500' })
    const bankPatch = vendorPatchFor({
      values: { ...unchanged(), bank_account: '600200300400500' },
      changes: bankMoved,
      changedBy: 'Asha',
      verificationNote: 'Rang Priya back',
      at,
    })
    expect(bankPatch.bank_changed_at).toBe(at.toISOString())
    expect(bankPatch.bank_confirmed_at).toBe(at.toISOString())
    expect(bankPatch.bank_confirmed_by).toBe('Rang Priya back')
  })
})

// ---------------------------------------------------------------------------
// A recently changed account, on an invoice being decided
// ---------------------------------------------------------------------------

describe('a bank account that moved recently', () => {
  const asOf = new Date('2026-09-20T00:00:00Z')
  const movedOn = (date: string): Pick<VendorRow, 'bank_changed_at'> => ({ bank_changed_at: date })

  it('is silent about a vendor whose account has never moved', () => {
    expect(bankChangedRecently({ bank_changed_at: null }, asOf)).toBe(false)
    expect(daysSinceBankChange({ bank_changed_at: null }, asOf)).toBeNull()
  })

  it('surfaces a change inside the window', () => {
    expect(bankChangedRecently(movedOn('2026-09-18T00:00:00Z'), asOf)).toBe(true)
    expect(daysSinceBankChange(movedOn('2026-09-18T00:00:00Z'), asOf)).toBe(2)
  })

  it('stays quiet about one outside it', () => {
    expect(bankChangedRecently(movedOn('2026-06-01T00:00:00Z'), asOf)).toBe(false)
  })

  it('treats the boundary day as inside the window', () => {
    const boundary = new Date(asOf.getTime() - RECENT_BANK_CHANGE_DAYS * 86_400_000).toISOString()
    expect(bankChangedRecently(movedOn(boundary), asOf)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Who put this vendor on the list
// ---------------------------------------------------------------------------

// Most of the vendor list came with the corpus. Reading the empty `added_by` on
// those rows as "by somebody not recorded" accused the starting data of a lapse
// that never happened, on nearly every row on the page.
describe('a vendor that came with the starting data', () => {
  it('says so, rather than blaming somebody for not recording a name', () => {
    expect(vendorAddedBy(null)).toBe(VENDOR_FROM_SEED)
    expect(vendorAddedBy(undefined)).toBe(VENDOR_FROM_SEED)
    expect(vendorAddedBy('   ')).toBe(VENDOR_FROM_SEED)
    expect(VENDOR_FROM_SEED).not.toContain('not recorded')
  })

  it('keeps the real name for a vendor a person actually added', () => {
    expect(vendorAddedBy('Asha')).toBe('Added by Asha')
  })
})

// ---------------------------------------------------------------------------
// Adding a vendor, from either flow
// ---------------------------------------------------------------------------

describe('what a new vendor record is made of', () => {
  const filled = {
    legalName: 'Northwind Components Pvt Ltd',
    gstin: '27AABCN1234C1Z5',
    address: 'Unit 4, MIDC Industrial Area, Pune',
    emailDomain: 'northwind.example',
    alsoKnownAs: 'Northwind, Northwind Components',
    bankAccount: '50100999888777',
    ifsc: 'HDFC0001234',
    confirmedBy: 'Rao, on the number on file',
    addedBy: 'Sakshi',
  }

  it('derives a legible id from the name', () => {
    expect(vendorIdFor('Northwind Components Pvt Ltd')).toMatch(/^NORTHW-[A-Z0-9]{4}$/)
    expect(vendorIdFor('Acme Technologies')).toMatch(/^ACMETE-[A-Z0-9]{4}$/)
  })

  it('keeps two companies with the same stem apart', () => {
    const ids = new Set(Array.from({ length: 50 }, () => vendorIdFor('Acme')))
    expect(ids.size).toBeGreaterThan(1)
  })

  it('falls back to a name rather than an empty id when there is nothing to work from', () => {
    expect(vendorIdFor('...')).toMatch(/^VENDOR-[A-Z0-9]{4}$/)
    expect(vendorIdFor('')).toMatch(/^VENDOR-[A-Z0-9]{4}$/)
  })

  it('takes the other names as aliases, without repeating the legal name', () => {
    expect(aliasesFrom('Northwind, Northwind Components', 'Northwind Components Pvt Ltd')).toEqual([
      'Northwind',
      'Northwind Components',
    ])
  })

  it('drops the legal name and the blanks from the aliases', () => {
    expect(aliasesFrom('Acme, , Acme Technologies Pvt Ltd,  ', 'Acme Technologies Pvt Ltd')).toEqual(['Acme'])
    expect(aliasesFrom('', 'Acme')).toEqual([])
  })

  it('will not save until the name, the person and all three payment fields are there', () => {
    expect(newVendorIsComplete(filled)).toBe(true)
  })

  it.each([
    ['legalName', 'the registered name'],
    ['addedBy', 'a name against the act'],
    ['bankAccount', 'the account number'],
    ['ifsc', 'the IFSC'],
    ['confirmedBy', 'the verification note'],
  ] as const)('refuses to save with no %s', (field, description) => {
    expect(newVendorIsComplete({ ...filled, [field]: '' }), description).toBe(false)
    // Whitespace is not an answer either.
    expect(newVendorIsComplete({ ...filled, [field]: '   ' }), description).toBe(false)
  })

  it('does not require the fields a document would have supplied', () => {
    // Tax number, address, billing domain and other names are all optional, on both
    // flows. The standalone form has no document to read them from.
    for (const field of ['gstin', 'address', 'emailDomain', 'alsoKnownAs'] as const) {
      expect(newVendorIsComplete({ ...filled, [field]: '' }), field).toBe(true)
    }
  })
})
