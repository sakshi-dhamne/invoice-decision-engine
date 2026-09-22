import { describe, expect, it } from 'vitest'

import { decideInvoice } from '../src/rules/decide.ts'
import {
  checkArithmetic,
  checkBankAccount,
  checkCreditNote,
  checkCumulativeOverage,
  checkInvoiceDate,
  checkLineCoverage,
  checkNearDuplicate,
  checkQuantities,
  checkRemitToEntity,
  checkRequiredFields,
  checkTaxTreatment,
  checkThresholdSplit,
  checkUnitPrices,
  citesDeliveryMilestone,
  classifyResubmission,
  diffFacts,
  reconcileLines,
} from '../src/rules/validate.ts'
import {
  coefficientOfVariation,
  companyNameSimilarity,
  diceCoefficient,
  grossFactor,
  normalizeAccountNumber,
  normalizeCompanyName,
  roundTo,
  sum,
  toleranceFor,
} from '../src/rules/normalize.ts'
import { matchPurchaseOrder, remainingBalance } from '../src/rules/poMatch.ts'
import { resolveVendor } from '../src/rules/vendor.ts'
import { toRuleSet } from '../src/rules/types.ts'
import type { InvoiceFacts, PriorRun, ReasonCode } from '../src/rules/types.ts'
import { fallbackExplanation } from '../src/rules/explain.ts'

import { corpus, findDocument, ledger, purchaseOrders, rules } from './fixtures.ts'
import { AS_OF, outcomeFor, runCorpus } from './harness.ts'
import {
  SYNTHETIC_POS,
  SYNTHETIC_VENDOR,
  SYNTHETIC_VENDORS,
  syntheticInvoice,
  syntheticPo,
  syntheticSubmission,
} from './synthetic.ts'

const results = runCorpus()

function decideSynthetic(
  facts: InvoiceFacts,
  overrides: Partial<Parameters<typeof decideInvoice>[0]> = {},
) {
  return decideInvoice({
    facts,
    vendors: SYNTHETIC_VENDORS,
    purchaseOrders: SYNTHETIC_POS,
    rules,
    asOf: AS_OF,
    submissionId: 'synthetic-subject',
    submissions: [],
    priorHashes: [],
    parentRun: null,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('the 27-invoice corpus', () => {
  it('has 27 documents', () => {
    expect(corpus).toHaveLength(27)
  })

  it.each(corpus.map((document) => [document.id, document.expected_verdict] as const))(
    '%s produces %s',
    (id, expected) => {
      expect(outcomeFor(results, id).decision.verdict).toBe(expected)
    },
  )

  it('every document reaches a verdict and carries at least one reason code', () => {
    for (const [id, outcome] of results) {
      expect(outcome.decision.reason_codes.length, id).toBeGreaterThan(0)
      expect(outcome.decision.primary, id).toBe(outcome.decision.reason_codes[0])
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture coherence
// ---------------------------------------------------------------------------

// A purchase order's `total_amount` is the sum AP is authorised to pay out, so its
// line amounts are on that same gross basis. `tax_treatment` has to agree with the
// figures the order actually states, or the corpus asserts one thing and means
// another — and a reader debugging a variance is sent after a tax gap that is not
// there.
describe('purchase-order fixtures state a coherent tax basis', () => {
  it('every order states line amounts that sum to its authorised total', () => {
    for (const po of purchaseOrders) {
      const lineTotal = roundTo(sum(po.line_items.map((line) => line.amount ?? 0)), 2)
      expect(lineTotal, po.po_number).toBe(po.total_amount)
    }
  })

  it('an order priced exclusive of tax is only billed by invoices that carry none', () => {
    const treatmentOf = new Map(purchaseOrders.map((po) => [po.po_number, po.tax_treatment]))
    for (const document of corpus) {
      const reference = document.facts.po_reference
      if (reference == null || treatmentOf.get(reference) !== 'exclusive') continue
      expect(document.facts.tax ?? 0, document.id).toBe(0)
    }
  })

  it('keeps both treatments represented, so neither branch of the check is dead', () => {
    expect(new Set(purchaseOrders.map((po) => po.tax_treatment))).toEqual(new Set(['inclusive', 'exclusive']))
  })
})

// ---------------------------------------------------------------------------
// The two hard checks
// ---------------------------------------------------------------------------

describe('threshold-split detection', () => {
  const splitSet = ['INV-BIT-441', 'INV-BIT-442', 'INV-BIT-443', 'INV-BIT-444', 'INV-BIT-445']
  const milestoneSet = ['INV-NCS-2201', 'INV-NCS-2218', 'INV-NCS-2237']

  it.each(splitSet)('fires on %s — identical amounts, 8 days, no milestones', (invoice) => {
    const outcome = outcomeFor(results, `${invoice}.pdf`)
    expect(outcome.decision.reason_codes).toContain('THRESHOLD_SPLIT_SUSPECTED')
    expect(outcome.decision.verdict).toBe('REVIEW')
  })

  it.each(milestoneSet)('does not fire on %s — genuine phased billing', (invoice) => {
    const outcome = outcomeFor(results, `${invoice}.pdf`)
    expect(outcome.decision.reason_codes).not.toContain('THRESHOLD_SPLIT_SUSPECTED')
    expect(outcome.decision.verdict).toBe('AUTO_APPROVE')
  })

  it('the milestone set fails three of the six conditions independently', () => {
    const milestonePo = purchaseOrders.find((po) => (po.delivery_schedule?.length ?? 0) > 0)
    expect(milestonePo).toBeDefined()
    const result = checkThresholdSplit(milestonePo!, ledger, rules)
    const conditions = result.evidence?.conditions as Record<string, boolean>

    expect(result.passed).toBe(true)
    expect(conditions.within_date_window).toBe(false)
    expect(conditions.amounts_near_uniform).toBe(false)
    expect(conditions.no_milestone_reference).toBe(false)
  })

  it('requires all six conditions — removing the uniformity of the amounts stops it firing', () => {
    const po = syntheticPo({ total_amount: 900000 })
    const uniform = [1, 2, 3].map((index) =>
      syntheticSubmission({
        id: `split-${index}`,
        invoice_number: `WPM/2026/01${index}`,
        invoice_date: `2026-09-0${index}`,
        total: 150000,
      }),
    )
    expect(checkThresholdSplit(po, uniform, rules).passed).toBe(false)

    const varied = uniform.map((submission, index) => ({ ...submission, total: 60000 + index * 90000 }))
    expect(checkThresholdSplit(po, varied, rules).passed).toBe(true)
  })

  it('recognises a milestone citation from the notes, by label or by description', () => {
    const po = syntheticPo({
      delivery_schedule: [
        { milestone: 'P2', description: 'Second reel delivery', amount: 70800, due_date: '2026-09-20' },
      ],
    })
    expect(citesDeliveryMilestone('Billing against P2 as scheduled', po, rules)).toBe(true)
    expect(citesDeliveryMilestone('Against the second reel delivery', po, rules)).toBe(true)
    expect(citesDeliveryMilestone('Please settle within 30 days', po, rules)).toBe(false)
  })
})

describe('resubmission lineage', () => {
  it('a resubmission that only supplies the missing PO reference is re-run and clears', () => {
    const original = outcomeFor(results, 'INV-SOS-7714.pdf')
    const resubmit = outcomeFor(results, 'INV-SOS-7714-resubmit.pdf')

    expect(original.decision.verdict).toBe('HOLD')
    expect(original.decision.reason_codes).toContain('NO_PO_MATCH')
    expect(resubmit.decision.reason_codes).toContain('RESUBMISSION')
    expect(resubmit.decision.reevaluated).toBe(true)
    expect(resubmit.decision.verdict).toBe('AUTO_APPROVE')
  })

  it('a resubmission that also raises the total is an undeclared amendment', () => {
    const resubmit = outcomeFor(results, 'INV-VLI-3302-resubmit.pdf')
    expect(resubmit.decision.verdict).toBe('BLOCK')
    expect(resubmit.decision.primary).toBe('UNDECLARED_AMENDMENT')

    const assessment = resubmit.checks.resubmission!
    expect(assessment.classification).toBe('undeclared_amendment')
    expect(assessment.undeclared_changes).toContain('total')
    // Every field is diffed, not just the flagged one.
    expect(assessment.changed_fields.map((change) => change.field)).toEqual(
      expect.arrayContaining(['po_reference', 'total', 'line_items']),
    )
  })

  it('nothing changed and no prior exception is an exact duplicate', () => {
    const facts = syntheticInvoice()
    const parent: PriorRun = {
      run_id: 'run-1',
      invoice_number: facts.invoice_number!,
      vendor_id: SYNTHETIC_VENDOR.id,
      verdict: 'AUTO_APPROVE',
      reason_codes: ['CLEAN_MATCH'],
      facts,
      started_at: '2026-09-05',
    }
    expect(classifyResubmission(facts, parent).classification).toBe('exact_duplicate')

    const decision = decideSynthetic(facts, { parentRun: parent }).decision
    expect(decision.verdict).toBe('BLOCK')
    expect(decision.primary).toBe('EXACT_DUPLICATE')
  })

  it('rule 1 is terminal, and never calls a duplicate a resubmission too', () => {
    // The live case: an uploaded copy of a document already processed. Its hash
    // matches, and because it carries the same invoice number as the original the
    // lineage check also reads it as a resubmission. Saying both would tell the
    // reader we have already processed this exact document and that it is a
    // corrected version of one we held, at the same time. An identical file has
    // corrected nothing.
    const facts = syntheticInvoice()
    const parent: PriorRun = {
      run_id: 'run-parent',
      invoice_number: facts.invoice_number ?? '',
      vendor_id: SYNTHETIC_VENDOR.id,
      verdict: 'HOLD',
      reason_codes: ['BANK_DETAIL_MISMATCH'],
      facts,
      started_at: '2026-09-01',
    }

    const decision = decideSynthetic(facts, {
      priorHashes: [{ run_id: 'run-9', invoice_number: 'WPM/2026/0009', file_hash: facts.file_hash! }],
      parentRun: parent,
    }).decision

    expect(decision.verdict).toBe('BLOCK')
    expect(decision.primary).toBe('EXACT_DUPLICATE')
    expect(decision.reason_codes).toEqual(['EXACT_DUPLICATE'])
    expect(decision.reason_codes).not.toContain('RESUBMISSION')
  })

  it('a fresh date and reworded notes alone do not make a resubmission an amendment', () => {
    const parentFacts = syntheticInvoice({ po_reference: null })
    const parent: PriorRun = {
      run_id: 'run-2',
      invoice_number: parentFacts.invoice_number!,
      vendor_id: SYNTHETIC_VENDOR.id,
      verdict: 'HOLD',
      reason_codes: ['NO_PO_MATCH'],
      facts: parentFacts,
      started_at: '2026-09-02',
    }
    const child = syntheticInvoice({ invoice_date: '2026-09-09', notes: 'Reissued with the order reference.' })

    const assessment = classifyResubmission(child, parent)
    expect(assessment.classification).toBe('resubmission')
    expect(assessment.changed_fields.map((change) => change.field)).toEqual(
      expect.arrayContaining(['invoice_date', 'notes', 'po_reference']),
    )
    expect(assessment.undeclared_changes).toEqual([])
  })

  it('diffs every extracted field, not only the flagged one', () => {
    const before = syntheticInvoice()
    const after = syntheticInvoice({ total: 150000, notes: 'revised', bank_account: '999' })
    expect(diffFacts(before, after).map((change) => change.field).sort()).toEqual([
      'bank_account',
      'notes',
      'total',
    ])
  })
})

// ---------------------------------------------------------------------------
// Named cases from the brief
// ---------------------------------------------------------------------------

describe('named cases', () => {
  it('INV-ACM-5533 auto-approves despite the remit-to name variant', () => {
    const outcome = outcomeFor(results, 'INV-ACM-5533.pdf')
    expect(outcome.decision.verdict).toBe('AUTO_APPROVE')
    expect(outcome.vendorMatch.score).toBeGreaterThanOrEqual(rules.vendor_match_threshold)
    expect(outcome.checks.remit_to.passed).toBe(true)
  })

  it('INV-QCL-1130 holds on ARITHMETIC_INCONSISTENT', () => {
    const outcome = outcomeFor(results, 'INV-QCL-1130.pdf')
    expect(outcome.decision.verdict).toBe('HOLD')
    expect(outcome.decision.primary).toBe('ARITHMETIC_INCONSISTENT')
  })

  it('INV-HSL-8890 blocks on the offshore remit-to entity, not on the bank account', () => {
    const outcome = outcomeFor(results, 'INV-HSL-8890.pdf')
    expect(outcome.decision.primary).toBe('PAYEE_ENTITY_MISMATCH')
    expect(outcome.checks.bank_account.passed).toBe(true)
  })

  it('INV-VLI-3315 is ambiguous between two freight orders rather than guessing', () => {
    const outcome = outcomeFor(results, 'INV-VLI-3315.pdf')
    expect(outcome.poMatch.outcome).toBe('ambiguous')
    expect(outcome.poMatch.candidates.length).toBeGreaterThanOrEqual(2)
    expect(outcome.poMatch.matched).toBeNull()
    expect(outcome.decision.primary).toBe('AMBIGUOUS_PO_MATCH')
  })

  it('vendor normalisation resolves Pvt. Ltd. against Private Limited', () => {
    expect(normalizeCompanyName('Fairlight Rubber Pvt. Ltd.')).toBe(
      normalizeCompanyName('Fairlight Rubber Private Limited'),
    )
    expect(companyNameSimilarity('Fairlight Rubber Pvt. Ltd.', 'Fairlight Rubber Private Limited')).toBe(1)
  })

  it('an alias, not just the legal name, can carry the vendor match', () => {
    const aliased = resolveVendor('Westmark Paper', SYNTHETIC_VENDORS, rules)
    expect(aliased.vendor?.id).toBe(SYNTHETIC_VENDOR.id)
    expect(aliased.matched_on).toBe('alias')
  })
})

// ---------------------------------------------------------------------------
// Every rule from 1 to 23
// ---------------------------------------------------------------------------

// Whether a rule was reached decisively somewhere in the corpus.
function corpusPrimaries(): Set<ReasonCode> {
  return new Set([...results.values()].map((outcome) => outcome.decision.primary))
}

describe('decision table coverage', () => {
  it('rule 1 — a file hash already seen on a prior run blocks', () => {
    const facts = syntheticInvoice()
    const decision = decideSynthetic(facts, {
      priorHashes: [{ run_id: 'run-9', invoice_number: 'WPM/2026/0009', file_hash: facts.file_hash! }],
    }).decision
    expect(decision.verdict).toBe('BLOCK')
    expect(decision.primary).toBe('EXACT_DUPLICATE')
  })

  it('rules 2, 3 — both resubmission branches are reached by the corpus', () => {
    expect(corpusPrimaries()).toContain('UNDECLARED_AMENDMENT')
    expect(outcomeFor(results, 'INV-SOS-7714-resubmit.pdf').decision.reason_codes).toContain('RESUBMISSION')
  })

  it.each([
    ['rule 4 BANK_DETAIL_MISMATCH', 'BANK_DETAIL_MISMATCH'],
    ['rule 5 PAYEE_ENTITY_MISMATCH', 'PAYEE_ENTITY_MISMATCH'],
    ['rule 6 VENDOR_INACTIVE', 'VENDOR_INACTIVE'],
    ['rule 7 UNKNOWN_VENDOR', 'UNKNOWN_VENDOR'],
    ['rule 12 ARITHMETIC_INCONSISTENT', 'ARITHMETIC_INCONSISTENT'],
    ['rule 14 NO_PO_MATCH', 'NO_PO_MATCH'],
    ['rule 15 AMBIGUOUS_PO_MATCH', 'AMBIGUOUS_PO_MATCH'],
    ['rule 16 QUANTITY_MISMATCH', 'QUANTITY_MISMATCH'],
    ['rule 19 THRESHOLD_SPLIT_SUSPECTED', 'THRESHOLD_SPLIT_SUSPECTED'],
    ['rule 22 ABOVE_AUTO_APPROVE_LIMIT', 'ABOVE_AUTO_APPROVE_LIMIT'],
    ['rule 23 CLEAN_MATCH', 'CLEAN_MATCH'],
  ])('%s is reached decisively by the corpus', (_label, code) => {
    expect(corpusPrimaries()).toContain(code as ReasonCode)
  })

  it('rule 8 — a closed purchase order holds', () => {
    const decision = decideSynthetic(syntheticInvoice(), {
      purchaseOrders: [syntheticPo({ status: 'closed' })],
    }).decision
    expect(decision.verdict).toBe('HOLD')
    expect(decision.primary).toBe('PO_NOT_OPEN')
  })

  it('rule 9 — a currency the order was not raised in holds', () => {
    const decision = decideSynthetic(syntheticInvoice({ currency: 'USD' })).decision
    expect(decision.verdict).toBe('HOLD')
    expect(decision.primary).toBe('CURRENCY_MISMATCH')
  })

  it('rule 10 — a future date and a stale date both hold', () => {
    const future = decideSynthetic(syntheticInvoice({ invoice_date: '2027-01-04' })).decision
    expect(future.primary).toBe('DATE_OUT_OF_RANGE')
    expect(future.verdict).toBe('HOLD')

    const stale = decideSynthetic(syntheticInvoice({ invoice_date: '2025-09-05' })).decision
    expect(stale.primary).toBe('DATE_OUT_OF_RANGE')
  })

  it('rule 11 — a null in a required field holds', () => {
    const decision = decideSynthetic(syntheticInvoice({ total: null })).decision
    expect(decision.verdict).toBe('HOLD')
    expect(decision.primary).toBe('INCOMPLETE_EXTRACTION')
  })

  it('rule 13 — an order that states no tax treatment holds', () => {
    const decision = decideSynthetic(syntheticInvoice(), {
      purchaseOrders: [syntheticPo({ tax_treatment: null })],
    }).decision
    expect(decision.verdict).toBe('HOLD')
    expect(decision.primary).toBe('TAX_TREATMENT_UNCLEAR')
  })

  it('rule 17 — an inflated unit price reviews', () => {
    const decision = decideSynthetic(
      syntheticInvoice({
        line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 6600, amount: 132000 }],
        subtotal: 132000,
        tax: 23760,
        total: 155760,
      }),
    ).decision
    expect(decision.verdict).toBe('REVIEW')
    expect(decision.primary).toBe('PRICE_VARIANCE')
  })

  it('rule 17 stands down when the line was read from a tax-inclusive column', () => {
    // Same document as the clean case, but the line amount transcribed from a
    // layout's tax-inclusive column rather than its taxable-value column. It is
    // already on the order's basis, so there is no variance to report.
    const decision = decideSynthetic(
      syntheticInvoice({
        line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 7080, amount: 141600 }],
      }),
    ).decision
    expect(decision.verdict).toBe('AUTO_APPROVE')
    expect(decision.primary).toBe('CLEAN_MATCH')
  })

  it('rule 18 — a line the order does not account for reviews', () => {
    const decision = decideSynthetic(
      syntheticInvoice({
        line_items: [
          { description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 6000, amount: 120000 },
          { description: 'Palletisation And Shrink Wrap', quantity: 1, unit_price: 9000, amount: 9000 },
        ],
        subtotal: 129000,
        tax: 23220,
        total: 152220,
      }),
    ).decision
    expect(decision.verdict).toBe('REVIEW')
    expect(decision.primary).toBe('UNMATCHED_LINE_ITEM')
  })

  it('rule 20 — a near-duplicate of a recent invoice reviews', () => {
    const decision = decideSynthetic(syntheticInvoice(), {
      submissions: [syntheticSubmission()],
    }).decision
    expect(decision.verdict).toBe('REVIEW')
    expect(decision.primary).toBe('NEAR_DUPLICATE')
  })

  it('rule 21 — billing past the order ceiling reviews', () => {
    const decision = decideSynthetic(syntheticInvoice(), {
      purchaseOrders: [syntheticPo({ amount_billed_to_date: 100000 })],
    }).decision
    expect(decision.verdict).toBe('REVIEW')
    expect(decision.primary).toBe('PO_OVERAGE')
  })

  it('the credit-note short circuit precedes rule 1', () => {
    const decision = decideSynthetic(
      syntheticInvoice({ document_type: 'credit_note', total: -141600 }),
      { priorHashes: [{ run_id: 'r', invoice_number: 'x', file_hash: 'sha256:westmark-0042' }] },
    ).decision
    expect(decision.verdict).toBe('ROUTED_NOT_PAID')
    expect(decision.reason_codes).toEqual(['CREDIT_NOTE'])
  })

  it('a weak but resolvable vendor match rides through as an advisory flag', () => {
    const outcome = decideSynthetic(syntheticInvoice({ vendor_name: 'Westmark Mills' }))
    expect(outcome.vendorMatch.status).toBe('low_confidence')
    expect(outcome.decision.reason_codes).toContain('LOW_CONFIDENCE_VENDOR_MATCH')
  })

  it('collects every matching code, not only the decisive one', () => {
    const outcome = outcomeFor(results, 'INV-MFM-5001.pdf')
    expect(outcome.decision.primary).toBe('VENDOR_INACTIVE')
    expect(outcome.decision.reason_codes).toEqual(
      expect.arrayContaining(['VENDOR_INACTIVE', 'PO_NOT_OPEN', 'PO_OVERAGE']),
    )
  })
})

// ---------------------------------------------------------------------------
// Individual pure functions
// ---------------------------------------------------------------------------

describe('normalize', () => {
  it('strips punctuation, collapses whitespace and expands suffixes', () => {
    expect(normalizeCompanyName('  Harrow  &  Vale   Pvt. Ltd. ')).toBe('harrow and vale private limited')
  })

  it('scores an abbreviation against its expansion well above an unrelated name', () => {
    const abbreviated = companyNameSimilarity('Marlowe Tech Pvt Ltd', 'Marlowe Technologies Private Limited')
    const unrelated = companyNameSimilarity('Marlowe Tech Pvt Ltd', 'Greenfield Foods Private Limited')
    expect(abbreviated).toBeGreaterThan(0.85)
    expect(unrelated).toBeLessThan(0.6)
  })

  it('does not let a shared legal-form suffix carry a match on its own', () => {
    expect(companyNameSimilarity('Alpha Widgets Private Limited', 'Beta Castings Private Limited')).toBeLessThan(0.6)
  })

  it('dice coefficient is symmetric and bounded', () => {
    expect(diceCoefficient('night', 'nacht')).toBeCloseTo(diceCoefficient('nacht', 'night'), 10)
    expect(diceCoefficient('same', 'same')).toBe(1)
    expect(diceCoefficient('abc', 'xyz')).toBe(0)
  })

  it('strips spacing from bank accounts but nothing else', () => {
    expect(normalizeAccountNumber(' 5010 0234 567891 ')).toBe('50100234567891')
    expect(normalizeAccountNumber('50100234567891')).not.toBe(normalizeAccountNumber('50100234567892'))
  })

  it('derives the gross factor from the invoice rather than assuming a rate', () => {
    expect(grossFactor(118000, 100000, [100000])).toBeCloseTo(1.18, 10)
    // No subtotal printed — falls back to the line amounts.
    expect(grossFactor(226000, null, [191525])).toBeCloseTo(226000 / 191525, 10)
    expect(grossFactor(null, null, [])).toBe(1)
  })

  it('scales lines from the figure they were printed against, not always the subtotal', () => {
    // A layout that carries a per-line tax column prints the tax-inclusive figure
    // beside the taxable one. Lines taken from that column already sum to the
    // total, and scaling them by total / subtotal would charge the tax twice.
    expect(grossFactor(64800, 54915, [64800])).toBe(1)
    // Lines that fall short of the subtotal because one of them was never read
    // stay on the subtotal's basis, so the shortfall is left for the coverage
    // check to report rather than being scaled away.
    expect(grossFactor(118000, 100000, [60000])).toBeCloseTo(1.18, 10)
    // A tie goes to the subtotal.
    expect(grossFactor(200000, 100000, [150000])).toBeCloseTo(2, 10)
  })

  it('tolerance takes the greater of the percentage and the floor', () => {
    expect(toleranceFor(10000, 0.02, 1000)).toBe(1000)
    expect(toleranceFor(1000000, 0.02, 1000)).toBe(20000)
  })

  it('coefficient of variation is zero for identical amounts', () => {
    expect(coefficientOfVariation([195000, 195000, 195000])).toBe(0)
    expect(coefficientOfVariation([142300, 188900, 148800])).toBeGreaterThan(0.05)
  })
})

describe('stage 3 — vendor resolution', () => {
  it('applies the two thresholds from the rules table', () => {
    expect(resolveVendor('Westmark Paper Mills LLP', SYNTHETIC_VENDORS, rules).status).toBe('matched')
    expect(resolveVendor('Westmark Mills', SYNTHETIC_VENDORS, rules).status).toBe('low_confidence')
    expect(resolveVendor('Ironbridge Castings Pvt Ltd', SYNTHETIC_VENDORS, rules).status).toBe('unresolved')
  })

  it('a vendor absent from the master is unresolved rather than mismatched', () => {
    const outcome = outcomeFor(results, 'INV-ZTR-0001.pdf')
    expect(outcome.vendorMatch.vendor).toBeNull()
    expect(outcome.vendorMatch.score).toBeLessThan(rules.vendor_match_floor)
  })
})

describe('stage 4 — PO matching', () => {
  it('an explicit reference short-circuits at score 1.0', () => {
    const result = matchPurchaseOrder(syntheticInvoice(), SYNTHETIC_POS, rules)
    expect(result.outcome).toBe('explicit')
    expect(result.method).toBe('explicit')
    expect(result.score).toBe(1)
    expect(result.breakdown).toEqual([])
  })

  it('reads the reference out of a notes block when it is not its own field', () => {
    const result = matchPurchaseOrder(
      syntheticInvoice({ po_reference: null, notes: 'Against order REQ-88120, net 30.' }),
      SYNTHETIC_POS,
      rules,
    )
    expect(result.outcome).toBe('explicit')
    expect(result.matched?.po_number).toBe('REQ-88120')
  })

  it('an explicit reference matches a closed order too — the status check reports that separately', () => {
    const result = matchPurchaseOrder(syntheticInvoice(), [syntheticPo({ status: 'closed' })], rules)
    expect(result.outcome).toBe('explicit')
  })

  it('returns both candidates rather than picking the higher of two close scores', () => {
    const invoice = findDocument('INV-VLI-3315.pdf')
    const vendorId = invoice.resolved_vendor_id
    const vendorPos = purchaseOrders.filter((po) => po.vendor_id === vendorId)
    const result = matchPurchaseOrder(invoice.facts, vendorPos, rules)

    expect(result.outcome).toBe('ambiguous')
    expect(result.matched).toBeNull()
    const [best, second] = result.breakdown
    expect(best.total - second.total).toBeLessThan(rules.po_ambiguity_margin)
  })

  it('an inferred match is a suggestion, never an authoritative match', () => {
    const result = matchPurchaseOrder(syntheticInvoice({ po_reference: null }), SYNTHETIC_POS, rules)
    expect(result.outcome).toBe('inferred')
    expect(result.matched).toBeNull()
    expect(result.candidates.map((po) => po.po_number)).toEqual(['REQ-88120'])
  })

  it('discards candidates below the credibility floor', () => {
    const result = matchPurchaseOrder(
      syntheticInvoice({ po_reference: null, total: 4_000_000, line_items: [] }),
      SYNTHETIC_POS,
      rules,
    )
    expect(result.outcome).toBe('none')
  })

  it('remaining balance nets off what has already been billed', () => {
    expect(remainingBalance(syntheticPo({ amount_billed_to_date: 41600 }))).toBe(100000)
  })
})

describe('stage 5 — individual checks', () => {
  const facts = syntheticInvoice()

  it('bank account compares exactly after stripping spaces', () => {
    expect(checkBankAccount(syntheticInvoice({ bank_account: '7788 9900 1122 334' }), SYNTHETIC_VENDOR).passed).toBe(
      true,
    )
    const mismatch = checkBankAccount(syntheticInvoice({ bank_account: '778899001122335' }), SYNTHETIC_VENDOR)
    expect(mismatch.passed).toBe(false)
    expect(mismatch.evidence).toMatchObject({
      invoice_bank: '778899001122335',
      master_bank: '778899001122334',
    })
  })

  it('remit-to is fuzzy, not exact', () => {
    expect(checkRemitToEntity(syntheticInvoice({ remit_to_name: 'Westmark Paper Mills L.L.P.' }), SYNTHETIC_VENDOR, rules).passed).toBe(true)
    expect(checkRemitToEntity(syntheticInvoice({ remit_to_name: 'Northgate Holdings FZE' }), SYNTHETIC_VENDOR, rules).passed).toBe(false)
  })

  it('a missing vendor or remit-to name skips rather than passes', () => {
    expect(checkBankAccount(facts, null).evidence).toMatchObject({ skipped: 'vendor unresolved' })
    expect(checkRemitToEntity(syntheticInvoice({ remit_to_name: null }), SYNTHETIC_VENDOR, rules).evidence).toHaveProperty('skipped')
  })

  it('a credit note is recognised by its type or by a negative total', () => {
    expect(checkCreditNote(syntheticInvoice({ document_type: 'credit_note' })).passed).toBe(false)
    expect(checkCreditNote(syntheticInvoice({ total: -100 })).passed).toBe(false)
    expect(checkCreditNote(facts).passed).toBe(true)
  })

  it('required fields names exactly what is missing', () => {
    const result = checkRequiredFields(syntheticInvoice({ invoice_date: null, total: null }))
    expect(result.passed).toBe(false)
    expect(result.evidence?.missing).toEqual(['invoice_date', 'total'])
  })

  it('arithmetic stands down for fields the document never printed', () => {
    const inconsistent = syntheticInvoice({ subtotal: 120000, tax: 21600, total: 150000 })
    expect(checkArithmetic(inconsistent, rules).passed).toBe(false)
    expect(
      checkArithmetic({ ...inconsistent, subtotal: null, tax: null, fields_not_printed: ['subtotal', 'tax'] }, rules)
        .evidence,
    ).toHaveProperty('skipped')
  })

  it('arithmetic allows the rounding tolerance and nothing more', () => {
    expect(checkArithmetic(syntheticInvoice({ total: 141601 }), rules).passed).toBe(true)
    expect(checkArithmetic(syntheticInvoice({ total: 141603 }), rules).passed).toBe(false)
  })

  it('tax treatment is unresolvable when a tax-exclusive order meets an invoice that states no tax', () => {
    const exclusivePo = syntheticPo({ tax_treatment: 'exclusive' })
    const result = checkTaxTreatment(syntheticInvoice({ tax: null, subtotal: null }), exclusivePo)
    expect(result.passed).toBe(false)
    expect(result.code).toBe('TAX_TREATMENT_UNCLEAR')

    const declared = checkTaxTreatment(
      syntheticInvoice({ tax: null, subtotal: null, fields_not_printed: ['subtotal', 'tax'] }),
      exclusivePo,
    )
    expect(declared.passed).toBe(true)
  })

  it('tax treatment is unresolvable when a tax-inclusive order meets a tax line with no subtotal', () => {
    const result = checkTaxTreatment(syntheticInvoice({ subtotal: null }), syntheticPo())
    expect(result.passed).toBe(false)
    expect(result.code).toBe('TAX_TREATMENT_UNCLEAR')
  })

  it('the invoice date check is relative to the supplied clock, not the system clock', () => {
    expect(checkInvoiceDate(facts, rules, new Date('2026-09-18T00:00:00Z')).passed).toBe(true)
    expect(checkInvoiceDate(facts, rules, new Date('2026-09-01T00:00:00Z')).passed).toBe(false)
  })

  it('a consolidated invoice line rolls up several order lines', () => {
    const po = syntheticPo({
      total_amount: 141600,
      line_items: [
        { description: 'Recycled Kraft Paper Reels', quantity: 10, unit_price: 7080, amount: 70800 },
        { description: 'Recycled Kraft Paper Sheets', quantity: 10, unit_price: 7080, amount: 70800 },
      ],
    })
    const rolledUp = syntheticInvoice({
      line_items: [{ description: 'Recycled Kraft Paper - Bulk Consignment', quantity: 1, unit_price: 120000, amount: 120000 }],
    })
    const reconciliation = reconcileLines(rolledUp, po, rules)
    expect(reconciliation.groups).toHaveLength(1)
    expect(reconciliation.groups[0].po_indexes).toHaveLength(2)
    expect(reconciliation.groups[0].expected_amount).toBe(141600)
    expect(checkUnitPrices(reconciliation, rules).passed).toBe(true)
  })

  it('coverage lets an unmapped line through when the order still has value to account for', () => {
    const po = syntheticPo({
      line_items: [
        { description: 'Bleached Board Stock', quantity: 10, unit_price: 7080, amount: 70800 },
        { description: 'Corrugated Liner Rolls', quantity: 10, unit_price: 7080, amount: 70800 },
      ],
    })
    const reconciliation = reconcileLines(syntheticInvoice(), po, rules)
    expect(reconciliation.groups).toHaveLength(0)
    expect(checkLineCoverage(reconciliation, po, rules).passed).toBe(true)
  })

  it('under-billing a line is partial delivery, not a price variance', () => {
    const reconciliation = reconcileLines(
      syntheticInvoice({
        line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 20, unit_price: 2000, amount: 40000 }],
        subtotal: 40000,
        tax: 7200,
        total: 47200,
      }),
      syntheticPo(),
      rules,
    )
    expect(checkUnitPrices(reconciliation, rules).passed).toBe(true)
  })

  it('quantity is checked against the order quantity less what was received', () => {
    const reconciliation = reconcileLines(
      syntheticInvoice({
        line_items: [{ description: 'Recycled Kraft Paper Reels', quantity: 25, unit_price: 6000, amount: 150000 }],
      }),
      syntheticPo(),
      rules,
    )
    const result = checkQuantities(reconciliation, syntheticPo())
    expect(result.passed).toBe(false)
    const overruns = result.evidence!.overruns as unknown[]
    expect(overruns[0]).toMatchObject({ invoice_quantity: 25, available: 20 })
  })

  it('near-duplicate looks backwards only', () => {
    const facts6 = syntheticInvoice({ invoice_date: '2026-09-05' })
    const earlier = syntheticSubmission({ invoice_date: '2026-09-02' })
    const later = syntheticSubmission({ invoice_date: '2026-09-09' })

    expect(checkNearDuplicate(facts6, SYNTHETIC_VENDOR.id, 'subject', [earlier], rules).passed).toBe(false)
    expect(checkNearDuplicate(facts6, SYNTHETIC_VENDOR.id, 'subject', [later], rules).passed).toBe(true)
  })

  it('near-duplicate ignores a prior submission carrying the same invoice number', () => {
    const resubmission = syntheticSubmission({ invoice_number: 'WPM/2026/0042' })
    expect(
      checkNearDuplicate(syntheticInvoice(), SYNTHETIC_VENDOR.id, 'subject', [resubmission], rules).passed,
    ).toBe(true)
  })

  it('cumulative overage allows the tolerance and then stops', () => {
    expect(checkCumulativeOverage(syntheticInvoice(), syntheticPo({ amount_billed_to_date: 1000 }), rules).passed).toBe(
      true,
    )
    expect(checkCumulativeOverage(syntheticInvoice(), syntheticPo({ amount_billed_to_date: 5000 }), rules).passed).toBe(
      false,
    )
  })
})

describe('thresholds come from the rules table', () => {
  it('raising the auto-approve limit changes a REVIEW into an AUTO_APPROVE', () => {
    const relaxed = toRuleSet({ ...rules, auto_approve_limit: 500000 })
    const rerun = runCorpus({ rules: relaxed })
    expect(outcomeFor(results, 'INV-ACM-5510.pdf').decision.verdict).toBe('REVIEW')
    expect(outcomeFor(rerun, 'INV-ACM-5510.pdf').decision.verdict).toBe('AUTO_APPROVE')
  })

  it('tightening the vendor match floor turns a resolved vendor into an unknown one', () => {
    const strict = toRuleSet({ ...rules, vendor_match_floor: 0.99, vendor_match_threshold: 0.995 })
    expect(resolveVendor('Westmark Paper Mills LLP', SYNTHETIC_VENDORS, strict).status).toBe('matched')
    expect(resolveVendor('Westmark Paper Mill LLP', SYNTHETIC_VENDORS, strict).status).toBe('unresolved')
  })

  it('a missing threshold fails loudly rather than defaulting', () => {
    const { auto_approve_limit: _omitted, ...incomplete } = rules
    expect(() => toRuleSet(incomplete)).toThrow(/auto_approve_limit/)
  })

  it('the seeded thresholds cover every key the engine reads', () => {
    expect(() => toRuleSet(rules)).not.toThrow()
  })
})

describe('stage 7 fallback', () => {
  it('produces a readable sentence with no model involved', () => {
    const outcome = outcomeFor(results, 'INV-ACM-5521.pdf')
    const text = fallbackExplanation({
      verdict: outcome.decision.verdict,
      reason_codes: outcome.decision.reason_codes,
      evidence: outcome.decision.evidence,
      summary: {
        invoice_number: outcome.document.facts.invoice_number,
        vendor_name: outcome.document.facts.vendor_name,
        total: outcome.document.facts.total,
        currency: outcome.document.facts.currency,
        matched_po: outcome.poMatch.matched?.po_number ?? null,
      },
    })
    expect(text).toContain('INV-ACM-5521')
    expect(text).toContain('will not be paid')
    expect(text).toContain('bank account')

    // Written to the reader, about the document. The system is never the subject,
    // and the sentence opens with what is wrong rather than with the verdict.
    expect(text.toLowerCase()).not.toContain('accounts payable')
    expect(text.split(/\s+/).length).toBeLessThan(60)
  })
})
