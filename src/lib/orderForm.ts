// Raising an order against an invoice that cites none.
//
// A NO_PO_MATCH hold has no way forward without this: the invoice is asking to be
// paid for work nothing on file authorised, and until something does, it can only
// sit there. Someone who knows the work was ordered raises the order, and the
// invoice is checked again from the top against it.
//
// The order value is not prefilled from the invoice, and that is the same control
// as the one on the vendor form. The tolerance check compares what is billed
// against what was ordered. Copy the ordered amount off the invoice and the two
// sides of that comparison are the same number, every invoice against the order
// agrees with itself, and the check that catches an inflated bill is switched off
// at the moment the order is created. The person raising it has to know what was
// agreed and type it.
//
// The description is prefilled, because it is a label rather than a control:
// nothing compares it to decide an amount, and retyping the lines off the invoice
// helps nobody.

/** What the form may fill in from the invoice. */
export interface OrderPrefill {
  vendorId: string | null
  vendorName: string
  description: string
  currency: string
}

/** What the person must supply. */
export interface OrderInputs {
  /** In rupees, as typed. Empty until they type it. */
  totalAmount: string
  issuedDate: string
  status: 'open' | 'closed'
  taxTreatment: 'inclusive' | 'exclusive'
}

/**
 * The order's opening state.
 *
 * `totalAmount` is empty and stays empty until somebody types it, for the reason
 * at the top of this file. Taking no argument is what guarantees that: there is no
 * invoice in scope here to read a figure out of.
 */
export function emptyOrderInputs(today: string): OrderInputs {
  return { totalAmount: '', issuedDate: today, status: 'open', taxTreatment: 'exclusive' }
}

interface InvoiceLine {
  description?: string | null
}

/**
 * What the invoice says it is for, as one line of prose.
 *
 * Reads the extracted line descriptions, falling back to nothing. Deduplicated and
 * capped, because an order description is a label on a screen and a fifteen-line
 * invoice would otherwise produce a paragraph.
 */
export function describeFromLines(lines: readonly InvoiceLine[] | null | undefined, limit = 4): string {
  const described = (lines ?? [])
    .map((line) => (typeof line?.description === 'string' ? line.description.trim() : ''))
    .filter((text) => text.length > 0)
  const unique = [...new Set(described)]
  if (unique.length === 0) return ''
  return unique.length <= limit ? unique.join(', ') : `${unique.slice(0, limit).join(', ')}, and more`
}

/**
 * The order number.
 *
 * Derived from the vendor so it is legible in a list, with a random tail so two
 * orders raised for the same vendor on the same day cannot collide. Nothing in the
 * rules engine parses this: an order number is matched as a string, never
 * interpreted.
 */
export function orderNumberFor(vendorName: string, random: () => number = Math.random): string {
  const stem = vendorName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 6)
  return `PO-${stem || 'ORDER'}-${random().toString(36).slice(2, 6).toUpperCase()}`
}

/**
 * The number to raise the order under.
 *
 * An invoice that cites an order is asking to be paid against *that* order, so that
 * is the number the order has to be created with. Raising it under an invented
 * number was the reason raising an order never cleared a NO_PO_MATCH hold: stage 4
 * resolves the printed reference against the vendor's orders, found nothing called
 * PO-2075 because the order had been created as PO-KAVERI-7B3C, and held the
 * invoice again. No amount of re-running could have fixed it, because the order
 * that existed was not the order the document cited.
 *
 * Kept as printed rather than normalised, minus surrounding whitespace. An order
 * number is matched as a string and never interpreted, and stage 4 normalises both
 * sides of that comparison, so storing what the document says keeps the record
 * faithful without weakening the match.
 *
 * The generated number is still the right answer when the invoice cites nothing,
 * which is the other way an invoice reaches NO_PO_MATCH: there is no reference to
 * honour, so something legible is invented instead.
 */
export function orderNumberToRaise(
  citedReference: string | null | undefined,
  vendorName: string,
  random: () => number = Math.random,
): string {
  const cited = (citedReference ?? '').trim()
  return cited.length > 0 ? cited : orderNumberFor(vendorName, random)
}

/** A number the form will accept as an order value: present, numeric and above zero. */
export function parseOrderValue(typed: string): number | null {
  const cleaned = typed.replace(/[,\s]/g, '')
  if (cleaned.length === 0) return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Whether the person has filled the form in.
 *
 * Deliberately about the fields and nothing else. This used to take the resolved
 * vendor as well, so a vendor the page had failed to find left the button dead
 * with every required field filled and nothing on screen saying which one was
 * wrong. Whether we know the vendor is a different question, asked before the form
 * is offered at all.
 */
export function orderIsComplete(inputs: OrderInputs): boolean {
  return parseOrderValue(inputs.totalAmount) !== null && inputs.issuedDate.length > 0
}
