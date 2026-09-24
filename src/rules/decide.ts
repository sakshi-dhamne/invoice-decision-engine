// Stage 6 — the rules table.
//
// First match wins, evaluated in the order below. Every matching code is
// collected, not just the first: the verdict comes from the first match, and the
// full set goes into runs.reason_codes so a reviewer sees everything that was
// wrong rather than only the most severe thing.
//
// Every threshold is read from the `rules` table at runtime. Nothing here is
// tuned to any particular invoice, vendor or purchase order.

import { billMatchedOrder } from './billing.ts'
import type { BilledDocument } from './billing.ts'
import { isFiniteNumber, roundTo } from './normalize.ts'
import { matchPurchaseOrder } from './poMatch.ts'
import type { PoMatchResult } from './poMatch.ts'
import { runValidations } from './validate.ts'
import type { PriorRunHash, ValidationReport } from './validate.ts'
import { isSkipped } from './types.ts'
import type {
  CheckResult,
  Evidence,
  InvoiceFacts,
  PriorRun,
  PurchaseOrderRecord,
  ReasonCode,
  RuleSet,
  SubmissionRecord,
  VendorRecord,
  Verdict,
} from './types.ts'
import { resolveVendor } from './vendor.ts'
import type { VendorMatch } from './vendor.ts'

export interface DecisionContext {
  facts: InvoiceFacts
  vendorMatch: VendorMatch
  poMatch: PoMatchResult
  checks: ValidationReport
  rules: RuleSet
}

export interface MatchedRule {
  rule: number
  code: ReasonCode
  verdict: Verdict | null
  evidence: Evidence
}

export interface DecisionResult {
  verdict: Verdict
  // First match first, then every other matching code in table order, then any
  // advisory flags.
  reason_codes: ReasonCode[]
  primary: ReasonCode
  matched_rule: number
  matches: MatchedRule[]
  evidence: Record<string, Evidence>
  // Set when rule 3 fired: the parent's exception was cleared and the remaining
  // rules were re-run from the top.
  reevaluated: boolean
}

type RuleTest = (ctx: DecisionContext) => CheckResult | boolean

interface DecisionRuleRow {
  rule: number
  code: ReasonCode
  // `null` means the row does not emit a verdict — see rule 3.
  verdict: Verdict | null
  test: RuleTest
}

function failed(result: CheckResult): boolean {
  return !result.passed
}

function evidenceOf(result: CheckResult | boolean): Evidence {
  return typeof result === 'boolean' ? {} : (result.evidence ?? {})
}

function matched(result: CheckResult | boolean): boolean {
  return typeof result === 'boolean' ? result : failed(result)
}

/**
 * The decision table, in evaluation order.
 *
 * One documented departure from the brief's table: rule 14 holds rather than
 * reviews. A purchase order is what authorises a payment, and an invoice that
 * cites none has not been matched — the PO stage still infers a candidate, but an
 * inference is a suggestion for a human, not authority to pay. That makes it a
 * document the vendor needs to correct (HOLD), while rule 15 — several plausible
 * POs, everything else in order — is a decision a reviewer can make from what is
 * already on file (REVIEW). The corpus agrees: the two no-reference invoices are
 * expected to hold and both were later resubmitted carrying the reference, which
 * is the hold being satisfied.
 */
export const DECISION_RULES: readonly DecisionRuleRow[] = [
  {
    rule: 1,
    code: 'EXACT_DUPLICATE',
    verdict: 'BLOCK',
    test: (ctx) =>
      failed(ctx.checks.exact_duplicate)
        ? ctx.checks.exact_duplicate
        : ctx.checks.resubmission?.classification === 'exact_duplicate'
          ? { passed: false, evidence: { resubmission: ctx.checks.resubmission } }
          : false,
  },
  {
    rule: 2,
    code: 'UNDECLARED_AMENDMENT',
    verdict: 'BLOCK',
    test: (ctx) =>
      ctx.checks.resubmission?.classification === 'undeclared_amendment'
        ? { passed: false, evidence: { resubmission: ctx.checks.resubmission } }
        : false,
  },
  {
    // The only row that does not emit a verdict: it clears the parent's flag and
    // re-runs the remaining rules from the top. The verdict is whatever they
    // then produce.
    rule: 3,
    code: 'RESUBMISSION',
    verdict: null,
    test: (ctx) =>
      ctx.checks.resubmission?.classification === 'resubmission'
        ? { passed: false, evidence: { resubmission: ctx.checks.resubmission } }
        : false,
  },
  { rule: 4, code: 'BANK_DETAIL_MISMATCH', verdict: 'BLOCK', test: (ctx) => ctx.checks.bank_account },
  { rule: 5, code: 'PAYEE_ENTITY_MISMATCH', verdict: 'BLOCK', test: (ctx) => ctx.checks.remit_to },
  { rule: 6, code: 'VENDOR_INACTIVE', verdict: 'BLOCK', test: (ctx) => ctx.checks.vendor_status },
  { rule: 7, code: 'UNKNOWN_VENDOR', verdict: 'HOLD', test: (ctx) => ctx.checks.vendor_resolved },
  { rule: 8, code: 'PO_NOT_OPEN', verdict: 'HOLD', test: (ctx) => ctx.checks.po_status },
  { rule: 9, code: 'CURRENCY_MISMATCH', verdict: 'HOLD', test: (ctx) => ctx.checks.currency },
  { rule: 10, code: 'DATE_OUT_OF_RANGE', verdict: 'HOLD', test: (ctx) => ctx.checks.invoice_date },
  { rule: 11, code: 'INCOMPLETE_EXTRACTION', verdict: 'HOLD', test: (ctx) => ctx.checks.required_fields },
  { rule: 12, code: 'ARITHMETIC_INCONSISTENT', verdict: 'HOLD', test: (ctx) => ctx.checks.arithmetic },
  { rule: 13, code: 'TAX_TREATMENT_UNCLEAR', verdict: 'HOLD', test: (ctx) => ctx.checks.tax_treatment },
  {
    rule: 14,
    code: 'NO_PO_MATCH',
    verdict: 'HOLD',
    test: (ctx) =>
      ctx.poMatch.outcome === 'none' || ctx.poMatch.outcome === 'inferred'
        ? {
            passed: false,
            evidence: {
              reference_as_printed: ctx.poMatch.reference_as_printed,
              outcome: ctx.poMatch.outcome,
              suggested: ctx.poMatch.candidates.map((po) => po.po_number),
              scores: ctx.poMatch.breakdown.slice(0, 3),
            },
          }
        : false,
  },
  {
    rule: 15,
    code: 'AMBIGUOUS_PO_MATCH',
    verdict: 'REVIEW',
    test: (ctx) =>
      ctx.poMatch.outcome === 'ambiguous'
        ? {
            passed: false,
            evidence: {
              candidates: ctx.poMatch.candidates.map((po) => po.po_number),
              margin: ctx.rules.po_ambiguity_margin,
              scores: ctx.poMatch.breakdown.slice(0, 3),
            },
          }
        : false,
  },
  { rule: 16, code: 'QUANTITY_MISMATCH', verdict: 'REVIEW', test: (ctx) => ctx.checks.quantities },
  { rule: 17, code: 'PRICE_VARIANCE', verdict: 'REVIEW', test: (ctx) => ctx.checks.unit_prices },
  { rule: 18, code: 'UNMATCHED_LINE_ITEM', verdict: 'REVIEW', test: (ctx) => ctx.checks.line_coverage },
  { rule: 19, code: 'THRESHOLD_SPLIT_SUSPECTED', verdict: 'REVIEW', test: (ctx) => ctx.checks.threshold_split },
  { rule: 20, code: 'NEAR_DUPLICATE', verdict: 'REVIEW', test: (ctx) => ctx.checks.near_duplicate },
  { rule: 21, code: 'PO_OVERAGE', verdict: 'REVIEW', test: (ctx) => ctx.checks.cumulative_overage },
  {
    rule: 22,
    code: 'ABOVE_AUTO_APPROVE_LIMIT',
    verdict: 'REVIEW',
    test: (ctx) =>
      isFiniteNumber(ctx.facts.total) && ctx.facts.total >= ctx.rules.auto_approve_limit
        ? {
            passed: false,
            evidence: { total: ctx.facts.total, auto_approve_limit: ctx.rules.auto_approve_limit },
          }
        : false,
  },
]

// Rules 1-3 are about this document's relationship to a prior run. Once rule 3 has
// cleared the parent's flag they must not fire again on the re-run.
const LINEAGE_RULES: ReadonlySet<number> = new Set([1, 2, 3])

function evaluate(ctx: DecisionContext, skipLineage: boolean): MatchedRule[] {
  const matches: MatchedRule[] = []
  for (const row of DECISION_RULES) {
    if (skipLineage && LINEAGE_RULES.has(row.rule)) continue
    const result = row.test(ctx)
    if (!matched(result)) continue
    matches.push({ rule: row.rule, code: row.code, verdict: row.verdict, evidence: evidenceOf(result) })
  }
  return matches
}

/**
 * Stage 6. Pure: the same context always decides the same way.
 *
 * A credit note short-circuits to ROUTED_NOT_PAID before rule 1 — a negative
 * document is never queued for payment, so none of the payment rules apply to it.
 */
export function decide(ctx: DecisionContext): DecisionResult {
  const evidence: Record<string, Evidence> = {}

  if (!ctx.checks.credit_note.passed) {
    evidence.CREDIT_NOTE = ctx.checks.credit_note.evidence ?? {}
    return {
      verdict: 'ROUTED_NOT_PAID',
      reason_codes: ['CREDIT_NOTE'],
      primary: 'CREDIT_NOTE',
      matched_rule: 0,
      matches: [{ rule: 0, code: 'CREDIT_NOTE', verdict: 'ROUTED_NOT_PAID', evidence: evidence.CREDIT_NOTE }],
      evidence,
      reevaluated: false,
    }
  }

  let matches = evaluate(ctx, false)

  /**
   * An exact duplicate is terminal.
   *
   * The same file, byte for byte, as one already processed. Nothing else about it
   * is worth saying and nothing else about it is true: in particular it is not a
   * resubmission, because a resubmission is a corrected version and an identical
   * file has corrected nothing. Emitting both produced a decision that told the
   * reader we had already processed this document and that it was a corrected
   * version of one we held, in the same breath.
   */
  const duplicate = matches.find((match) => match.code === 'EXACT_DUPLICATE')
  if (duplicate) {
    evidence.EXACT_DUPLICATE = duplicate.evidence
    return {
      verdict: duplicate.verdict ?? 'BLOCK',
      reason_codes: ['EXACT_DUPLICATE'],
      primary: 'EXACT_DUPLICATE',
      matched_rule: duplicate.rule,
      matches: [duplicate],
      evidence,
      reevaluated: false,
    }
  }

  let reevaluated = false
  const carried: ReasonCode[] = []

  // Rule 3: only flagged fields changed. Clear the parent's flag and re-run the
  // remaining rules from the top; the verdict is whatever they now produce.
  if (matches.length > 0 && matches[0].rule === 3) {
    carried.push('RESUBMISSION')
    evidence.RESUBMISSION = matches[0].evidence
    matches = evaluate(ctx, true)
    reevaluated = true
  }

  const advisory: ReasonCode[] = []
  if (ctx.vendorMatch.status === 'low_confidence') {
    advisory.push('LOW_CONFIDENCE_VENDOR_MATCH')
    evidence.LOW_CONFIDENCE_VENDOR_MATCH = {
      matched_vendor: ctx.vendorMatch.vendor?.id ?? null,
      matched_on: ctx.vendorMatch.matched_on,
      matched_value: ctx.vendorMatch.matched_value,
      score: roundTo(ctx.vendorMatch.score, 4),
      threshold: ctx.rules.vendor_match_threshold,
      floor: ctx.rules.vendor_match_floor,
    }
  }

  for (const match of matches) evidence[match.code] = match.evidence

  if (matches.length === 0) {
    return {
      verdict: 'AUTO_APPROVE',
      reason_codes: ['CLEAN_MATCH', ...carried, ...advisory],
      primary: 'CLEAN_MATCH',
      matched_rule: 23,
      matches: [{ rule: 23, code: 'CLEAN_MATCH', verdict: 'AUTO_APPROVE', evidence: {} }],
      evidence,
      reevaluated,
    }
  }

  const decisive = matches[0]
  return {
    verdict: decisive.verdict ?? 'REVIEW',
    reason_codes: [decisive.code, ...carried, ...matches.slice(1).map((match) => match.code), ...advisory],
    primary: decisive.code,
    matched_rule: decisive.rule,
    matches,
    evidence,
    reevaluated,
  }
}

// Convenience for the stage logger: which checks stood down rather than passing.
export function skippedChecks(checks: ValidationReport): string[] {
  return Object.entries(checks)
    .filter(([, value]) => value !== null && typeof value === 'object' && 'passed' in value && isSkipped(value as CheckResult))
    .map(([name]) => name)
}

// ---------------------------------------------------------------------------
// Stages 3-6 as one pure call
// ---------------------------------------------------------------------------

export interface EngineInput {
  facts: InvoiceFacts
  vendors: readonly VendorRecord[]
  // Every purchase order in scope; matching is narrowed to the resolved vendor's.
  purchaseOrders: readonly PurchaseOrderRecord[]
  rules: RuleSet
  asOf: Date
  submissionId?: string | null
  submissions?: readonly SubmissionRecord[]
  priorHashes?: readonly PriorRunHash[]
  parentRun?: PriorRun | null
  // What every decided document bills and whether it is approved, so the matched
  // order is measured on what it has left rather than on its opening balance.
  // The document being decided is left out of its own ledger by `submissionId`.
  billed?: readonly BilledDocument[]
}

export interface EngineResult {
  vendorMatch: VendorMatch
  poMatch: PoMatchResult
  checks: ValidationReport
  decision: DecisionResult
}

/**
 * Stages 3 through 6, end to end and side-effect free. `pipeline.ts` runs the same
 * four functions individually so it can log and time each stage; this is the form
 * the tests and any other caller use.
 */
export function decideInvoice(input: EngineInput): EngineResult {
  const vendorMatch = resolveVendor(input.facts.vendor_name, input.vendors, input.rules)

  const vendorPos = vendorMatch.vendor
    ? input.purchaseOrders.filter((po) => po.vendor_id === vendorMatch.vendor?.id)
    : []
  const poMatch = billMatchedOrder(
    matchPurchaseOrder(input.facts, vendorPos, input.rules),
    input.billed ?? [],
    input.submissionId ?? null,
  )

  const checks = runValidations({
    facts: input.facts,
    vendorMatch,
    poMatch,
    rules: input.rules,
    asOf: input.asOf,
    submissionId: input.submissionId ?? null,
    submissions: input.submissions ?? [],
    priorHashes: input.priorHashes ?? [],
    parentRun: input.parentRun ?? null,
  })

  const decision = decide({ facts: input.facts, vendorMatch, poMatch, checks, rules: input.rules })

  return { vendorMatch, poMatch, checks, decision }
}
