// What an order has already been billed.
//
// A purchase order's `amount_billed_to_date` column is an opening balance: what
// had been billed against the order before this system saw any of it. Nothing
// writes to it, and that is deliberate. What has been billed since is not a
// number to keep in step by hand; it is a fact about the invoices, and it is
// derived from them here.
//
// Deriving it rather than accumulating it is what makes the awkward half correct
// for free. An invoice approved today and held tomorrow stops counting the moment
// it stops being approved, because nothing was ever added to a running total that
// would have to be taken back out. The same goes for one somebody files away, and
// for a re-run that reaches a different answer.
//
// Pure, like everything else in this directory: the caller says which documents
// count as approved and what each one bills, and this adds them up.

import { isFiniteNumber, normalizeIdentifier, roundTo } from './normalize.ts'
import type { PoMatchResult } from './poMatch.ts'
import type { PurchaseOrderRecord } from './types.ts'

/**
 * One decided document, as it stands against an order now.
 *
 * `approved` is the outcome that holds for it at this moment, whether the rules
 * approved it or a person did. Anything else, including a document still waiting
 * for somebody, is not money the order has committed.
 */
export interface BilledDocument {
  invoice_id: string
  /** The order it was decided against, which is the order it bills. */
  po_number: string | null
  /** What it bills, on the same gross basis the order states its total in. */
  amount: number | null
  approved: boolean
}

/**
 * What approved invoices have billed against one order.
 *
 * `excluding` leaves out the document being decided, so an invoice re-run after it
 * was approved is not measured against itself.
 */
export function approvedAgainst(
  poNumber: string,
  documents: readonly BilledDocument[],
  excluding?: string | null,
): number {
  const wanted = normalizeIdentifier(poNumber)
  if (wanted.length === 0) return 0

  let total = 0
  for (const document of documents) {
    if (!document.approved) continue
    if (excluding && document.invoice_id === excluding) continue
    if (normalizeIdentifier(document.po_number) !== wanted) continue
    if (!isFiniteNumber(document.amount)) continue
    total += document.amount
  }
  return roundTo(total, 2)
}

/**
 * The orders as they stand once approved invoices are counted against them.
 *
 * Every check that reads `amount_billed_to_date` then sees the same figure: the
 * cumulative-overage check, which is the one that exists to stop several invoices
 * overdrawing one order between them, and the amount signal stage 4 scores an
 * unreferenced invoice on.
 */
export function withApprovedBilling(
  orders: readonly PurchaseOrderRecord[],
  documents: readonly BilledDocument[],
  excluding?: string | null,
): PurchaseOrderRecord[] {
  return orders.map((order) => ({
    ...order,
    amount_billed_to_date: roundTo(
      order.amount_billed_to_date + approvedAgainst(order.po_number, documents, excluding),
      2,
    ),
  }))
}

/**
 * The matched order, with what has been billed against it counted in.
 *
 * Applied to the order stage 4 settled on, and never to the candidates stage 4
 * was choosing between. Which order an invoice belongs to is a question about the
 * document; what that order has left is a question about money, and they are not
 * the same question. An order billed to its value is still the order an invoice
 * cites, and an invoice that would overdraw one should be matched to it and then
 * reported as an overage, which is the finding a reviewer needs. Scoring the
 * candidates on their remaining balance instead would quietly stop such an
 * invoice matching anything, and it would be held for citing no order while the
 * real finding went unsaid.
 */
export function billMatchedOrder(
  poMatch: PoMatchResult,
  documents: readonly BilledDocument[],
  excluding?: string | null,
): PoMatchResult {
  if (!poMatch.matched || documents.length === 0) return poMatch
  return { ...poMatch, matched: withApprovedBilling([poMatch.matched], documents, excluding)[0] }
}
