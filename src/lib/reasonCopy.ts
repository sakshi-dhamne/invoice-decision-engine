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

// ---------------------------------------------------------------------------
// When a service does not answer
// ---------------------------------------------------------------------------

/**
 * The two things to say when an edge function gives us nothing to repeat.
 *
 * Both functions answer a failure with a sentence written for a person, and that
 * sentence is what gets shown. These are only for the cases where there is no
 * sentence to show: the service was never reached, or it answered with a body
 * holding nothing readable. Neither names the function, because what this software
 * calls a service is not a fact about the invoice.
 */
export const SERVICE_UNREACHABLE =
  'We could not reach the service that reads documents. Check the connection, then try again.'

export const SERVICE_GAVE_NO_ANSWER =
  'The service that reads documents did not answer. Try again in a moment.'

/**
 * What each stage was doing, as a clause that can follow "while".
 *
 * STAGE_LABEL is imperative, which is right above a stage in the live view and
 * wrong inside a sentence: "Read the document did not finish" is what reading one
 * out as a noun produced.
 */
const STAGE_FAILURE_CLAUSE: Readonly<Record<string, string>> = {
  ingest: 'receiving the document',
  extract: 'reading the document',
  resolve_vendor: 'identifying the vendor',
  match_po: 'finding the order',
  validate: 'running the checks',
  decide: 'deciding',
  explain: 'writing the explanation',
}

/**
 * Why a run failed, in one sentence: where it stopped, then what went wrong.
 *
 * The detail is the message the failing step produced, which for an extraction is
 * the edge function's own account of what it tried. That is the sentence somebody
 * needs, and it used to be recorded as `Stage "extract" threw: ...` and then never
 * shown anyway.
 */
export function stageFailedSentence(stage: string, detail: string): string {
  const clause = STAGE_FAILURE_CLAUSE[stage] ?? 'working on it'
  const trimmed = detail.trim()
  const ending = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  return trimmed.length > 0 ? `This stopped while ${clause}. ${ending}` : `This stopped while ${clause}.`
}

/**
 * The legacy shape, rewritten rather than shown as it is.
 *
 * Runs that failed before this was recorded as English carry
 * `Stage "extract" threw: <message>`. That names a stage by its function name and
 * says "threw" at a finance manager, so it is translated on the way out rather than
 * left to leak. Deployed data outlives the format that wrote it.
 */
const LEGACY_FAILURE = /^Stage "([a-z_]+)" threw:\s*([\s\S]*)$/

/**
 * The sentence to show for a failed run, from whatever its record holds.
 *
 * Null when the record holds nothing worth showing, which is the caller's cue to
 * fall back to FAILED_RUN_SENTENCE.
 */
export function runFailureSentence(explanation: string | null | undefined): string | null {
  const text = explanation?.trim() ?? ''
  if (text.length === 0) return null
  const legacy = LEGACY_FAILURE.exec(text)
  if (legacy) return stageFailedSentence(legacy[1], legacy[2])
  return text
}

// ---------------------------------------------------------------------------
// Approved by a person
// ---------------------------------------------------------------------------

/**
 * An invoice the rules stopped and a person passed.
 *
 * It reads as approved, because it is, and it says who did so nobody mistakes it
 * for the rules having cleared it. The label is the chip; the sentence says what
 * the rules had decided, which is the thing the reader actually wants to know.
 */
export const APPROVED_BY_PERSON_LABEL = 'Approved by a person'

/**
 * What the checks had done, as a clause that can follow "before that".
 *
 * The verdict labels are chips and do not decline into a sentence: "the checks
 * had review it" is what reading one out as a verb produced.
 */
const RULES_OUTCOME_CLAUSE: Readonly<Record<Verdict, string>> = {
  AUTO_APPROVE: 'the checks had approved it too',
  REVIEW: 'the checks had sent it for review',
  HOLD: 'the checks had held it',
  BLOCK: 'the checks had blocked it',
  ROUTED_NOT_PAID: 'the checks had recorded it rather than paying it',
}

export function approvedByPersonSentence(who: string, when: string, rulesVerdict: Verdict | null): string {
  const clause = rulesVerdict ? RULES_OUTCOME_CLAUSE[rulesVerdict] : 'the checks had stopped it'
  return `${who} approved this on ${when}. Before that, ${clause}, and what they found is unchanged below.`
}

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

// ---------------------------------------------------------------------------
// The checks, by name
// ---------------------------------------------------------------------------

/**
 * What each stage-5 check is looking at, as a person would say it.
 *
 * The keys are the field names on the validation report. Those are how the code
 * refers to a check and they are not a name: "Failed: bank_account" told a reader
 * that something called bank_account had failed, which is neither English nor
 * information. The trail says which checks objected, so it has to be able to name
 * them.
 */
export const CHECK_LABEL: Readonly<Record<string, string>> = {
  credit_note: 'whether this is a credit note',
  exact_duplicate: 'whether we have been through this document before',
  bank_account: 'the bank account',
  remit_to: 'who the payment is directed to',
  vendor_status: 'whether the vendor is still active',
  vendor_resolved: 'whether we recognise the company',
  po_status: 'whether the order is still open',
  currency: 'the currency',
  invoice_date: 'the invoice date',
  required_fields: 'whether everything we need was legible',
  arithmetic: 'whether the figures add up',
  tax_treatment: 'whether the figures include tax',
  quantities: 'the quantities billed',
  unit_prices: 'the amount billed against the order price',
  line_coverage: 'whether every line appears on the order',
  threshold_split: 'whether one order has been split across several invoices',
  near_duplicate: 'whether a recent invoice is almost the same',
  cumulative_overage: 'the total billed against the order',
}

export function checkLabel(key: string): string {
  return CHECK_LABEL[key] ?? key.replace(/_/g, ' ')
}

/**
 * What each stage looks at, for the page that explains the process.
 *
 * The arrows between the stages on that page looked like controls and were not.
 * A stage that opens is the version of that control worth having: somebody who
 * has been handed a link and no explanation can see what a stage actually does
 * without reading the source.
 *
 * The checks stage lists the checks themselves, taken from the table above rather
 * than written out again, so a check added to the engine appears here the day it
 * is added.
 */
export const STAGE_CHECKS: Readonly<Record<string, readonly string[]>> = {
  ingest: [
    'whether the document is where the record says it is',
    'its fingerprint, so a second copy of the same file is recognised without reading it again',
    'whether that exact file has arrived before',
  ],
  extract: [
    'what the page states, copied out field by field',
    'which fields the page does not print at all, which is an absence rather than a failure',
  ],
  resolve_vendor: [
    'the printed company name against the approved vendor list',
    'the same name against each vendor\'s known aliases',
    'how close the best match is, and whether anything else is nearly as close',
  ],
  match_po: [
    'the order number printed on the invoice, when there is one',
    'the amount against each of this vendor\'s open orders',
    'the line wording and the date, when no order number is printed',
    'whether two orders fit equally well, in which case neither is picked',
  ],
  validate: Object.values(CHECK_LABEL),
  decide: [
    'the checks in a fixed order, with the first objection setting the outcome',
    'every other objection, carried alongside it so nothing is hidden by the first',
  ],
  explain: [
    'what the checks found, written up in a sentence or two',
    'nothing that could change the outcome, which is already settled before this runs',
  ],
}

export function stageChecks(stage: string): readonly string[] {
  return STAGE_CHECKS[stage] ?? []
}

// Small counts read better as words in a sentence. Beyond this a numeral is
// clearer than a word, and a run with ten objections is not a sentence anybody is
// reading for its prose.
const NUMBER_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function asWord(value: number): string {
  return NUMBER_WORD[value] ?? String(value)
}

/** A list read aloud: "a", "a and b", "a, b, and c". */
function listSentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/**
 * What the checks stage says about itself.
 *
 * Names the checks that objected rather than counting them. A reader who is told
 * two checks objected still has to go and find out which two, and everything
 * needed to say so is already in hand.
 */
export function objectionSentence(checkKeys: readonly string[]): string {
  if (checkKeys.length === 0) return 'Every check that applies to this invoice passed.'
  const named = listSentence(checkKeys.map(checkLabel))
  return checkKeys.length === 1
    ? `One check objected: ${named}.`
    : `${asWord(checkKeys.length).charAt(0).toUpperCase()}${asWord(checkKeys.length).slice(1)} checks objected: ${named}.`
}

/**
 * Which checks on a validation report did not pass.
 *
 * Reads the report structurally rather than naming any check, so a new check
 * appears here the moment it is added to the report.
 */
export function checksThatObjected(report: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(report)
    .filter(([, value]) => value !== null && typeof value === 'object' && 'passed' in value && !(value as { passed: unknown }).passed)
    .map(([name]) => name)
}

// ---------------------------------------------------------------------------
// The other invoices a decision is about
// ---------------------------------------------------------------------------

/**
 * Three checks reach their answer by comparing this invoice with other invoices.
 * Each of them used to report a finding and show none of what it found, which
 * leaves the reader holding the judgement and none of the evidence: whether a
 * near-duplicate is a resubmission or a monthly bill is not something the rules
 * can settle, and not something a person can settle without seeing both.
 */
export const OTHERS_LIKE_THIS_LABEL = 'Others like this'

export const COMPARED_BY_SENTENCE: Readonly<Record<string, string>> = {
  near_duplicate:
    'These came from this vendor close to this invoice in both date and amount. A resubmission repeats a bill that has already been sent; recurring work produces one like it every month.',
  threshold_split:
    'These bill against the same order within a short span, each one just under the limit for approving without a person.',
}

export function comparedBySentence(check: string | null): string {
  return check ? (COMPARED_BY_SENTENCE[check] ?? '') : ''
}

// The invoices on one order, on the decision and on the order itself.
export const ORDER_INVOICES_LABEL = 'Invoices against this order'
export const ORDER_INVOICES_EMPTY = 'Nothing else has been billed against this order.'

/** Marks an invoice whose value is committed, so the balance already reflects it. */
export const COUNTS_AGAINST_ORDER_LABEL = 'Counting against the balance'
export const NOT_COUNTING_LABEL = 'Not counted yet'

/** How far past the order this invoice would take it. */
export const ORDER_OVERAGE_LABEL = 'Over the order by'

// The order list, and one order.
export const ORDERS_EMPTY = 'No order matches these filters. Widen them, or clear the search.'
export const ORDER_NOT_FOUND = 'There is no order by that number. It may have been raised under another.'

/**
 * Raising an order with no invoice in front of you.
 *
 * The counterpart to raising one from a held invoice, and the ordinary way round:
 * the order is recorded when the work is agreed, and the invoice turns up against
 * it later. None of the "do not take this off the invoice" warnings belong on this
 * screen, because there is no invoice here to take anything off. Every field is
 * typed by the person raising the order.
 */
export const NEW_ORDER_LABEL = 'New order'
export const NEW_ORDER_TITLE = 'Raise a new order'
export const NEW_ORDER_INTRO =
  'Record what has been agreed with a vendor. Invoices that arrive against this order are checked on what you enter here.'
export const NEW_ORDER_VENDOR_EMPTY = 'No active vendor matches that. Clear the search, or add the vendor first.'
export const NEW_ORDER_NUMBER_NOTE = 'The next number after this vendor\'s existing orders. Change it if yours are numbered differently.'
export const NEW_ORDER_SUBMIT = 'Raise the order'
export const NEW_ORDER_INCOMPLETE = 'Choose a vendor and fill in the order number, description, value and date.'

/**
 * Adding a vendor with no invoice in front of you.
 *
 * The counterpart to the flow opened from a held invoice. That one reacts to a
 * document from a company we cannot match; this is the ordinary way round, where
 * the vendor is on the list before its first invoice arrives.
 *
 * The payment warning is the one thing that does not change between them. On the
 * invoice-driven screen it says "do not copy these off the invoice"; here there is
 * no invoice to copy from, and the reason the fields are confirmed out of band is
 * the same either way: the account on file is what every future invoice is checked
 * against, so it cannot come from anything the vendor sent us.
 */
export const NEW_VENDOR_LABEL = 'Add vendor'
export const NEW_VENDOR_TITLE = 'Add a vendor'
export const NEW_VENDOR_INTRO =
  'Put a company on the approved vendor list before its first invoice arrives. Invoices from it are checked against what you enter here.'
export const NEW_VENDOR_SUBMIT = 'Add the vendor'
export const NEW_VENDOR_INCOMPLETE =
  'Fill in the registered name, your name and all three payment fields to continue.'

/**
 * Why the three payment fields are typed rather than read.
 *
 * One sentence, shared by both screens that add a vendor, because the rule is the
 * same on both and a control explained two slightly different ways is a control
 * somebody will argue with. The second clause is the reason the field is never
 * prefilled anywhere, not a claim that an invoice is on screen: the account on file
 * is what every future invoice from this vendor is checked against, so it cannot
 * come from anything the vendor sent us.
 */
export const PAYMENT_CONFIRMATION_NOTE =
  'Confirm these with the vendor on a phone number you already have. If we copied them off the invoice, the invoice would be checking itself and the fraud control would stop working.'

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

// The editable fields, named as the form names them. Used by the form's labels and
// by the change history, so a change reads with the same word the person typed it
// under.
export const VENDOR_FIELD_LABEL: Readonly<Record<string, string>> = {
  legal_name: 'Registered name',
  aliases: 'Also known as',
  gstin: 'Tax registration number',
  address: 'Address',
  email_domain: 'Billing domain',
  status: 'Status',
  bank_account: 'Account number',
  bank_ifsc: 'IFSC',
}

export function vendorFieldLabel(field: string): string {
  return VENDOR_FIELD_LABEL[field] ?? field.replace(/_/g, ' ')
}

/**
 * The note a reviewer sees when a vendor's account has moved recently.
 *
 * Deliberately says what happened and when, and stops. An account changing is not
 * evidence of anything on its own: vendors do move banks. What it is, is the one
 * moment where a person looking at the invoice is worth more than any check, and
 * they cannot be that if nobody tells them.
 */
export function bankChangedRecentlySentence(days: number): string {
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
  return `This vendor's bank account was changed ${when}. Check that this invoice is being paid to the account you expect.`
}

export const BANK_CHANGED_RECENTLY_LABEL = 'Recently changed bank account'

/**
 * What to say when the hold has already been answered.
 *
 * A run records what was true when it was decided. A vendor added since then does
 * not change that record, and should not: the invoice was genuinely held because
 * we did not know the company. But offering to add a company that is already on
 * the list is an action that cannot work, and the reader is left to work out why.
 */
export function vendorAddedSinceSentence(legalName: string): string {
  return `${legalName} is on the approved vendor list now, added after this invoice was held. Check the invoice again and it will be decided against the vendor we hold.`
}

// The out-of-band confirmation, wherever it is shown.
export const BANK_CONFIRMED_LABEL = 'Who confirmed these details'
export const BANK_CONFIRMED_MISSING = 'Nobody is recorded as having confirmed this account.'

/**
 * A vendor nobody added, because it came with the corpus.
 *
 * `added_by` is null on every vendor that was seeded, and on nothing else: the
 * onboarding form has required a name since it started writing the column. Reading
 * that null as "by somebody not recorded" accused the starting data of a lapse
 * that never happened, on most of the list.
 */
export const VENDOR_FROM_SEED = 'Added with the starting data'

export function vendorAddedBy(addedBy: string | null | undefined): string {
  const name = addedBy?.trim() ?? ''
  return name.length > 0 ? `Added by ${name}` : VENDOR_FROM_SEED
}

// The change history on a vendor.
export const VENDOR_HISTORY_EMPTY = 'Nothing has been changed since this vendor was added.'
export const PAYMENT_CHANGE_LABEL = 'Payment details'
export const IDENTITY_CHANGE_LABEL = 'Details'

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
