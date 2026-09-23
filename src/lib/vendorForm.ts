// What the vendor onboarding form starts with, and what it refuses to start with.
//
// The split this module encodes is a fraud control, not a convenience setting.
//
// The bank-detail check compares the account printed on an invoice against the
// account we hold on file for that vendor. If the account on file was copied off
// an invoice, both sides of that comparison are the same piece of paper: every
// future invoice from the vendor agrees with itself, and the control that catches
// a redirected payment is switched off at the moment the vendor is created.
//
// So identity comes off the document, because who a company says it is is exactly
// what the document is for, and payment details do not and cannot. They are
// confirmed out of band, on a phone number we already had, and the person doing
// the confirming is recorded beside them.
//
// This lives outside the page so the rule is a function with a return value rather
// than a sequence of setter calls in a component, and can therefore be asserted
// directly: whatever the extraction contains, the form's payment fields start
// empty.

/** The fields the form may fill in from the document. */
export interface IdentityPrefill {
  legalName: string
  alsoKnownAs: string
}

/** The fields the form must never fill in from the document. */
export interface PaymentFields {
  bankAccount: string
  ifsc: string
  confirmedBy: string
}

/**
 * Where payment goes, as the form starts.
 *
 * Takes no arguments, and that is the point: there is no document, no extraction
 * and no vendor record it could read a value out of, so there is nothing for a
 * later change to accidentally thread in.
 */
export function emptyPaymentFields(): PaymentFields {
  return { bankAccount: '', ifsc: '', confirmedBy: '' }
}

/** Whether the person has supplied all three. The form will not submit until they have. */
export function paymentFieldsComplete(fields: PaymentFields): boolean {
  return (
    fields.bankAccount.trim().length > 0 && fields.ifsc.trim().length > 0 && fields.confirmedBy.trim().length > 0
  )
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Identity, read off the document.
 *
 * `extraction` is whatever stage 2 returned and `printedOnRow` is the name the
 * invoice row carries, used when the extraction has none. The remit-to name is
 * added as an alias when it differs, because a company that invoices under one
 * name and asks to be paid under another is one vendor with two names, and the
 * vendor matcher needs both to recognise the next invoice.
 *
 * Nothing about payment is returned from here. The return type says so.
 */
export function identityPrefill(
  extraction: Readonly<Record<string, unknown>> | null,
  printedOnRow: string | null,
): IdentityPrefill {
  const legalName = asText(extraction?.vendor_name) || asText(printedOnRow)
  const remitTo = asText(extraction?.remit_to_name)
  return {
    legalName,
    alsoKnownAs: remitTo && remitTo !== legalName ? `${legalName}, ${remitTo}` : legalName,
  }
}
