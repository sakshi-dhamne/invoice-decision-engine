// Raising an order and checking the invoice again, as one action.
//
// Lives outside the page so it can be driven by a test: the page collects the
// values and calls this, and what it does with them (create the order, re-run the
// invoice, hand back the new run) is checkable without a browser.
//
// Nothing here decides anything. The order is recorded and the invoice goes back
// through all seven stages against it, exactly as any other invoice does against
// any other order.

import { createPurchaseOrder } from './queries.ts'
import { runInvoice } from './pipeline.ts'
import { orderNumberToRaise, parseOrderValue, type OrderInputs } from './orderForm.ts'
import type { PurchaseOrderRow, VendorRow } from './database.types.ts'

export interface RaiseOrderInput {
  vendor: VendorRow
  invoiceId: string
  /**
   * The order number printed on the invoice, when it cites one.
   *
   * Required rather than optional: an order raised under a number the invoice does
   * not cite can never match it, and that failure is silent. A caller with nothing
   * to pass says so by passing null.
   */
  citedReference: string | null
  description: string
  currency: string
  inputs: OrderInputs
}

export interface RaisedOrder {
  order: PurchaseOrderRow
  /** The run that decided the invoice against the new order. */
  runId: string
}

export async function raiseOrder(input: RaiseOrderInput): Promise<RaisedOrder> {
  const value = parseOrderValue(input.inputs.totalAmount)
  if (value === null) {
    throw new Error('The order needs a value above zero before it can be raised.')
  }

  const order = await createPurchaseOrder({
    // The number the invoice cites, so stage 4's reference lookup can find it.
    po_number: orderNumberToRaise(input.citedReference, input.vendor.legal_name),
    vendor_id: input.vendor.id,
    total_amount: value,
    currency: input.currency,
    amount_billed_to_date: 0,
    tax_treatment: input.inputs.taxTreatment,
    status: input.inputs.status,
    // One line, described as the invoice describes the work. The line-level checks
    // read this the same way they read any other order's lines.
    line_items: [
      { description: input.description.trim() || null, quantity: null, unit_price: null, amount: value },
    ],
    issued_date: input.inputs.issuedDate,
  })

  let runId: string | null = null
  const outcome = await runInvoice(input.invoiceId, {
    onRunCreated: (created) => {
      runId = created.id
    },
  })

  return { order, runId: runId ?? outcome.run.id }
}
