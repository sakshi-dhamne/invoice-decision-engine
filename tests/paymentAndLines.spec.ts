// Two readings that were wrong, and the checks that depend on them.
//
// The payment block names a bank and it names a payee, and those are different
// facts. An invoice whose block named a bank came back with the bank as its
// remit-to, which is the field the payee check compares against the vendor the
// order was raised with: the one place a bank's name must never appear.
//
// Line coverage was reading a normal invoice as an exception. An invoice is free
// to itemise in four lines what the order bundled into one, and nothing in the
// description matching can pair those up, because there is one order line and
// four invoice lines with different wording.

import { describe, expect, it } from 'vitest'

import {
  EXTRACTION_FIELDS,
  EXTRACTION_PROMPT,
  GEMINI_RESPONSE_SCHEMA,
  describeExtractionResultShapeError,
} from '../src/lib/extractionSchema.ts'
import { descriptionSimilarity } from '../src/rules/normalize.ts'
import { checkLineCoverage, reconcileLines } from '../src/rules/validate.ts'
import { readFields } from '../src/lib/decisionData.ts'
import { rules } from './fixtures.ts'
import { syntheticInvoice } from './synthetic.ts'
import type { DecisionData } from '../src/lib/decisionData.ts'
import type { InvoiceFacts, PurchaseOrderRecord } from '../src/rules/types.ts'

// ---------------------------------------------------------------------------
// The bank is not the payee
// ---------------------------------------------------------------------------

describe('the payment block names two different things', () => {
  it('carries a field for each', () => {
    expect(EXTRACTION_FIELDS).toContain('bank_name')
    expect(EXTRACTION_FIELDS).toContain('remit_to_name')
  })

  it('asks the model for both, and says which is which', () => {
    expect(GEMINI_RESPONSE_SCHEMA.properties.bank_name).toBeTruthy()
    expect(EXTRACTION_PROMPT).toContain('bank_name is the bank the account sits in')
    expect(EXTRACTION_PROMPT).toContain('Never put a bank in remit_to_name')
  })

  it('tells the model what to do when the block names a bank and nobody else', () => {
    // The case that produced the bug: a payment block with a bank on it and no
    // account holder. The answer is null, not the bank.
    expect(EXTRACTION_PROMPT).toContain('remit_to_name is null and goes in unreadable_fields')
  })

  it('accepts a bank name, and refuses a number where the name goes', () => {
    const base = {
      invoice_number: null,
      invoice_date: null,
      vendor_name: null,
      po_reference: null,
      currency: null,
      line_items: [],
      subtotal: null,
      tax: null,
      total: null,
      bank_account: null,
      bank_ifsc: null,
      remit_to_name: null,
      document_type: 'invoice',
      notes: null,
      confidence: {},
      unreadable_fields: [],
      extraction_notes: null,
    }
    expect(describeExtractionResultShapeError({ ...base, bank_name: 'A Bank' })).toBeNull()
    expect(describeExtractionResultShapeError({ ...base, bank_name: null })).toBeNull()
    expect(describeExtractionResultShapeError({ ...base, bank_name: 42 })).toMatch(/bank_name/)
  })

  it('reads an extraction stored before the field existed', () => {
    // Every cached extraction predates it. An absent field is an absent value,
    // not a malformed response.
    const withoutIt = {
      invoice_number: null,
      invoice_date: null,
      vendor_name: null,
      po_reference: null,
      currency: null,
      line_items: [],
      subtotal: null,
      tax: null,
      total: null,
      bank_account: null,
      bank_ifsc: null,
      remit_to_name: null,
      document_type: 'invoice',
      notes: null,
      confidence: {},
      unreadable_fields: [],
      extraction_notes: null,
    }
    expect(describeExtractionResultShapeError(withoutIt)).toBeNull()
  })

  it('shows the bank beside the account and the IFSC, and apart from the payee', () => {
    const data = {
      extraction: {
        bank_account: '500100200300400',
        bank_ifsc: 'PSIB0000123',
        bank_name: 'Punjab and Sind Bank',
        remit_to_name: 'Larksfield Engineering Pvt Ltd',
      },
      flaggedFields: new Set<string>(),
    } as unknown as DecisionData

    const shown = readFields(data, { money: () => '', date: () => '' })
    const labels = shown.map((field) => field.key)
    expect(labels).toContain('bank_name')
    expect(labels.indexOf('bank_name')).toBeGreaterThan(labels.indexOf('bank_account'))
    expect(labels.indexOf('bank_name')).toBeLessThan(labels.indexOf('remit_to_name'))

    const byKey = new Map(shown.map((field) => [field.key, field.value]))
    expect(byKey.get('bank_name')).toBe('Punjab and Sind Bank')
    expect(byKey.get('bank_ifsc')).toBe('PSIB0000123')
    // The two are never the same reading.
    expect(byKey.get('remit_to_name')).toBe('Larksfield Engineering Pvt Ltd')
  })
})

// ---------------------------------------------------------------------------
// Line coverage
// ---------------------------------------------------------------------------

const BUNDLE = 'Office Supplies - Bulk Order'

function orderOf(total: number, ...lines: [string, number][]): PurchaseOrderRecord {
  return {
    po_number: 'WX-7700',
    vendor_id: 'VX1',
    total_amount: total,
    currency: 'INR',
    amount_billed_to_date: 0,
    tax_treatment: 'inclusive',
    status: 'open',
    line_items: lines.map(([description, amount]) => ({
      description,
      quantity: 1,
      unit_price: amount,
      amount,
    })),
    delivery_schedule: null,
    issued_date: '2026-08-01',
  }
}

function invoiceOf(...lines: [string, number][]): InvoiceFacts {
  return syntheticInvoice({
    line_items: lines.map(([description, amount]) => ({
      description,
      quantity: 1,
      unit_price: amount,
      amount,
    })),
    subtotal: null,
    tax: null,
    total: lines.reduce((running, [, amount]) => running + amount, 0),
    fields_not_printed: ['subtotal', 'tax'],
  })
}

function coverage(invoice: InvoiceFacts, po: PurchaseOrderRecord) {
  return checkLineCoverage(reconcileLines(invoice, po, rules), po, rules)
}

describe('descriptions are compared on the words, not the typography', () => {
  it.each([
    ['case', 'Office Supplies - Bulk Order', 'office supplies bulk order'],
    ['spacing', 'Industrial  Tooling   Equipment', 'Industrial Tooling Equipment'],
    ['punctuation', 'Consulting Package A - Strategy & Advisory (Bundled)', 'Consulting Package A: Strategy and Advisory, bundled'],
  ])('ignores %s', (_what, a, b) => {
    expect(descriptionSimilarity(a, b)).toBe(1)
  })

  it('still tells two different things apart', () => {
    expect(descriptionSimilarity('A4 Paper Reams', BUNDLE)).toBeLessThan(rules.line_match_threshold)
  })

  it('maps a line whose wording differs only in case and punctuation', () => {
    const po = orderOf(100_000, [BUNDLE, 100_000])
    const invoice = invoiceOf(['OFFICE SUPPLIES, BULK ORDER.', 100_000])
    const reconciliation = reconcileLines(invoice, po, rules)
    expect(reconciliation.groups).toHaveLength(1)
    expect(reconciliation.unmapped_invoice).toEqual([])
  })
})

describe('an invoice that itemises what the order bundled', () => {
  const po = orderOf(100_000, [BUNDLE, 100_000])

  it('is not an exception when the lines add up to the order', () => {
    const invoice = invoiceOf(['A4 Paper Reams', 40_000], ['Toner Cartridges', 35_000], ['Desk Staplers', 25_000])
    const result = coverage(invoice, po)
    expect(result.passed).toBe(true)
    expect(result.evidence?.lines_sum_to_order_total).toBe(true)
  })

  it('maps none of them, which is why the old test could not see it', () => {
    const invoice = invoiceOf(['A4 Paper Reams', 40_000], ['Toner Cartridges', 35_000], ['Desk Staplers', 25_000])
    const reconciliation = reconcileLines(invoice, po, rules)
    expect(reconciliation.groups).toEqual([])
    expect(reconciliation.unmapped_invoice).toHaveLength(3)
  })

  it('allows the same tolerance every other amount comparison allows', () => {
    const invoice = invoiceOf(['A4 Paper Reams', 40_000], ['Toner Cartridges', 35_000], ['Desk Staplers', 26_500])
    expect(coverage(invoice, po).passed).toBe(true)
  })

  it('still stops an invoice billing beyond the order', () => {
    const invoice = invoiceOf(
      ['A4 Paper Reams', 40_000],
      ['Toner Cartridges', 35_000],
      ['Desk Staplers', 25_000],
      ['Delivery surcharge nobody ordered', 18_000],
    )
    const result = coverage(invoice, po)
    expect(result.passed).toBe(false)
    expect(result.code).toBe('UNMATCHED_LINE_ITEM')
  })

  it('still stops an added line when the total does not answer for it', () => {
    // One line maps, one is not on the order, and the invoice does not add up to
    // the order either. The line-by-line test is what answers here, and it does:
    // the unmapped line bills past the order value nothing else has claimed.
    const itemised = orderOf(100_000, ['Annual Subscription', 60_000], ['Support Retainer', 40_000])
    const invoice = invoiceOf(['Annual Subscription', 60_000], ['Consultancy nobody ordered', 55_000])
    const result = coverage(invoice, itemised)
    expect(result.passed).toBe(false)
    expect(result.code).toBe('UNMATCHED_LINE_ITEM')
    expect(result.evidence?.lines_sum_to_order_total).toBe(false)
  })

  it('leaves a part-billed bundle alone, as it always did', () => {
    // Billing less than a bundled order authorised is partial delivery, and the
    // order still has value nothing has claimed. What stops several part bills
    // overdrawing one order is the cumulative check, not this one.
    const invoice = invoiceOf(['A4 Paper Reams', 40_000])
    const bigger = orderOf(200_000, [BUNDLE, 200_000])
    expect(coverage(invoice, bigger).passed).toBe(true)
  })

  it('says nothing when the order states no total to add up to', () => {
    const unpriced = { ...po, total_amount: null }
    const invoice = invoiceOf(['A4 Paper Reams', 40_000])
    const result = coverage(invoice, unpriced)
    expect(result.evidence?.lines_sum_to_order_total).toBe(false)
  })
})
