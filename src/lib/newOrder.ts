// Raising an order before any invoice exists.
//
// The counterpart to raising one from a held invoice. That flow reacts: an
// invoice has arrived, nothing on file authorises it, and somebody who knows the
// work was agreed records it after the fact. This one is the ordinary way round,
// where the order is raised when the work is agreed and the invoice turns up
// against it later.
//
// Every field here is typed by the person raising the order, and none of the
// "do not take this off the invoice" rules apply, because there is no invoice to
// take anything off. Those rules exist so that a comparison has two independent
// sides; here the second side has not been written yet.
//
// Pure apart from `createOrder`, which is the one write.

import { createPurchaseOrder } from './queries.ts'
import type {
  PurchaseOrderInsert,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  TaxTreatment,
  VendorRow,
} from './database.types.ts'
import { parseOrderValue } from './orderForm.ts'

export interface NewOrderInputs {
  vendorId: string
  poNumber: string
  description: string
  /** In the order's currency, as typed. */
  totalAmount: string
  currency: string
  issuedDate: string
  status: PurchaseOrderStatus
  // Not among the fields the brief lists, and required all the same: an order
  // that states no tax treatment cannot be put on a common basis with any invoice
  // billed against it, so every invoice against it would be held for exactly that.
  taxTreatment: TaxTreatment
}

export const DEFAULT_CURRENCY = 'INR'

export function emptyNewOrder(today: string): NewOrderInputs {
  return {
    vendorId: '',
    poNumber: '',
    description: '',
    totalAmount: '',
    currency: DEFAULT_CURRENCY,
    issuedDate: today,
    status: 'open',
    taxTreatment: 'exclusive',
  }
}

// ---------------------------------------------------------------------------
// Choosing the vendor
// ---------------------------------------------------------------------------

/**
 * The vendors an order can be raised with.
 *
 * Active ones only. An order against an inactive vendor is an order no invoice
 * can ever be paid against, because the vendor check blocks the invoice before
 * anything looks at the order.
 */
export function orderableVendors(vendors: readonly VendorRow[]): VendorRow[] {
  return [...vendors]
    .filter((vendor) => vendor.status === 'active')
    .sort((a, b) => a.legal_name.localeCompare(b.legal_name))
}

/** Vendors whose name or one of its aliases contains what has been typed. */
export function vendorsMatching(vendors: readonly VendorRow[], query: string): VendorRow[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...vendors]
  return vendors.filter((vendor) =>
    [vendor.legal_name, ...(vendor.aliases ?? [])].some((name) => name.toLowerCase().includes(needle)),
  )
}

// ---------------------------------------------------------------------------
// The order number
// ---------------------------------------------------------------------------

/** The stem an order number is built on when a vendor has none to follow. */
export function vendorStem(legalName: string): string {
  return legalName.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'ORDER'
}

const TRAILING_NUMBER = /^(.*?)(\d+)$/

/**
 * The next number in the sequence this vendor's orders already use.
 *
 * Follows what is there rather than imposing a scheme: the highest numbered of
 * this vendor's orders sets both the prefix and the width, so an estate numbering
 * its orders one way goes on being numbered that way. A vendor with no numbered
 * order yet starts a sequence of its own from its name.
 *
 * The suggestion is a suggestion. It is editable on the form, and it steps past
 * any number already taken by any order, because the number is the order's
 * primary key and a collision is a failed save rather than a warning.
 */
export function suggestOrderNumber(vendor: VendorRow, orders: readonly PurchaseOrderRow[]): string {
  const taken = new Set(orders.map((order) => order.po_number.trim().toUpperCase()))

  const numbered = orders
    .filter((order) => order.vendor_id === vendor.id)
    .map((order) => TRAILING_NUMBER.exec(order.po_number.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ prefix: match[1], digits: match[2], value: Number(match[2]) }))
    .filter((entry) => Number.isFinite(entry.value))

  const highest = numbered.reduce<(typeof numbered)[number] | null>(
    (best, entry) => (best === null || entry.value > best.value ? entry : best),
    null,
  )

  const prefix = highest ? highest.prefix : `PO-${vendorStem(vendor.legal_name)}-`
  const width = highest ? highest.digits.length : 3
  let next = highest ? highest.value + 1 : 1

  // Past anything already taken, by this vendor or any other: the number is the
  // primary key, so two vendors cannot share one.
  for (let guard = 0; guard < 1000; guard += 1) {
    const candidate = `${prefix}${String(next).padStart(width, '0')}`
    if (!taken.has(candidate.toUpperCase())) return candidate
    next += 1
  }
  return `${prefix}${String(next).padStart(width, '0')}`
}

// ---------------------------------------------------------------------------
// Completeness and the write
// ---------------------------------------------------------------------------

/** A currency is three letters. The order's is compared to every invoice's. */
export function currencyIsValid(currency: string): boolean {
  return /^[A-Za-z]{3}$/.test(currency.trim())
}

export function newOrderIsComplete(inputs: NewOrderInputs): boolean {
  return (
    inputs.vendorId.trim().length > 0 &&
    inputs.poNumber.trim().length > 0 &&
    inputs.description.trim().length > 0 &&
    parseOrderValue(inputs.totalAmount) !== null &&
    currencyIsValid(inputs.currency) &&
    inputs.issuedDate.length > 0
  )
}

export function orderInsertFor(inputs: NewOrderInputs, vendor: VendorRow): PurchaseOrderInsert {
  const value = parseOrderValue(inputs.totalAmount)
  if (value === null) throw new Error('The order needs a value above zero before it can be raised.')

  return {
    po_number: inputs.poNumber.trim(),
    vendor_id: vendor.id,
    total_amount: value,
    currency: inputs.currency.trim().toUpperCase(),
    // Nothing has been billed against an order nobody has invoiced yet. What is
    // billed against it later is derived from the invoices, not written here.
    amount_billed_to_date: 0,
    tax_treatment: inputs.taxTreatment,
    status: inputs.status,
    // One line, described as the person raising the order described it. The
    // line-level checks read this exactly as they read any other order's lines.
    line_items: [
      { description: inputs.description.trim(), quantity: null, unit_price: null, amount: value },
    ],
    issued_date: inputs.issuedDate,
  }
}

/**
 * Raises the order.
 *
 * No invoice is re-run afterwards, which is the whole difference from
 * `raiseOrder`: there is no invoice yet. The next one to arrive from this vendor
 * is checked against this order by the same rules as any other.
 */
export async function createOrder(inputs: NewOrderInputs, vendor: VendorRow): Promise<PurchaseOrderRow> {
  return createPurchaseOrder(orderInsertFor(inputs, vendor))
}
