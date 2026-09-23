// Stage 7 contract, shared between the browser pipeline and the Deno
// explain-decision edge function — the same arrangement extractionSchema.ts uses,
// so the two sides cannot drift apart.
//
// Everything here is pure. The model is asked to phrase a verdict that has already
// been settled by deterministic code; it cannot change the outcome, and if the call
// fails the run still completes on `fallbackExplanation`.

import type { Evidence, ReasonCode, Verdict } from './types.ts'

export const EXPLAIN_PROMPT = [
  'Tell a finance manager what is going on with this invoice, in under 60 words.',
  '',
  'Write to the reader, about the document. Say what is wrong and what that means for them.',
  '',
  'Rules:',
  '1. Never name the system, the software, or "accounts payable" as the actor. Nothing "was decided by" anything. The invoice, the vendor and the order are the subjects of your sentences.',
  '2. Do not open by restating the verdict. The reader can already see it. Open with the thing that is actually wrong.',
  '3. Plain sentences. Name the specific amounts, vendors and order numbers involved, and use them rather than describing them in the abstract.',
  '4. Describe what was observed. Never guess at why anyone did anything, and never suggest fraud.',
  '5. No advice, no next steps, no closing summary. Stop when you have said what is true.',
  '6. Under 60 words. Two or three sentences is usually right.',
  '',
  'For an invoice from a company that is not on the vendor list and cites no order, this reads well:',
  '"Zenith Traders is not in the approved vendor list, and this invoice cites no purchase order. There is nothing on file to check it against."',
].join('\n')

export interface ExplainDecisionRequest {
  verdict: Verdict
  reason_codes: string[]
  evidence: Record<string, Evidence>
  // Enough of the document for the paragraph to name real amounts and references.
  summary?: {
    invoice_number?: string | null
    vendor_name?: string | null
    total?: number | null
    currency?: string | null
    matched_po?: string | null
  }
}

export interface ExplainDecisionSuccess {
  ok: true
  explanation: string
  model: string
  provider: string
  duration_ms: number
  /**
   * How many tokens the model spent thinking before it answered, as it reports
   * them. Stage 7 describes a decision that is already settled, so the request
   * asks for none. Anything above zero means the budget was not applied, and null
   * means the provider did not say. Carried into the stage log so the question is
   * answerable from a run rather than by guessing.
   */
  thought_tokens?: number | null
}

export interface ExplainDecisionFailure {
  ok: false
  error: string
}

export type ExplainDecisionResponse = ExplainDecisionSuccess | ExplainDecisionFailure

// How the fallback sentence ends. Written as something that happened to this
// document rather than as an action a department took.
export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  AUTO_APPROVE: 'cleared every check and needs nobody',
  REVIEW: 'needs somebody to look at it',
  HOLD: 'is on hold until something is resolved',
  BLOCK: 'will not be paid',
  ROUTED_NOT_PAID: 'is filed rather than paid',
}

export const REASON_CODE_LABELS: Readonly<Record<ReasonCode, string>> = {
  CREDIT_NOTE: 'the document is a credit note, so it is recorded rather than paid',
  EXACT_DUPLICATE: 'the same document has already been processed',
  UNDECLARED_AMENDMENT: 'the resubmitted document changes fields that the original was not flagged for',
  RESUBMISSION: 'the document is a resubmission of an earlier one and was re-checked in full',
  BANK_DETAIL_MISMATCH: 'the bank account printed on the invoice differs from the vendor master',
  PAYEE_ENTITY_MISMATCH: 'the remit-to entity is not the vendor the purchase order was raised against',
  VENDOR_INACTIVE: 'the vendor is inactive in the master',
  UNKNOWN_VENDOR: 'the printed vendor name does not resolve to any vendor in the master',
  PO_NOT_OPEN: 'the purchase order is not open',
  CURRENCY_MISMATCH: 'the invoice currency differs from the purchase order currency',
  DATE_OUT_OF_RANGE: 'the invoice date is in the future or older than the staleness limit',
  INCOMPLETE_EXTRACTION: 'a required field could not be read from the document',
  ARITHMETIC_INCONSISTENT: 'the subtotal and tax do not add up to the stated total',
  TAX_TREATMENT_UNCLEAR: 'the invoice and the purchase order cannot be placed on a common tax basis',
  NO_PO_MATCH: 'the document cites no purchase order, so it could not be matched automatically',
  AMBIGUOUS_PO_MATCH: 'more than one purchase order fits this invoice equally well',
  QUANTITY_MISMATCH: 'the invoiced quantity exceeds what the purchase order leaves available',
  PRICE_VARIANCE: 'the invoiced amount exceeds the purchase-order price beyond tolerance',
  UNMATCHED_LINE_ITEM: 'an invoice line bills beyond what the purchase order accounts for',
  THRESHOLD_SPLIT_SUSPECTED: 'several similar invoices against one purchase order sit just under the approval limit',
  NEAR_DUPLICATE: 'a recent invoice from the same vendor has almost the same total',
  PO_OVERAGE: 'billing against this purchase order would exceed its total plus tolerance',
  ABOVE_AUTO_APPROVE_LIMIT: 'the total is at or above the automatic approval limit',
  CLEAN_MATCH: 'every check passed',
  LOW_CONFIDENCE_VENDOR_MATCH: 'the vendor name matched the master only weakly',
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

function formatAmount(total: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof total !== 'number' || !Number.isFinite(total)) return null
  const formatted = total.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return currency ? `${currency} ${formatted}` : formatted
}

/**
 * The deterministic explanation. Used whenever the model call fails, is switched
 * off, or would be a waste of a request — a run must never depend on it.
 */
export function fallbackExplanation(request: ExplainDecisionRequest): string {
  const { summary } = request
  const subject = summary?.invoice_number ? `Invoice ${summary.invoice_number}` : 'This invoice'
  const vendor = summary?.vendor_name ? ` from ${summary.vendor_name}` : ''
  const amount = formatAmount(summary?.total, summary?.currency)
  const amountClause = amount ? ` for ${amount}` : ''
  const poClause = summary?.matched_po ? ` against ${summary.matched_po}` : ''

  const reasons = request.reason_codes
    .map((code) => REASON_CODE_LABELS[code as ReasonCode])
    .filter((label): label is string => Boolean(label))

  const verdictClause = VERDICT_LABELS[request.verdict] ?? request.verdict
  const head = `${subject}${vendor}${amountClause}${poClause} ${verdictClause}.`

  if (reasons.length === 0) return head
  const why =
    reasons.length === 1
      ? capitalise(reasons[0])
      : `${capitalise(reasons.slice(0, -1).join(', '))}, and ${reasons[reasons.length - 1]}`

  return `${why}. ${head}`
}

// The user turn sent to the model. The verdict and its evidence go in as settled
// facts; the model is only asked to phrase them.
export function buildExplainUserMessage(request: ExplainDecisionRequest): string {
  return [
    EXPLAIN_PROMPT,
    '',
    'Decision (already final — describe it, do not re-evaluate it):',
    JSON.stringify(
      {
        verdict: request.verdict,
        reason_codes: request.reason_codes,
        document: request.summary ?? {},
        evidence: request.evidence,
      },
      null,
      2,
    ),
  ].join('\n')
}
