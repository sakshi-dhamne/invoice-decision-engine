// Editing a vendor, and what each kind of edit costs.
//
// A vendor's identity moves for dull reasons. Companies are renamed, addresses are
// corrected, somebody notices the tax number was typed wrong. None of that changes
// where the money goes, and requiring a phone call before an address can be fixed
// would only teach people that the phone call is a formality.
//
// The account number and the IFSC are different in kind. They are the reference
// every future invoice from this vendor is checked against, and changing them is
// the single highest-risk action in the system. A vendor really does move banks,
// and a redirected payment looks exactly like a vendor moving banks. What tells
// them apart is who said so and how they were reached, so that is required at the
// moment of the change and recorded against it.
//
// Pure: no database, no clock except one passed in. pipeline-style separation, so
// the policy can be tested without a vendor table.

import type { VendorChangeInsert, VendorChangeKind, VendorRow } from './database.types.ts'

/** The two fields that decide where money goes. */
export const PAYMENT_FIELDS = ['bank_account', 'bank_ifsc'] as const

/** Everything else a person may edit. */
export const IDENTITY_FIELDS = ['legal_name', 'aliases', 'gstin', 'address', 'email_domain', 'status'] as const

export type EditableField = (typeof PAYMENT_FIELDS)[number] | (typeof IDENTITY_FIELDS)[number]

export const EDITABLE_FIELDS: readonly EditableField[] = [...IDENTITY_FIELDS, ...PAYMENT_FIELDS]

/**
 * How recently counts as recently, for a changed bank account.
 *
 * Thirty days is the window a reviewer is shown a warning in. It is not a rule
 * threshold: no verdict moves on it, and it lives here rather than in the rules
 * table because nothing in src/rules/ reads it. It is a note on a screen.
 */
export const RECENT_BANK_CHANGE_DAYS = 30

export function isPaymentField(field: string): boolean {
  return (PAYMENT_FIELDS as readonly string[]).includes(field)
}

/** The shape the edit form hands back. Aliases arrive as a list, everything else as text. */
export interface VendorEditValues {
  legal_name: string
  aliases: string[]
  gstin: string
  address: string
  email_domain: string
  status: VendorRow['status']
  bank_account: string
  bank_ifsc: string
}

export function valuesFromVendor(vendor: VendorRow): VendorEditValues {
  return {
    legal_name: vendor.legal_name,
    aliases: vendor.aliases ?? [],
    gstin: vendor.gstin ?? '',
    address: vendor.address ?? '',
    email_domain: vendor.email_domain ?? '',
    status: vendor.status,
    bank_account: vendor.bank_account ?? '',
    bank_ifsc: vendor.bank_ifsc ?? '',
  }
}

function asComparable(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value.trim()
}

export interface VendorFieldChange {
  field: EditableField
  kind: VendorChangeKind
  from: string
  to: string
}

/** Which fields actually moved, and how each one is classified. */
export function diffVendorValues(before: VendorEditValues, after: VendorEditValues): VendorFieldChange[] {
  const changes: VendorFieldChange[] = []
  for (const field of EDITABLE_FIELDS) {
    const from = asComparable(before[field])
    const to = asComparable(after[field])
    if (from === to) continue
    changes.push({ field, kind: isPaymentField(field) ? 'payment' : 'identity', from, to })
  }
  return changes
}

/** Whether this edit moves money, and therefore needs a fresh verification note. */
export function touchesPaymentDetails(changes: readonly VendorFieldChange[]): boolean {
  return changes.some((change) => change.kind === 'payment')
}

/**
 * Whether the edit may be saved.
 *
 * An identity edit needs a name against it and nothing more. A payment change
 * needs a fresh verification note as well, and "fresh" is the point: the note from
 * the last time the account was confirmed says nothing about this account.
 */
export function editIsComplete(input: {
  changes: readonly VendorFieldChange[]
  changedBy: string
  verificationNote: string
}): boolean {
  if (input.changes.length === 0) return false
  if (input.changedBy.trim().length === 0) return false
  return !touchesPaymentDetails(input.changes) || input.verificationNote.trim().length > 0
}

/**
 * The trail rows for an edit.
 *
 * One per field, so a payment change saved alongside an address correction is two
 * rows of different kinds rather than one row that is somehow both. The
 * verification note is attached to the payment rows only: it is the evidence for
 * the account, and putting it on an address change would suggest somebody rang up
 * to confirm a postcode.
 */
export function changeRowsFor(input: {
  changes: readonly VendorFieldChange[]
  changedBy: string
  verificationNote: string
  at: Date
}): Omit<VendorChangeInsert, 'vendor_id'>[] {
  const changedAt = input.at.toISOString()
  return input.changes.map((change) => ({
    kind: change.kind,
    field: change.field,
    old_value: change.from.length > 0 ? change.from : null,
    new_value: change.to.length > 0 ? change.to : null,
    changed_by: input.changedBy.trim(),
    verification_note: change.kind === 'payment' ? input.verificationNote.trim() : null,
    changed_at: changedAt,
  }))
}

/**
 * The columns to write on the vendor row itself.
 *
 * `bank_changed_at` and the confirmation note move only when the payment details
 * do. An identity edit must not restamp them: doing so would make a vendor whose
 * address was corrected yesterday look like a vendor whose account was confirmed
 * yesterday, which is exactly the signal the decision screens read.
 */
export function vendorPatchFor(input: {
  values: VendorEditValues
  changes: readonly VendorFieldChange[]
  changedBy: string
  verificationNote: string
  at: Date
}): Record<string, unknown> {
  const at = input.at.toISOString()
  const patch: Record<string, unknown> = {
    legal_name: input.values.legal_name.trim(),
    aliases: input.values.aliases,
    gstin: input.values.gstin.trim() || null,
    address: input.values.address.trim() || null,
    email_domain: input.values.email_domain.trim() || null,
    status: input.values.status,
    bank_account: input.values.bank_account.trim() || null,
    bank_ifsc: input.values.bank_ifsc.trim() || null,
    updated_at: at,
    updated_by: input.changedBy.trim(),
  }

  if (touchesPaymentDetails(input.changes)) {
    patch.bank_changed_at = at
    patch.bank_confirmed_by = input.verificationNote.trim()
    patch.bank_confirmed_at = at
  }

  return patch
}

/**
 * How many days ago the bank details moved, or null if they never have.
 *
 * Read by the decision screens rather than by any rule. An invoice arriving
 * against a vendor whose account changed a fortnight ago is the shape a business
 * email compromise takes, and the person deciding it should be looking at that
 * fact rather than having to go and find it.
 */
export function daysSinceBankChange(
  vendor: Pick<VendorRow, 'bank_changed_at'>,
  asOf: Date = new Date(),
): number | null {
  if (!vendor.bank_changed_at) return null
  const changed = new Date(vendor.bank_changed_at).getTime()
  if (Number.isNaN(changed)) return null
  return Math.floor((asOf.getTime() - changed) / 86_400_000)
}

export function bankChangedRecently(
  vendor: Pick<VendorRow, 'bank_changed_at'>,
  asOf: Date = new Date(),
  withinDays: number = RECENT_BANK_CHANGE_DAYS,
): boolean {
  const days = daysSinceBankChange(vendor, asOf)
  return days !== null && days >= 0 && days <= withinDays
}
