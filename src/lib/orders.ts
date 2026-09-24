// Purchase orders, as a screen reads them.
//
// An order could be raised from a held invoice and then never looked at again:
// there was no list of orders anywhere in the product, so the value an order had
// left, and which invoices had eaten into it, were things only the rules engine
// knew. This assembles both.
//
// What an order has been billed is derived, never read off the row. The stored
// column is the opening balance and nothing writes to it; every invoice approved
// against the order is added here, exactly as the pipeline adds them before it
// checks an invoice. The two agree because they call the same function.

import { getPurchaseOrders, getVendors } from './queries.ts'
import { loadLedger, type LedgerEntry } from './relatedInvoices.ts'
import { isApproved } from './runState.ts'
import { asRecord } from './format.ts'
import { approvedAgainst } from '@/rules/billing.ts'
import type { BilledDocument } from '@/rules/billing.ts'
import type { PurchaseOrderRow, PurchaseOrderStatus, VendorRow } from './database.types.ts'

export const ORDER_STATUS_LABEL: Readonly<Record<PurchaseOrderStatus, string>> = {
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export function orderStatusLabel(status: PurchaseOrderStatus | null | undefined): string {
  return status ? ORDER_STATUS_LABEL[status] : 'Not recorded'
}

export interface OrderSummary {
  order: PurchaseOrderRow
  vendor: VendorRow | null
  /** The opening balance plus every approved invoice against it. */
  billedToDate: number
  /** What is left of the order's value, or null on an order that states no value. */
  remaining: number | null
  /** How many invoices have been billed against it, whatever they were decided as. */
  invoiceCount: number
}

export function billedFromLedger(ledger: readonly LedgerEntry[]): BilledDocument[] {
  return ledger.map((entry) => ({
    invoice_id: entry.invoice.id,
    po_number: entry.run?.matched_po ?? null,
    amount: entry.invoice.total,
    approved: isApproved(entry.run),
  }))
}

export function summariseOrders(
  orders: readonly PurchaseOrderRow[],
  vendors: readonly VendorRow[],
  ledger: readonly LedgerEntry[],
): OrderSummary[] {
  const vendorsById = new Map(vendors.map((vendor) => [vendor.id, vendor]))
  const documents = billedFromLedger(ledger)

  return orders.map((order) => {
    const billedToDate = order.amount_billed_to_date + approvedAgainst(order.po_number, documents)
    const matched = order.po_number.trim().toLowerCase()
    return {
      order,
      vendor: order.vendor_id ? (vendorsById.get(order.vendor_id) ?? null) : null,
      billedToDate,
      remaining:
        typeof order.total_amount === 'number' && Number.isFinite(order.total_amount)
          ? order.total_amount - billedToDate
          : null,
      invoiceCount: ledger.filter((entry) => (entry.run?.matched_po ?? '').trim().toLowerCase() === matched).length,
    }
  })
}

export interface OrdersData {
  orders: OrderSummary[]
  ledger: LedgerEntry[]
}

export async function loadOrders(): Promise<OrdersData> {
  const [orders, vendors, ledger] = await Promise.all([getPurchaseOrders(), getVendors(), loadLedger()])
  return { orders: summariseOrders(orders, vendors, ledger), ledger }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type OrderSortKey = 'order' | 'vendor' | 'value' | 'billed' | 'remaining' | 'status' | 'raised'
export type SortDirection = 'asc' | 'desc'

export function sortOrders(
  rows: readonly OrderSummary[],
  key: OrderSortKey,
  direction: SortDirection,
): OrderSummary[] {
  const sign = direction === 'asc' ? 1 : -1

  const value = (row: OrderSummary): string | number => {
    switch (key) {
      case 'order':
        return row.order.po_number
      case 'vendor':
        return row.vendor?.legal_name ?? ''
      case 'value':
        return row.order.total_amount ?? 0
      case 'billed':
        return row.billedToDate
      case 'remaining':
        return row.remaining ?? 0
      case 'status':
        return orderStatusLabel(row.order.status)
      case 'raised':
        return String(row.order.issued_date ?? '')
    }
  }

  return [...rows].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign
    return String(left).localeCompare(String(right)) * sign
  })
}

export function matchesOrderSearch(row: OrderSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return [row.order.po_number, row.vendor?.legal_name, orderStatusLabel(row.order.status)].some((value) =>
    String(value ?? '').toLowerCase().includes(needle),
  )
}

// ---------------------------------------------------------------------------
// The arithmetic on one decision
// ---------------------------------------------------------------------------

/**
 * The order's value, what was billed against it before this invoice, what this
 * invoice adds, and whether that goes over.
 *
 * Taken from the cumulative-overage check's own evidence wherever the run has it,
 * because that is the figure the invoice was actually decided against. Reading it
 * off the order row instead would show today's balance beside a verdict reached
 * on a different one. The row is the fallback for a run decided before the check
 * had a matched order to work with.
 */
export interface OrderTally {
  orderValue: number | null
  billedBefore: number
  thisInvoice: number | null
  /** The order's value plus the tolerance the rules allow over it. */
  allowed: number | null
  /** How far past that the total would go, when it does. */
  overage: number | null
  currency: string
}

export function orderTallyFrom(input: {
  validations: Record<string, unknown> | null
  order: PurchaseOrderRow | null
  invoiceTotal: number | null
}): OrderTally | null {
  const { order } = input
  if (!order) return null

  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  const evidence = asRecord(asRecord(input.validations?.cumulative_overage)?.evidence)
  const orderValue = number(evidence?.po_total) ?? order.total_amount
  const billedBefore = number(evidence?.amount_billed_to_date) ?? order.amount_billed_to_date
  const thisInvoice = number(evidence?.this_invoice) ?? input.invoiceTotal
  const allowed = number(evidence?.ceiling)
  const cumulative = number(evidence?.cumulative) ?? (thisInvoice === null ? null : billedBefore + thisInvoice)
  const overage = allowed !== null && cumulative !== null && cumulative > allowed ? cumulative - allowed : null

  return { orderValue, billedBefore, thisInvoice, allowed, overage, currency: order.currency }
}
