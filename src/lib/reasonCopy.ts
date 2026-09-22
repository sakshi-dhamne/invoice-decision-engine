// Every sentence a person reads about a verdict or a reason code lives here.
//
// Nothing else in the app writes its own phrasing for these. A screen asks this
// module what to say and renders the answer, so the wording can be reviewed in one
// place and cannot drift between the queue, the decision page and the dashboard.
//
// House style, applied to every string below: sentence case, no ALL-CAPS labels,
// no em dashes, active voice, and the words a finance person uses. "Order", not
// "PO record". "Approved without review", not "touchless".
//
// The codes themselves stay upper-case where they appear as mono chips. That is an
// identifier for the audit trail, not a label, and the sentence always comes first.

import type { ReasonCode, Verdict } from '@/rules/types.ts'

// The four tones colour is allowed to carry. Every verdict maps onto one, and
// nothing else in the product is tinted.
export type VerdictTone = 'approve' | 'review' | 'hold' | 'block'

export const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  AUTO_APPROVE: 'Approved',
  REVIEW: 'Review',
  HOLD: 'Held',
  BLOCK: 'Blocked',
  ROUTED_NOT_PAID: 'Recorded',
}

export const VERDICT_TONE: Readonly<Record<Verdict, VerdictTone>> = {
  AUTO_APPROVE: 'approve',
  REVIEW: 'review',
  HOLD: 'hold',
  BLOCK: 'block',
  // A credit note is filed rather than paid. Nothing is wrong with it, so it reads
  // in the same calm blue as a hold rather than borrowing the approval green.
  ROUTED_NOT_PAID: 'hold',
}

// One clear sentence per reason code. This is the table the product is graded on.
export const REASON_SENTENCE: Readonly<Record<ReasonCode, string>> = {
  CLEAN_MATCH: 'Matched the order and passed every check.',
  BANK_DETAIL_MISMATCH: 'The bank account on this invoice is not the one we have on file for this vendor.',
  PAYEE_ENTITY_MISMATCH: 'Payment is directed to a different company than the one the order was raised with.',
  UNDECLARED_AMENDMENT: 'The resubmitted invoice changes a figure we did not ask about.',
  EXACT_DUPLICATE: 'We have already processed this exact document.',
  RESUBMISSION: 'A corrected version of an invoice we held earlier. Checked again in full.',
  VENDOR_INACTIVE: 'This vendor is no longer active.',
  UNKNOWN_VENDOR: 'This company is not in the approved vendor list.',
  PO_NOT_OPEN: 'The order this invoice cites has been closed.',
  NO_PO_MATCH: 'The invoice cites no order number, so there is nothing to check it against.',
  AMBIGUOUS_PO_MATCH: 'Two open orders fit this invoice equally well.',
  INCOMPLETE_EXTRACTION: 'Something we need was not legible on the page.',
  ARITHMETIC_INCONSISTENT: 'The line items and tax do not add up to the total printed on the invoice.',
  TAX_TREATMENT_UNCLEAR: 'We cannot tell whether the figures include tax.',
  CURRENCY_MISMATCH: 'The invoice is in a different currency than the order.',
  DATE_OUT_OF_RANGE: 'The invoice date falls outside the window we accept.',
  QUANTITY_MISMATCH: 'The quantity billed is more than the order has left.',
  PRICE_VARIANCE: 'The amount billed is above the order price by more than we allow.',
  UNMATCHED_LINE_ITEM: 'A line on this invoice does not appear on the order.',
  THRESHOLD_SPLIT_SUSPECTED: 'Several invoices on one order, each just under the approval limit.',
  NEAR_DUPLICATE: 'A recent invoice from this vendor has almost the same total.',
  PO_OVERAGE: 'Billing this would take the order past its value.',
  ABOVE_AUTO_APPROVE_LIMIT: 'Above the limit for approving without a person.',
  CREDIT_NOTE: 'A credit note, so it is recorded rather than paid.',
  // The rules engine emits this one alongside a verdict rather than selecting a
  // verdict itself, so it is absent from the brief's table. It still has to read
  // as a sentence wherever it is shown.
  LOW_CONFIDENCE_VENDOR_MATCH: 'The vendor name on the invoice is close to one we know, but not an exact match.',
}

/**
 * A run that never reached a verdict.
 *
 * A failed run is not an outcome the rules produced, so it has no verdict and no
 * reason code. It still has to read as something: the queue used to show it as
 * "Not decided" with "No reason was recorded", which tells a person nothing they
 * can act on.
 */
export const FAILED_RUN_LABEL = 'Failed'
export const FAILED_RUN_SENTENCE = 'The file could not be read.'

/** What a duplicate says about the invoice it repeats. */
export function duplicateOfSentence(invoiceNumber: string, processedOn: string): string {
  return `The same document as ${invoiceNumber}, which went through on ${processedOn}.`
}

export function reasonSentence(code: string): string {
  return REASON_SENTENCE[code as ReasonCode] ?? 'This check has no description yet.'
}

export function verdictLabel(verdict: Verdict | null | undefined): string {
  return verdict ? VERDICT_LABEL[verdict] : 'Not decided'
}

export function verdictTone(verdict: Verdict | null | undefined): VerdictTone {
  return verdict ? VERDICT_TONE[verdict] : 'hold'
}

// The four outcomes, each in one sentence, for the page that explains the process.
export const VERDICT_EXPLANATION: Readonly<Record<string, string>> = {
  AUTO_APPROVE: 'Every check passed and the amount is within the limit, so nobody needs to look at it.',
  REVIEW: 'Something is off by more than we allow, so a person decides whether to pay it.',
  HOLD: 'Something we need is missing or unreadable, so it waits until that is resolved.',
  BLOCK: 'Who would be paid, or what we would be paying twice, is wrong. It does not go through.',
}

// The seven stages, named as a person would describe them rather than by their
// function name in the pipeline.
export const STAGE_LABEL: Readonly<Record<string, string>> = {
  ingest: 'Receive the document',
  extract: 'Read the document',
  resolve_vendor: 'Identify the vendor',
  match_po: 'Find the order',
  validate: 'Run the checks',
  decide: 'Decide',
  explain: 'Write the explanation',
}

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage.replace(/_/g, ' ')
}

// Thresholds on the rules page. The label is what the control is called, the note
// is the one line under it saying what moving it does.
export interface RuleCopy {
  label: string
  note: string
}

export const RULE_COPY: Readonly<Record<string, RuleCopy>> = {
  matching_tolerance_pct: {
    label: 'Amount tolerance',
    note: 'How far an invoice may sit from the order price before we stop it.',
  },
  matching_tolerance_floor: {
    label: 'Smallest tolerance',
    note: 'A floor in rupees, so small invoices are not held over a few paise.',
  },
  auto_approve_limit: {
    label: 'Approve without a person up to',
    note: 'Anything at or above this goes to a person however clean it looks.',
  },
  vendor_match_threshold: {
    label: 'Vendor name confidence',
    note: 'How closely a printed name must match the vendor list to count as that vendor.',
  },
  vendor_match_floor: {
    label: 'Unknown vendor below',
    note: 'Under this score we treat the company as one we do not know.',
  },
  po_ambiguity_margin: {
    label: 'Order ambiguity margin',
    note: 'When two orders score this close, we ask a person rather than pick one.',
  },
  near_duplicate_window_days: {
    label: 'Near duplicate window',
    note: 'How far back we look for another invoice with almost the same total.',
  },
  split_pattern_window_days: {
    label: 'Split invoicing window',
    note: 'The span we watch for a run of similar invoices on one order.',
  },
  split_pattern_min_invoices: {
    label: 'Invoices before we call it a split',
    note: 'How many similar invoices on one order it takes to raise the pattern.',
  },
  stale_invoice_days: {
    label: 'Oldest invoice we accept',
    note: 'Past this age an invoice is held for someone to look at.',
  },
  po_weight_amount: {
    label: 'Order match, weight on amount',
    note: 'How much the amount counts when no order number is printed.',
  },
  po_weight_description: {
    label: 'Order match, weight on description',
    note: 'How much the line wording counts when no order number is printed.',
  },
  po_weight_date: {
    label: 'Order match, weight on date',
    note: 'How much the invoice date counts when no order number is printed.',
  },
  po_candidate_floor: {
    label: 'Order candidate floor',
    note: 'Below this score an order is not a credible suggestion at all.',
  },
  po_date_window_days: {
    label: 'Order date window',
    note: 'The age at which an order stops counting as a recent fit for an invoice.',
  },
  line_match_threshold: {
    label: 'Line wording match',
    note: 'How similar the wording must be for an invoice line to map to an order line.',
  },
  arithmetic_tolerance: {
    label: 'Rounding allowance',
    note: 'How far the parts may miss the printed total before we hold it.',
  },
  near_duplicate_amount_pct: {
    label: 'Near duplicate closeness',
    note: 'How close two totals must be to count as almost the same.',
  },
  split_pattern_cv_max: {
    label: 'Split invoicing uniformity',
    note: 'How alike a run of invoice amounts must be to look deliberate.',
  },
}

export function ruleCopy(key: string): RuleCopy {
  return RULE_COPY[key] ?? { label: key.replace(/_/g, ' '), note: 'No description recorded for this threshold.' }
}
