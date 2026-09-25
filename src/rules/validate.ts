// Stage 5 — every check, each its own exported pure function.
//
// A check returns { passed, code?, evidence? }. The evidence object is what the UI
// shows and what the audit trail stores, so it names the concrete values that were
// compared rather than restating the rule in prose.
//
// A check that cannot run — no vendor resolved, no PO matched, a field the
// document never printed — returns `skipped(...)`, which is deliberately distinct
// from passing. A skipped check must never read as evidence of correctness.
//
// Nothing here touches the database. Cross-invoice checks take the records they
// need as arguments; `pipeline.ts` does the fetching.

import {
  coefficientOfVariation,
  daysBetween,
  descriptionSimilarity,
  isFiniteNumber,
  normalizeAccountNumber,
  normalizeIdentifier,
  normalizeText,
  parseIsoDate,
  relativeDifference,
  roundTo,
  sum,
  toleranceFor,
  withinTolerance,
  tokenize,
} from './normalize.ts'
import { grossLineAmounts, invoiceGrossTotal } from './poMatch.ts'
import type { PoMatchResult } from './poMatch.ts'
import type { VendorMatch } from './vendor.ts'
import { namesResolveToSameEntity } from './vendor.ts'
import {
  fail,
  pass,
  skipped,
  type CheckResult,
  type Evidence,
  type InvoiceFacts,
  type LineItemFact,
  type PriorRun,
  type PurchaseOrderLine,
  type PurchaseOrderRecord,
  type ReasonCode,
  type RuleSet,
  type SubmissionRecord,
  type VendorRecord,
} from './types.ts'

// ---------------------------------------------------------------------------
// Payee and vendor
// ---------------------------------------------------------------------------

/**
 * Printed bank account against the vendor master. Exact string comparison after
 * stripping spaces — a changed digit is the whole point of the check, so nothing
 * beyond layout whitespace is normalised away. A mismatch is a hard fail.
 */
export function checkBankAccount(facts: InvoiceFacts, vendor: VendorRecord | null): CheckResult {
  if (!vendor) return skipped('vendor unresolved')
  if (!vendor.bank_account) return skipped('vendor master holds no bank account')

  const printed = normalizeAccountNumber(facts.bank_account)
  if (printed.length === 0) return skipped('no bank account printed on the document')

  const master = normalizeAccountNumber(vendor.bank_account)
  const evidence: Evidence = { invoice_bank: printed, master_bank: master, vendor_id: vendor.id }

  return printed === master ? pass(evidence) : fail('BANK_DETAIL_MISMATCH', evidence)
}

/**
 * Remit-to entity against the vendor's legal name, through the same normalisation
 * and fuzzy matching as stage 3 rather than string equality. A document printing an
 * abbreviated, differently punctuated form of a master name — "Foo Tech Pvt. Ltd."
 * against a master of "Foo Technologies Pvt Ltd" — names the same payee; equality
 * would turn that into a false BLOCK.
 */
export function checkRemitToEntity(facts: InvoiceFacts, vendor: VendorRecord | null, rules: RuleSet): CheckResult {
  if (!vendor) return skipped('vendor unresolved')
  if (!facts.remit_to_name || normalizeText(facts.remit_to_name).length === 0) {
    return skipped('no remit-to name printed on the document')
  }

  const { same, score } = namesResolveToSameEntity(facts.remit_to_name, vendor.legal_name, rules)
  const evidence: Evidence = {
    remit_to_name: facts.remit_to_name,
    vendor_legal_name: vendor.legal_name,
    similarity: roundTo(score, 4),
    threshold: rules.vendor_match_threshold,
  }

  return same ? pass(evidence) : fail('PAYEE_ENTITY_MISMATCH', evidence)
}

export function checkVendorStatus(vendor: VendorRecord | null): CheckResult {
  if (!vendor) return skipped('vendor unresolved')
  const evidence: Evidence = { vendor_id: vendor.id, status: vendor.status }
  return vendor.status === 'active' ? pass(evidence) : fail('VENDOR_INACTIVE', evidence)
}

export function checkVendorResolved(vendorMatch: VendorMatch, rules: RuleSet): CheckResult {
  const evidence: Evidence = {
    printed_name: vendorMatch.normalized_input,
    best_score: roundTo(vendorMatch.score, 4),
    floor: rules.vendor_match_floor,
    threshold: rules.vendor_match_threshold,
    matched_vendor: vendorMatch.vendor?.id ?? null,
    matched_on: vendorMatch.matched_on,
  }
  return vendorMatch.status === 'unresolved' ? fail('UNKNOWN_VENDOR', evidence) : pass(evidence)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function checkPoStatus(po: PurchaseOrderRecord | null): CheckResult {
  if (!po) return skipped('no purchase order matched')
  const evidence: Evidence = { po_number: po.po_number, status: po.status }
  return po.status === 'open' ? pass(evidence) : fail('PO_NOT_OPEN', evidence)
}

export function checkInvoiceDate(facts: InvoiceFacts, rules: RuleSet, asOf: Date): CheckResult {
  const invoiceDate = parseIsoDate(facts.invoice_date)
  if (!invoiceDate) return skipped('no readable invoice date')

  const ageDays = daysBetween(invoiceDate, asOf)
  const evidence: Evidence = {
    invoice_date: facts.invoice_date,
    as_of: asOf.toISOString().slice(0, 10),
    age_days: ageDays,
    stale_after_days: rules.stale_invoice_days,
  }

  if (ageDays < 0) return fail('DATE_OUT_OF_RANGE', { ...evidence, reason: 'invoice is dated in the future' })
  if (ageDays > rules.stale_invoice_days) {
    return fail('DATE_OUT_OF_RANGE', { ...evidence, reason: 'invoice is older than the staleness limit' })
  }
  return pass(evidence)
}

// No FX conversion is in scope, so a currency difference holds rather than
// converting.
export function checkCurrency(facts: InvoiceFacts, po: PurchaseOrderRecord | null): CheckResult {
  if (!po) return skipped('no purchase order matched')
  const invoiceCurrency = normalizeIdentifier(facts.currency)
  const poCurrency = normalizeIdentifier(po.currency)
  if (invoiceCurrency.length === 0) return skipped('no currency printed on the document')
  if (poCurrency.length === 0) return skipped('purchase order states no currency')

  const evidence: Evidence = { invoice_currency: invoiceCurrency, po_currency: poCurrency, po_number: po.po_number }
  return invoiceCurrency === poCurrency ? pass(evidence) : fail('CURRENCY_MISMATCH', evidence)
}

// ---------------------------------------------------------------------------
// Document sanity
// ---------------------------------------------------------------------------

// A credit note is never queued for payment; it is routed for record-keeping.
export function checkCreditNote(facts: InvoiceFacts): CheckResult {
  const negativeTotal = isFiniteNumber(facts.total) && facts.total < 0
  const evidence: Evidence = { document_type: facts.document_type, total: facts.total }
  return facts.document_type === 'credit_note' || negativeTotal ? fail('CREDIT_NOTE', evidence) : pass(evidence)
}

export const REQUIRED_FACT_FIELDS = ['invoice_number', 'invoice_date', 'total'] as const

export function checkRequiredFields(facts: InvoiceFacts): CheckResult {
  const missing: string[] = []
  if (!facts.invoice_number || normalizeText(facts.invoice_number).length === 0) missing.push('invoice_number')
  if (!parseIsoDate(facts.invoice_date)) missing.push('invoice_date')
  if (!isFiniteNumber(facts.total)) missing.push('total')

  const evidence: Evidence = { required: [...REQUIRED_FACT_FIELDS], missing }
  return missing.length === 0 ? pass(evidence) : fail('INCOMPLETE_EXTRACTION', evidence)
}

/**
 * subtotal + tax = total, within the rounding allowance.
 *
 * Stands down when subtotal or tax is named in `fields_not_printed`: a
 * tax-inclusive layout legitimately states one total and no split, and the correct
 * extraction of a field the document never printed is a null. Treating that as an
 * arithmetic failure would punish a correct read.
 */
export function checkArithmetic(facts: InvoiceFacts, rules: RuleSet): CheckResult {
  const notPrinted = new Set(facts.fields_not_printed)
  if (notPrinted.has('subtotal') || notPrinted.has('tax')) {
    return skipped('document does not print a subtotal/tax split')
  }
  if (!isFiniteNumber(facts.subtotal) || !isFiniteNumber(facts.tax) || !isFiniteNumber(facts.total)) {
    return skipped('subtotal, tax or total was not read')
  }

  const computed = facts.subtotal + facts.tax
  const difference = roundTo(computed - facts.total, 2)
  const evidence: Evidence = {
    subtotal: facts.subtotal,
    tax: facts.tax,
    stated_total: facts.total,
    computed_total: roundTo(computed, 2),
    difference,
    allowance: rules.arithmetic_tolerance,
  }

  return Math.abs(difference) <= rules.arithmetic_tolerance ? pass(evidence) : fail('ARITHMETIC_INCONSISTENT', evidence)
}

/**
 * Whether the invoice and the PO can be put on a common tax basis at all.
 *
 * The normalisation itself lives in `grossFactor` (normalize.ts) and runs on every
 * amount comparison. This check reports the cases where it cannot be resolved from
 * the available data: a PO that states no treatment, a tax-exclusive PO billed by
 * an invoice that neither states a tax amount nor declares that it prints none, or
 * a tax-inclusive PO billed by an invoice that adds a tax line without a subtotal
 * to add it to.
 */
export function checkTaxTreatment(facts: InvoiceFacts, po: PurchaseOrderRecord | null): CheckResult {
  if (!po) return skipped('no purchase order matched')

  const notPrinted = new Set(facts.fields_not_printed)
  const taxPrinted = isFiniteNumber(facts.tax)
  const subtotalPrinted = isFiniteNumber(facts.subtotal)
  const evidence: Evidence = {
    po_number: po.po_number,
    po_tax_treatment: po.tax_treatment,
    invoice_tax: facts.tax,
    invoice_subtotal: facts.subtotal,
    fields_not_printed: facts.fields_not_printed,
  }

  if (po.tax_treatment == null) {
    return fail('TAX_TREATMENT_UNCLEAR', { ...evidence, reason: 'purchase order states no tax treatment' })
  }

  if (po.tax_treatment === 'exclusive' && !taxPrinted && !notPrinted.has('tax')) {
    return fail('TAX_TREATMENT_UNCLEAR', {
      ...evidence,
      reason: 'purchase order prices exclude tax, but the invoice neither states a tax amount nor declares that it prints none',
    })
  }

  if (po.tax_treatment === 'inclusive' && taxPrinted && !subtotalPrinted && !notPrinted.has('subtotal')) {
    return fail('TAX_TREATMENT_UNCLEAR', {
      ...evidence,
      reason: 'purchase order prices include tax, but the invoice states a tax amount with no subtotal to place it against',
    })
  }

  return pass(evidence)
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

export interface LineGroup {
  invoice_index: number
  invoice_description: string | null
  invoice_quantity: number | null
  invoice_gross_amount: number
  po_indexes: number[]
  po_descriptions: (string | null)[]
  similarity: number
  // What the PO says this group should cost. For a single PO line that is its unit
  // price at the invoiced quantity; for a consolidated group it is the group's
  // amount.
  expected_amount: number
}

export interface LineReconciliation {
  groups: LineGroup[]
  unmapped_invoice: { index: number; description: string | null; gross_amount: number }[]
  unmapped_po: { index: number; description: string | null; amount: number }[]
}

function poLineAmount(line: PurchaseOrderLine): number {
  if (isFiniteNumber(line.amount)) return line.amount
  if (isFiniteNumber(line.quantity) && isFiniteNumber(line.unit_price)) return line.quantity * line.unit_price
  return 0
}

function expectedForSingleLine(poLine: PurchaseOrderLine, invoiceLine: LineItemFact): number {
  if (isFiniteNumber(poLine.unit_price) && isFiniteNumber(invoiceLine.quantity)) {
    return poLine.unit_price * invoiceLine.quantity
  }
  return poLineAmount(poLine)
}

/**
 * Maps invoice lines onto PO lines by description similarity.
 *
 * Two shapes real invoices take, neither of which is one-to-one:
 *
 *  - a line consolidates several PO lines ("Office Supplies — Bulk Order" against a
 *    PO itemising chairs and desks). Handled in a second pass: where a mapped
 *    line bills more than its matched PO line, further PO lines that also match it
 *    above the threshold are absorbed into the group until the group covers it.
 *  - a line maps to nothing at all, because the invoice rolls the whole order into
 *    one description. Those come back as unmapped and the coverage check decides
 *    whether the PO has value left to account for them.
 */
export function reconcileLines(
  facts: InvoiceFacts,
  po: PurchaseOrderRecord,
  rules: RuleSet,
): LineReconciliation {
  const grossAmounts = grossLineAmounts(facts)
  const takenPoLines = new Set<number>()
  const groups: LineGroup[] = []
  const unmapped_invoice: LineReconciliation['unmapped_invoice'] = []

  // Best-first assignment so the strongest pairing claims its PO line before a
  // weaker one can take it.
  const pairings = facts.line_items
    .flatMap((invoiceLine, invoiceIndex) =>
      po.line_items.map((poLine, poIndex) => ({
        invoiceIndex,
        poIndex,
        similarity: descriptionSimilarity(invoiceLine.description, poLine.description),
      })),
    )
    .filter((pairing) => pairing.similarity >= rules.line_match_threshold)
    .sort((a, b) => b.similarity - a.similarity)

  const assignedInvoiceLines = new Map<number, LineGroup>()

  for (const pairing of pairings) {
    if (assignedInvoiceLines.has(pairing.invoiceIndex) || takenPoLines.has(pairing.poIndex)) continue
    takenPoLines.add(pairing.poIndex)

    const invoiceLine = facts.line_items[pairing.invoiceIndex]
    const poLine = po.line_items[pairing.poIndex]
    const group: LineGroup = {
      invoice_index: pairing.invoiceIndex,
      invoice_description: invoiceLine.description,
      invoice_quantity: isFiniteNumber(invoiceLine.quantity) ? invoiceLine.quantity : null,
      invoice_gross_amount: roundTo(grossAmounts[pairing.invoiceIndex] || 0, 2),
      po_indexes: [pairing.poIndex],
      po_descriptions: [poLine.description],
      similarity: roundTo(pairing.similarity, 4),
      expected_amount: roundTo(expectedForSingleLine(poLine, invoiceLine), 2),
    }
    assignedInvoiceLines.set(pairing.invoiceIndex, group)
    groups.push(group)
  }

  // Second pass — consolidation. Only runs where a group is billing more than its
  // matched PO line covers, and only absorbs PO lines nothing else claimed.
  for (const group of groups) {
    if (group.invoice_gross_amount <= group.expected_amount) continue

    const invoiceLine = facts.line_items[group.invoice_index]
    const absorbable = po.line_items
      .map((poLine, poIndex) => ({
        poIndex,
        poLine,
        similarity: descriptionSimilarity(invoiceLine.description, poLine.description),
      }))
      .filter((entry) => !takenPoLines.has(entry.poIndex) && entry.similarity >= rules.line_match_threshold)
      .sort((a, b) => b.similarity - a.similarity)

    for (const entry of absorbable) {
      if (group.expected_amount >= group.invoice_gross_amount) break
      takenPoLines.add(entry.poIndex)
      group.po_indexes.push(entry.poIndex)
      group.po_descriptions.push(entry.poLine.description)
      // A consolidated group is compared on amount: the PO's per-unit price for one
      // of several rolled-up lines says nothing about the invoice's single quantity.
      group.expected_amount = roundTo(
        sum(group.po_indexes.map((index) => poLineAmount(po.line_items[index]))),
        2,
      )
      group.similarity = roundTo(Math.min(group.similarity, entry.similarity), 4)
    }
  }

  facts.line_items.forEach((invoiceLine, index) => {
    if (assignedInvoiceLines.has(index)) return
    unmapped_invoice.push({
      index,
      description: invoiceLine.description,
      gross_amount: roundTo(grossAmounts[index] || 0, 2),
    })
  })

  const unmapped_po = po.line_items
    .map((poLine, index) => ({ index, description: poLine.description, amount: roundTo(poLineAmount(poLine), 2) }))
    .filter((entry) => !takenPoLines.has(entry.index))

  return { groups, unmapped_invoice, unmapped_po }
}

/**
 * Every invoice line must be accounted for by the PO, never silently ignored.
 *
 * A line that maps to no PO line by description is not automatically wrong: an
 * invoice is free to describe in one line what the PO itemised in four, and just
 * as free to itemise in four what the PO bundled into one. It is wrong when it
 * bills beyond the PO value that nothing else has accounted for, which is what an
 * added line looks like.
 *
 * Two ways an invoice can be covered, and it only needs one:
 *
 *  - line by line, where what the unmapped lines bill sits inside the PO value
 *    nothing else has claimed;
 *  - in total, where every line on the invoice adds up to what the order
 *    authorised. A vendor itemising a bundle maps nothing at all by description,
 *    because there is one order line and several invoice lines with different
 *    wording, and the first test then reads a fully accounted invoice as entirely
 *    unmapped. What matters is whether more is being billed than was ordered, and
 *    an invoice that adds up to the order is not billing more than it.
 *
 * Both are measured with the same tolerance every other amount comparison uses.
 */
export function checkLineCoverage(
  reconciliation: LineReconciliation,
  po: PurchaseOrderRecord | null,
  rules: RuleSet,
): CheckResult {
  if (!po) return skipped('no purchase order matched')
  if (po.line_items.length === 0) return skipped('purchase order has no line items to map against')
  if (reconciliation.unmapped_invoice.length === 0) return pass({ unmapped_invoice_lines: [] })

  const unmappedInvoiceTotal = sum(reconciliation.unmapped_invoice.map((entry) => entry.gross_amount))
  const unaccountedPoTotal = sum(reconciliation.unmapped_po.map((entry) => entry.amount))
  const allowance = toleranceFor(unaccountedPoTotal, rules.matching_tolerance_pct, rules.matching_tolerance_floor)
  const excess = roundTo(unmappedInvoiceTotal - unaccountedPoTotal, 2)

  // Every line on the invoice, mapped or not, on the same gross basis the order
  // states its total in.
  const billedTotal = roundTo(
    sum(reconciliation.groups.map((group) => group.invoice_gross_amount)) + unmappedInvoiceTotal,
    2,
  )
  const linesSumToOrderTotal =
    isFiniteNumber(po.total_amount) &&
    withinTolerance(billedTotal, po.total_amount, rules.matching_tolerance_pct, rules.matching_tolerance_floor)

  const evidence: Evidence = {
    unmapped_invoice_lines: reconciliation.unmapped_invoice,
    unaccounted_po_lines: reconciliation.unmapped_po,
    unmapped_invoice_total: roundTo(unmappedInvoiceTotal, 2),
    unaccounted_po_total: roundTo(unaccountedPoTotal, 2),
    excess,
    allowance: roundTo(allowance, 2),
    similarity_threshold: rules.line_match_threshold,
    billed_total: billedTotal,
    po_total: po.total_amount,
    lines_sum_to_order_total: linesSumToOrderTotal,
  }

  return excess <= allowance || linesSumToOrderTotal ? pass(evidence) : fail('UNMATCHED_LINE_ITEM', evidence)
}

/**
 * Invoiced quantity against PO quantity less what has already been received.
 *
 * Goods-receipt data is out of scope (two-way match), so `qty_received_to_date` is
 * absent and treated as 0. Only single-line groups are checked: a consolidated
 * group rolls up several PO lines with different units, and its quantity is not
 * comparable to any one of them.
 */
export function checkQuantities(reconciliation: LineReconciliation, po: PurchaseOrderRecord | null): CheckResult {
  if (!po) return skipped('no purchase order matched')

  const overruns: Evidence[] = []

  for (const group of reconciliation.groups) {
    if (group.po_indexes.length !== 1) continue
    const poLine = po.line_items[group.po_indexes[0]]
    if (!isFiniteNumber(group.invoice_quantity) || !isFiniteNumber(poLine.quantity)) continue

    const received = isFiniteNumber(poLine.qty_received_to_date) ? poLine.qty_received_to_date : 0
    const available = poLine.quantity - received
    if (group.invoice_quantity > available) {
      overruns.push({
        invoice_line: group.invoice_description,
        po_line: poLine.description,
        invoice_quantity: group.invoice_quantity,
        po_quantity: poLine.quantity,
        qty_received_to_date: received,
        available,
      })
    }
  }

  const evidence: Evidence = { overruns, lines_checked: reconciliation.groups.length }
  return overruns.length === 0 ? pass(evidence) : fail('QUANTITY_MISMATCH', evidence)
}

/**
 * Unit price against the PO price, within `matching_tolerance_pct`.
 *
 * Two deliberate properties:
 *
 *  - tested on the NET variance across all mapped lines, not line by line.
 *    Reallocating value between lines of one PO is legitimate and routine; what
 *    matters is whether the invoice asks for more money than the PO priced.
 *  - one-sided. Billing a line for less than the PO priced is partial delivery or
 *    under-billing, not a price variance, and AP's exposure is overpayment.
 */
export function checkUnitPrices(reconciliation: LineReconciliation, rules: RuleSet): CheckResult {
  if (reconciliation.groups.length === 0) return skipped('no invoice line mapped to a purchase-order line')

  const lines = reconciliation.groups.map((group) => ({
    invoice_line: group.invoice_description,
    po_lines: group.po_descriptions,
    billed: group.invoice_gross_amount,
    priced: group.expected_amount,
    variance: roundTo(group.invoice_gross_amount - group.expected_amount, 2),
  }))

  const netVariance = roundTo(sum(lines.map((line) => line.variance)), 2)
  const pricedTotal = sum(lines.map((line) => line.priced))
  const allowance = toleranceFor(pricedTotal, rules.matching_tolerance_pct, rules.matching_tolerance_floor)

  const evidence: Evidence = {
    lines,
    net_variance: netVariance,
    priced_total: roundTo(pricedTotal, 2),
    allowance: roundTo(allowance, 2),
  }

  return netVariance <= allowance ? pass(evidence) : fail('PRICE_VARIANCE', evidence)
}

// ---------------------------------------------------------------------------
// Cross-invoice
// ---------------------------------------------------------------------------

/**
 * A document already processed, and when.
 *
 * `received_at` is what orders these against the document being decided. Only
 * documents that arrived before it can make it a duplicate: the first copy of a
 * file to arrive is the original however many times either is re-run, and
 * re-deciding the original after a copy has landed must leave the original alone.
 * Scoping by arrival is what makes both of those true, and it is the caller's job
 * to pass only the earlier arrivals.
 */
export interface PriorRunHash {
  run_id: string
  invoice_number: string
  file_hash: string
  // When the document arrived, and when its run settled. Both are for the
  // duplicate's own explanation: a person needs to know which invoice this
  // repeats and when that one went through.
  received_at?: string | null
  decided_at?: string | null
}

/**
 * The earlier arrival of this exact file, if there is one.
 *
 * Needs the hash and nothing else, which is what lets stage 1 call it before the
 * document has been read. Paying a model to read a file we have already read is
 * money spent to learn nothing.
 */
export function findExactDuplicate(
  fileHash: string | null | undefined,
  priorHashes: readonly PriorRunHash[],
): PriorRunHash | null {
  if (!fileHash) return null
  return priorHashes.find((entry) => entry.file_hash === fileHash) ?? null
}

// The same file, already processed.
export function checkExactDuplicate(facts: InvoiceFacts, priorHashes: readonly PriorRunHash[]): CheckResult {
  if (!facts.file_hash) return skipped('no file hash available for this document')

  const hit = findExactDuplicate(facts.file_hash, priorHashes)
  const evidence: Evidence = {
    file_hash: facts.file_hash,
    prior_run_id: hit?.run_id ?? null,
    prior_invoice_number: hit?.invoice_number ?? null,
    prior_decided_at: hit?.decided_at ?? null,
  }

  return hit ? fail('EXACT_DUPLICATE', evidence) : pass(evidence)
}

/**
 * Same vendor, total within `near_duplicate_amount_pct`, dated within
 * `near_duplicate_window_days`, different invoice number.
 *
 * Backward-looking only. Scanning forward as well would retroactively flag a clean
 * invoice the moment a later copy of it arrived, which is the wrong document to
 * stop.
 */
export function checkNearDuplicate(
  facts: InvoiceFacts,
  vendorId: string | null,
  submissionId: string | null,
  submissions: readonly SubmissionRecord[],
  rules: RuleSet,
): CheckResult {
  const invoiceDate = parseIsoDate(facts.invoice_date)
  if (!vendorId) return skipped('vendor unresolved')
  if (!invoiceDate || !isFiniteNumber(facts.total)) return skipped('invoice date or total not readable')

  const total = facts.total
  const matches = submissions.filter((submission) => {
    if (submission.id === submissionId) return false
    if (submission.vendor_id !== vendorId) return false
    if (submission.document_type !== 'invoice') return false
    if (normalizeIdentifier(submission.invoice_number) === normalizeIdentifier(facts.invoice_number)) return false
    if (!isFiniteNumber(submission.total)) return false

    const priorDate = parseIsoDate(submission.invoice_date)
    if (!priorDate) return false
    const gap = daysBetween(priorDate, invoiceDate)
    if (gap < 0 || gap > rules.near_duplicate_window_days) return false

    return relativeDifference(submission.total, total) <= rules.near_duplicate_amount_pct
  })

  const evidence: Evidence = {
    total,
    window_days: rules.near_duplicate_window_days,
    amount_tolerance_pct: rules.near_duplicate_amount_pct,
    matches: matches.map((match) => ({
      invoice_number: match.invoice_number,
      invoice_date: match.invoice_date,
      total: match.total,
    })),
  }

  return matches.length === 0 ? pass(evidence) : fail('NEAR_DUPLICATE', evidence)
}

// Billing to date plus this invoice against the PO ceiling.
export function checkCumulativeOverage(
  facts: InvoiceFacts,
  po: PurchaseOrderRecord | null,
  rules: RuleSet,
): CheckResult {
  if (!po) return skipped('no purchase order matched')
  if (!isFiniteNumber(po.total_amount)) return skipped('purchase order states no total')

  const total = invoiceGrossTotal(facts)
  if (!isFiniteNumber(total)) return skipped('invoice total not readable')

  const allowance = toleranceFor(po.total_amount, rules.matching_tolerance_pct, rules.matching_tolerance_floor)
  const cumulative = po.amount_billed_to_date + total
  const ceiling = po.total_amount + allowance

  const evidence: Evidence = {
    po_number: po.po_number,
    po_total: po.total_amount,
    amount_billed_to_date: po.amount_billed_to_date,
    this_invoice: total,
    cumulative: roundTo(cumulative, 2),
    ceiling: roundTo(ceiling, 2),
    allowance: roundTo(allowance, 2),
  }

  return cumulative <= ceiling ? pass(evidence) : fail('PO_OVERAGE', evidence)
}

// Does an invoice's notes cite one of the PO's delivery milestones?
export function citesDeliveryMilestone(
  notes: string | null,
  po: PurchaseOrderRecord,
  rules: RuleSet,
): boolean {
  const schedule = po.delivery_schedule ?? []
  if (schedule.length === 0 || !notes || normalizeText(notes).length === 0) return false

  const noteTokens = new Set(tokenize(notes))

  return schedule.some((milestone) => {
    const label = normalizeText(milestone.milestone)
    if (label.length > 0 && label.split(' ').every((token) => noteTokens.has(token))) return true
    return descriptionSimilarity(notes, milestone.description) >= rules.line_match_threshold
  })
}

export interface SplitPatternConditions {
  enough_invoices: boolean
  all_below_auto_approve_limit: boolean
  within_date_window: boolean
  no_milestone_reference: boolean
  amounts_near_uniform: boolean
  cumulative_at_or_above_limit: boolean
}

/**
 * Threshold-split detection. Fires only when ALL SIX conditions hold across the
 * invoices sharing a PO.
 *
 * Conditions 4 and 5 are what separate fraud from legitimate phased billing: a
 * genuine milestone schedule produces invoices of differing amounts, spread over
 * the delivery calendar, each naming the milestone it bills. Drop either and
 * honest phased billing starts getting flagged, which is a worse failure than the
 * one this rule prevents.
 */
export function checkThresholdSplit(
  po: PurchaseOrderRecord | null,
  submissions: readonly SubmissionRecord[],
  rules: RuleSet,
): CheckResult {
  if (!po) return skipped('no purchase order matched')

  const poIdentifier = normalizeIdentifier(po.po_number)
  const siblings = submissions.filter(
    (submission) =>
      submission.document_type === 'invoice' &&
      normalizeIdentifier(submission.po_reference) === poIdentifier &&
      isFiniteNumber(submission.total),
  )

  const totals = siblings.map((sibling) => sibling.total as number)
  const dates = siblings
    .map((sibling) => parseIsoDate(sibling.invoice_date))
    .filter((date): date is Date => date !== null)

  const spanDays =
    dates.length >= 2
      ? daysBetween(
          new Date(Math.min(...dates.map((date) => date.getTime()))),
          new Date(Math.max(...dates.map((date) => date.getTime()))),
        )
      : 0

  const cumulative = sum(totals)
  const cv = coefficientOfVariation(totals)
  const scheduleCited = siblings.some((sibling) => citesDeliveryMilestone(sibling.notes, po, rules))

  const conditions: SplitPatternConditions = {
    enough_invoices: siblings.length >= rules.split_pattern_min_invoices,
    all_below_auto_approve_limit: totals.length > 0 && totals.every((total) => total < rules.auto_approve_limit),
    within_date_window: dates.length === siblings.length && spanDays <= rules.split_pattern_window_days,
    no_milestone_reference: (po.delivery_schedule?.length ?? 0) === 0 || !scheduleCited,
    amounts_near_uniform: totals.length > 0 && cv < rules.split_pattern_cv_max,
    cumulative_at_or_above_limit: cumulative >= rules.auto_approve_limit,
  }

  const evidence: Evidence = {
    po_number: po.po_number,
    conditions,
    invoice_count: siblings.length,
    invoices: siblings.map((sibling) => ({
      invoice_number: sibling.invoice_number,
      invoice_date: sibling.invoice_date,
      total: sibling.total,
    })),
    span_days: spanDays,
    coefficient_of_variation: roundTo(cv, 4),
    cumulative: roundTo(cumulative, 2),
    auto_approve_limit: rules.auto_approve_limit,
    po_has_delivery_schedule: (po.delivery_schedule?.length ?? 0) > 0,
    any_invoice_cites_a_milestone: scheduleCited,
  }

  const allHold = Object.values(conditions).every(Boolean)
  return allHold ? fail('THRESHOLD_SPLIT_SUSPECTED', evidence) : pass(evidence)
}

// ---------------------------------------------------------------------------
// Resubmission lineage
// ---------------------------------------------------------------------------

export type ResubmissionClassification = 'exact_duplicate' | 'resubmission' | 'undeclared_amendment'

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface ResubmissionAssessment {
  parent_run_id: string
  parent_verdict: string | null
  parent_reason_codes: ReasonCode[]
  classification: ResubmissionClassification
  // Every extracted field diffed against the parent, not just the flagged one.
  changed_fields: FieldChange[]
  material_changes: string[]
  flagged_fields: string[]
  undeclared_changes: string[]
}

// Fields that change what gets paid, or to whom. A change here needs to have been
// declared by the parent's flags.
export const MATERIAL_FACT_FIELDS = [
  'invoice_number',
  'vendor_name',
  'po_reference',
  'currency',
  'subtotal',
  'tax',
  'total',
  'bank_account',
  'remit_to_name',
  'document_type',
  'line_items',
] as const

// Which facts each reason code points at — the set a resubmission is licensed to
// change without being an undeclared amendment.
export const REASON_CODE_FIELDS: Readonly<Partial<Record<ReasonCode, readonly string[]>>> = {
  BANK_DETAIL_MISMATCH: ['bank_account'],
  PAYEE_ENTITY_MISMATCH: ['remit_to_name'],
  UNKNOWN_VENDOR: ['vendor_name'],
  NO_PO_MATCH: ['po_reference'],
  AMBIGUOUS_PO_MATCH: ['po_reference'],
  CURRENCY_MISMATCH: ['currency'],
  DATE_OUT_OF_RANGE: ['invoice_date'],
  INCOMPLETE_EXTRACTION: ['invoice_number', 'invoice_date', 'total'],
  ARITHMETIC_INCONSISTENT: ['subtotal', 'tax', 'total'],
  TAX_TREATMENT_UNCLEAR: ['subtotal', 'tax', 'total'],
  QUANTITY_MISMATCH: ['line_items'],
  PRICE_VARIANCE: ['line_items'],
  UNMATCHED_LINE_ITEM: ['line_items'],
  PO_OVERAGE: ['line_items', 'total'],
}

// Reason codes that are not exceptions — their presence does not mean the parent
// run flagged anything.
const NON_EXCEPTION_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'CLEAN_MATCH',
  'RESUBMISSION',
  'LOW_CONFIDENCE_VENDOR_MATCH',
])

const DIFFED_FACT_FIELDS = [
  'invoice_number',
  'invoice_date',
  'vendor_name',
  'po_reference',
  'currency',
  'line_items',
  'subtotal',
  'tax',
  'total',
  'bank_account',
  'remit_to_name',
  'document_type',
  'notes',
  'file_hash',
] as const

function comparableValue(field: string, facts: InvoiceFacts): unknown {
  const value = (facts as unknown as Record<string, unknown>)[field]
  if (field === 'line_items') {
    return (facts.line_items ?? []).map((line) => ({
      description: normalizeText(line.description),
      quantity: line.quantity ?? null,
      unit_price: line.unit_price ?? null,
      amount: line.amount ?? null,
    }))
  }
  if (typeof value === 'string') return normalizeText(value)
  return value ?? null
}

export function diffFacts(parent: InvoiceFacts, child: InvoiceFacts): FieldChange[] {
  const changes: FieldChange[] = []
  for (const field of DIFFED_FACT_FIELDS) {
    const before = comparableValue(field, parent)
    const after = comparableValue(field, child)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({
        field,
        from: (parent as unknown as Record<string, unknown>)[field] ?? null,
        to: (child as unknown as Record<string, unknown>)[field] ?? null,
      })
    }
  }
  return changes
}

/**
 * Classifies a document arriving against a prior run of the same invoice number
 * for the same vendor.
 *
 * Every field is diffed and recorded; the classification is decided on the
 * commercially material ones. A resubmitted document is expected to carry a fresh
 * date and reworded notes — treating those as an amendment would block every
 * legitimate correction — but a changed amount, payee or bank account that the
 * parent's flags did not ask for is exactly what this catches.
 */
export function classifyResubmission(facts: InvoiceFacts, parent: PriorRun): ResubmissionAssessment {
  const changed_fields = diffFacts(parent.facts, facts)
  const material = new Set<string>(MATERIAL_FACT_FIELDS)
  const material_changes = changed_fields.map((change) => change.field).filter((field) => material.has(field))

  const flagged = new Set<string>()
  for (const code of parent.reason_codes) {
    for (const field of REASON_CODE_FIELDS[code] ?? []) flagged.add(field)
  }

  const undeclared_changes = material_changes.filter((field) => !flagged.has(field))
  const parentHadException = parent.reason_codes.some((code) => !NON_EXCEPTION_CODES.has(code))

  const classification: ResubmissionClassification =
    changed_fields.length === 0 && !parentHadException
      ? 'exact_duplicate'
      : undeclared_changes.length > 0
        ? 'undeclared_amendment'
        : 'resubmission'

  return {
    parent_run_id: parent.run_id,
    parent_verdict: parent.verdict,
    parent_reason_codes: parent.reason_codes,
    classification,
    changed_fields,
    material_changes,
    flagged_fields: [...flagged],
    undeclared_changes,
  }
}

// ---------------------------------------------------------------------------
// Stage 5 as a whole
// ---------------------------------------------------------------------------

export interface ValidationInput {
  facts: InvoiceFacts
  vendorMatch: VendorMatch
  poMatch: PoMatchResult
  rules: RuleSet
  asOf: Date
  // Identity of the document being decided, so it can be excluded from its own
  // cross-invoice comparisons.
  submissionId: string | null
  // The received-document ledger, for near-duplicate and split detection.
  submissions: readonly SubmissionRecord[]
  // File hashes seen on prior completed runs.
  priorHashes: readonly PriorRunHash[]
  // The most recent prior run of this invoice number for this vendor, if any.
  parentRun: PriorRun | null
}

export interface ValidationReport {
  credit_note: CheckResult
  exact_duplicate: CheckResult
  bank_account: CheckResult
  remit_to: CheckResult
  vendor_status: CheckResult
  vendor_resolved: CheckResult
  po_status: CheckResult
  currency: CheckResult
  invoice_date: CheckResult
  required_fields: CheckResult
  arithmetic: CheckResult
  tax_treatment: CheckResult
  quantities: CheckResult
  unit_prices: CheckResult
  line_coverage: CheckResult
  threshold_split: CheckResult
  near_duplicate: CheckResult
  cumulative_overage: CheckResult
  reconciliation: LineReconciliation | null
  resubmission: ResubmissionAssessment | null
}

export function runValidations(input: ValidationInput): ValidationReport {
  const { facts, vendorMatch, poMatch, rules, asOf } = input
  const vendor = vendorMatch.vendor
  const po = poMatch.matched

  const reconciliation = po ? reconcileLines(facts, po, rules) : null
  const emptyReconciliation: LineReconciliation = { groups: [], unmapped_invoice: [], unmapped_po: [] }

  return {
    credit_note: checkCreditNote(facts),
    exact_duplicate: checkExactDuplicate(facts, input.priorHashes),
    bank_account: checkBankAccount(facts, vendor),
    remit_to: checkRemitToEntity(facts, vendor, rules),
    vendor_status: checkVendorStatus(vendor),
    vendor_resolved: checkVendorResolved(vendorMatch, rules),
    po_status: checkPoStatus(po),
    currency: checkCurrency(facts, po),
    invoice_date: checkInvoiceDate(facts, rules, asOf),
    required_fields: checkRequiredFields(facts),
    arithmetic: checkArithmetic(facts, rules),
    tax_treatment: checkTaxTreatment(facts, po),
    quantities: checkQuantities(reconciliation ?? emptyReconciliation, po),
    unit_prices: checkUnitPrices(reconciliation ?? emptyReconciliation, rules),
    line_coverage: checkLineCoverage(reconciliation ?? emptyReconciliation, po, rules),
    threshold_split: checkThresholdSplit(po, input.submissions, rules),
    near_duplicate: checkNearDuplicate(facts, vendor?.id ?? null, input.submissionId, input.submissions, rules),
    cumulative_overage: checkCumulativeOverage(facts, po, rules),
    reconciliation,
    resubmission: input.parentRun ? classifyResubmission(facts, input.parentRun) : null,
  }
}
