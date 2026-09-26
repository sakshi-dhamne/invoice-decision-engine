// Putting a company on the approved vendor list.
//
// Shared by the two screens that do it: the one opened from a held invoice, which
// prefills identity from the document, and the standalone one, which prefills
// nothing because there is no document. What they have in common is everything
// after the form: the id a vendor gets, the row that is written, and the first
// entry in its history.
//
// The payment half is not in here. That rule lives in vendorForm.ts, where it can
// be asserted without a database, and both screens read it from there.

import { createVendor } from './queries.ts'
import { recordVendorCreated } from './vendorHistory.ts'
import type { VendorRow } from './database.types.ts'

/**
 * A vendor id, derived from the name.
 *
 * Vendor ids are a text primary key, and nobody adding a company should have to
 * invent a code for it. The name gives something legible and the suffix keeps two
 * companies with similar names apart.
 */
export function vendorIdFor(name: string): string {
  const stem = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 6)
  return `${stem || 'VENDOR'}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

/** Comma-separated other names, minus the blanks and the legal name itself. */
export function aliasesFrom(alsoKnownAs: string, legalName: string): string[] {
  const legal = legalName.trim()
  return alsoKnownAs
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && alias !== legal)
}

export interface NewVendorFields {
  legalName: string
  gstin: string
  address: string
  emailDomain: string
  alsoKnownAs: string
  bankAccount: string
  ifsc: string
  confirmedBy: string
  addedBy: string
}

/**
 * Everything a vendor needs before it can be saved.
 *
 * The registered name, a name against the act, and all three payment fields. The
 * same bar on both screens: an account nobody will say they confirmed is an account
 * nobody confirmed, whether or not there was an invoice on screen at the time.
 */
export function newVendorIsComplete(fields: NewVendorFields): boolean {
  return (
    fields.legalName.trim().length > 0 &&
    fields.addedBy.trim().length > 0 &&
    fields.bankAccount.trim().length > 0 &&
    fields.ifsc.trim().length > 0 &&
    fields.confirmedBy.trim().length > 0
  )
}

/**
 * Creates the vendor and starts its history.
 *
 * The history row is best effort. The vendor exists either way, and a project that
 * has not had 010_vendor_history.sql applied must not strand somebody halfway
 * through adding a company.
 */
export async function createVendorWithTrail(
  fields: NewVendorFields,
  at: string = new Date().toISOString(),
): Promise<VendorRow> {
  const vendorId = vendorIdFor(fields.legalName)

  const vendor = await createVendor({
    id: vendorId,
    legal_name: fields.legalName.trim(),
    status: 'active',
    aliases: aliasesFrom(fields.alsoKnownAs, fields.legalName),
    bank_account: fields.bankAccount.trim(),
    bank_ifsc: fields.ifsc.trim(),
    bank_confirmed_by: fields.confirmedBy.trim(),
    // Dated, so the confirmation can be aged. A note with no date cannot say
    // whether the check happened this week or three years ago.
    bank_confirmed_at: at,
    gstin: fields.gstin.trim() || null,
    address: fields.address.trim() || null,
    email_domain: fields.emailDomain.trim() || null,
    added_by: fields.addedBy.trim(),
  })

  await recordVendorCreated({
    vendorId,
    account: fields.bankAccount.trim(),
    ifsc: fields.ifsc.trim(),
    addedBy: fields.addedBy.trim(),
    verificationNote: fields.confirmedBy.trim(),
    at,
  }).catch(() => undefined)

  return vendor
}
