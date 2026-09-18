// Stage 4 — match the invoice to a purchase order.
//
// An explicit reference short-circuits everything: if the document cites a PO that
// exists and belongs to the resolved vendor, that is the match, score 1.0, stop.
//
// Only when no usable reference is present do secondary signals run over that
// vendor's open POs. The result of that inference is never treated as an
// authoritative match — it is a suggestion. Silently paying the wrong PO is the
// failure this whole stage exists to prevent, so where two candidates are close
// the engine returns both rather than picking the higher one.
//
// Pure: takes the invoice facts and the vendor's POs, returns a match.

import {
  daysBetween,
  descriptionSimilarity,
  grossFactor,
  isFiniteNumber,
  normalizeIdentifier,
  normalizeText,
  parseIsoDate,
  relativeDifference,
  roundTo,
  sum,
} from './normalize.ts'
import type { InvoiceFacts, PurchaseOrderRecord, RuleSet } from './types.ts'

export type PoMatchOutcome =
  // The document cites a PO of this vendor. Authoritative.
  | 'explicit'
  // No usable reference; one candidate stands clear of the rest. A suggestion for
  // a human, never an authoritative match.
  | 'inferred'
  // No usable reference; two or more candidates sit within the ambiguity margin.
  | 'ambiguous'
  // No usable reference and no credible candidate.
  | 'none'

export interface PoScoreBreakdown {
  po_number: string
  amount: number
  description: number
  date: number
  total: number
}

export interface PoMatchResult {
  outcome: PoMatchOutcome
  // Set only for an authoritative (explicit) match. Downstream PO-dependent
  // checks run against this and nothing else.
  matched: PurchaseOrderRecord | null
  score: number
  method: 'explicit' | 'scored' | null
  // Everything that scored above the candidate floor, best first. For `ambiguous`
  // this is the set a human must choose between; for `inferred` it is the single
  // suggestion; for `explicit` it is empty.
  candidates: PurchaseOrderRecord[]
  breakdown: PoScoreBreakdown[]
  reference_as_printed: string | null
  reference_resolved: boolean
}

// The invoice's payable amount, on the same gross basis as a PO's total_amount.
export function invoiceGrossTotal(facts: InvoiceFacts): number | null {
  return isFiniteNumber(facts.total) ? facts.total : null
}

// Gross-normalised line amounts, so invoice lines and PO lines are comparable.
export function grossLineAmounts(facts: InvoiceFacts): number[] {
  const rawAmounts = facts.line_items.map((line) =>
    isFiniteNumber(line.amount)
      ? line.amount
      : isFiniteNumber(line.quantity) && isFiniteNumber(line.unit_price)
        ? line.quantity * line.unit_price
        : Number.NaN,
  )
  const factor = grossFactor(facts.total, facts.subtotal, rawAmounts.filter(isFiniteNumber))
  return rawAmounts.map((amount) => (Number.isFinite(amount) ? amount * factor : Number.NaN))
}

// Amount still open on a PO.
export function remainingBalance(po: PurchaseOrderRecord): number {
  const total = isFiniteNumber(po.total_amount) ? po.total_amount : 0
  return total - (isFiniteNumber(po.amount_billed_to_date) ? po.amount_billed_to_date : 0)
}

/**
 * Amount proximity to the PO's remaining balance, on a smooth decay anchored to
 * the matching tolerance: an exact match scores 1, a gap of one tolerance-width
 * scores 0.5, and it tails off from there. No cliff, so a candidate one rupee
 * outside tolerance is not treated as wildly different from one inside it.
 */
export function scoreAmountProximity(invoiceTotal: number | null, po: PurchaseOrderRecord, rules: RuleSet): number {
  if (!isFiniteNumber(invoiceTotal)) return 0
  const remaining = remainingBalance(po)
  if (remaining <= 0) return 0
  const relative = relativeDifference(invoiceTotal, remaining)
  if (!Number.isFinite(relative)) return 0
  return 1 / (1 + relative / rules.matching_tolerance_pct)
}

// Mean over invoice lines of the best similarity that line finds among the PO's
// lines. Averaged rather than maxed so one lucky line cannot carry an invoice
// whose other lines belong to a different order.
export function scoreDescriptionOverlap(facts: InvoiceFacts, po: PurchaseOrderRecord): number {
  const invoiceDescriptions = facts.line_items
    .map((line) => line.description)
    .filter((description): description is string => normalizeText(description).length > 0)

  if (invoiceDescriptions.length === 0 || po.line_items.length === 0) return 0

  const perLineBest = invoiceDescriptions.map((description) =>
    Math.max(0, ...po.line_items.map((poLine) => descriptionSimilarity(description, poLine.description))),
  )

  return sum(perLineBest) / perLineBest.length
}

// Invoice date after the PO issue date, closer is better. An invoice dated before
// the PO was issued cannot be billing against it, so that scores zero outright.
export function scoreDateWindow(facts: InvoiceFacts, po: PurchaseOrderRecord, rules: RuleSet): number {
  const invoiceDate = parseIsoDate(facts.invoice_date)
  const issuedDate = parseIsoDate(po.issued_date)
  if (!invoiceDate || !issuedDate) return 0

  const elapsed = daysBetween(issuedDate, invoiceDate)
  if (elapsed < 0) return 0
  if (rules.po_date_window_days <= 0) return 0

  return Math.max(0, 1 - elapsed / rules.po_date_window_days)
}

export function scorePurchaseOrder(facts: InvoiceFacts, po: PurchaseOrderRecord, rules: RuleSet): PoScoreBreakdown {
  const amount = scoreAmountProximity(invoiceGrossTotal(facts), po, rules)
  const description = scoreDescriptionOverlap(facts, po)
  const date = scoreDateWindow(facts, po, rules)

  const total =
    rules.po_weight_amount * amount + rules.po_weight_description * description + rules.po_weight_date * date

  return {
    po_number: po.po_number,
    amount: roundTo(amount, 4),
    description: roundTo(description, 4),
    date: roundTo(date, 4),
    total: roundTo(total, 4),
  }
}

/**
 * Finds the PO the document cites.
 *
 * The reference is usually its own extracted field, but plenty of layouts print it
 * only inside a notes block. Rather than pattern-matching a PO-number format —
 * which would bake in one issuer's conventions — the notes are searched for the
 * identifiers of this vendor's own purchase orders. Any numbering scheme works.
 */
export function resolvePrintedReference(
  facts: InvoiceFacts,
  vendorPos: readonly PurchaseOrderRecord[],
): PurchaseOrderRecord | null {
  const printed = normalizeIdentifier(facts.po_reference)
  if (printed.length > 0) {
    const direct = vendorPos.find((po) => normalizeIdentifier(po.po_number) === printed)
    if (direct) return direct
  }

  const notes = normalizeIdentifier(facts.notes)
  if (notes.length === 0) return null

  const mentioned = vendorPos.filter((po) => {
    const identifier = normalizeIdentifier(po.po_number)
    return identifier.length > 0 && notes.includes(identifier)
  })

  // Notes naming more than one of this vendor's POs is not a reference we can act
  // on; let the scored path and the ambiguity test handle it.
  return mentioned.length === 1 ? mentioned[0] : null
}

/**
 * Stage 4. `vendorPos` must already be scoped to the resolved vendor — an invoice
 * can only bill against its own vendor's orders.
 */
export function matchPurchaseOrder(
  facts: InvoiceFacts,
  vendorPos: readonly PurchaseOrderRecord[],
  rules: RuleSet,
): PoMatchResult {
  const referenceAsPrinted = facts.po_reference ?? null

  const explicit = resolvePrintedReference(facts, vendorPos)
  if (explicit) {
    return {
      outcome: 'explicit',
      matched: explicit,
      score: 1,
      method: 'explicit',
      candidates: [],
      breakdown: [],
      reference_as_printed: referenceAsPrinted,
      reference_resolved: true,
    }
  }

  // Secondary signals only ever run over open orders: a closed or cancelled PO is
  // not something to infer a match onto.
  const openPos = vendorPos.filter((po) => po.status === 'open')

  const breakdown = openPos
    .map((po) => scorePurchaseOrder(facts, po, rules))
    .sort((a, b) => b.total - a.total)

  const credible = breakdown.filter((entry) => entry.total >= rules.po_candidate_floor)
  const byNumber = new Map(openPos.map((po) => [po.po_number, po]))
  const candidates = credible
    .map((entry) => byNumber.get(entry.po_number))
    .filter((po): po is PurchaseOrderRecord => po !== undefined)

  const base = {
    matched: null,
    method: 'scored' as const,
    breakdown,
    reference_as_printed: referenceAsPrinted,
    reference_resolved: false,
  }

  if (credible.length === 0) {
    return { ...base, outcome: 'none', score: 0, method: null, candidates: [] }
  }

  // Never guess between close candidates — return both.
  if (credible.length >= 2 && credible[0].total - credible[1].total < rules.po_ambiguity_margin) {
    const tied = credible.filter((entry) => credible[0].total - entry.total < rules.po_ambiguity_margin)
    return {
      ...base,
      outcome: 'ambiguous',
      score: credible[0].total,
      candidates: candidates.slice(0, tied.length),
    }
  }

  return { ...base, outcome: 'inferred', score: credible[0].total, candidates: candidates.slice(0, 1) }
}
