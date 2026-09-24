// Orders, and the invoices a decision is comparing itself against.
//
// Three checks in the engine reach their answer by looking at other invoices: the
// near-duplicate check, the split check, and the running total against an order.
// Each of them reported a finding and showed none of what it found. These are the
// pieces the screens use to show it.

import { describe, expect, it } from 'vitest'

import type { InvoiceRow, PurchaseOrderRow, RunRow, VendorRow } from '../src/lib/database.types.ts'
import {
  matchesOrderSearch,
  orderStatusLabel,
  orderTallyFrom,
  sortOrders,
  summariseOrders,
} from '../src/lib/orders.ts'
import { comparedInvoices, invoicesOnOrder, namedInvoices, type LedgerEntry } from '../src/lib/relatedInvoices.ts'
import { approvedByPersonSentence } from '../src/lib/reasonCopy.ts'
import type { Verdict } from '../src/lib/database.types.ts'

const VERDICTS: Verdict[] = ['AUTO_APPROVE', 'REVIEW', 'HOLD', 'BLOCK', 'ROUTED_NOT_PAID']

// ---------------------------------------------------------------------------
// A small world
// ---------------------------------------------------------------------------

const vendor: VendorRow = {
  id: 'VX1',
  legal_name: 'Westmark Industrial Supplies Pvt Ltd',
  aliases: [],
  bank_account: '778899001122334',
  bank_ifsc: null,
  bank_confirmed_by: null,
  bank_confirmed_at: null,
  bank_changed_at: null,
  gstin: null,
  address: null,
  email_domain: null,
  status: 'active',
  created_at: '2026-07-01T00:00:00Z',
  added_by: null,
  updated_at: null,
  updated_by: null,
}

const order: PurchaseOrderRow = {
  po_number: 'WX-4400',
  vendor_id: vendor.id,
  total_amount: 300_000,
  currency: 'INR',
  amount_billed_to_date: 0,
  tax_treatment: 'inclusive',
  status: 'open',
  line_items: [],
  delivery_schedule: null,
  issued_date: '2026-08-01',
  created_at: '2026-08-01T00:00:00Z',
}

function invoice(id: string, over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id,
    invoice_number: `WX/${id}`,
    file_path: null,
    storage_path: null,
    file_hash: null,
    vendor_name_as_printed: vendor.legal_name,
    vendor_id: null,
    po_reference: order.po_number,
    invoice_date: '2026-09-01',
    currency: 'INR',
    subtotal: null,
    tax: null,
    total: 100_000,
    bank_account_printed: null,
    remit_to_name: null,
    document_type: 'invoice',
    line_items: null,
    extraction_confidence: null,
    parent_invoice_number: null,
    notes_field: null,
    expected_verdict: null,
    fields_not_printed: null,
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  }
}

function run(id: string, invoiceId: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id,
    invoice_id: invoiceId,
    status: 'complete',
    verdict: 'AUTO_APPROVE',
    reason_codes: ['CLEAN_MATCH'],
    parent_run_id: null,
    changed_fields: null,
    matched_po: order.po_number,
    explanation: null,
    started_at: '2026-09-01T09:00:00Z',
    finished_at: '2026-09-01T09:00:05Z',
    touched_by_human: false,
    touched_by: null,
    approved_at: null,
    discarded_at: null,
    discarded_by: null,
    ...over,
  }
}

const subject = { invoiceId: 'a', invoiceDate: '2026-09-20', total: 100_000 }

// ---------------------------------------------------------------------------
// What an order has left
// ---------------------------------------------------------------------------

describe('an order, summarised', () => {
  const ledger: LedgerEntry[] = [
    { invoice: invoice('a'), run: run('run-a', 'a') },
    { invoice: invoice('b', { total: 60_000 }), run: run('run-b', 'b', { verdict: 'HOLD' }) },
    {
      invoice: invoice('c', { total: 40_000 }),
      run: run('run-c', 'c', { verdict: 'HOLD', touched_by_human: true, touched_by: 'Priya Raghavan' }),
    },
    { invoice: invoice('d', { total: 90_000 }), run: run('run-d', 'd', { matched_po: 'WX-9999' }) },
  ]

  const [summary] = summariseOrders([order], [vendor], ledger)

  it('counts what the rules approved and what a person approved', () => {
    expect(summary.billedToDate).toBe(140_000)
  })

  it('leaves out what is still waiting for somebody', () => {
    // The 60,000 held invoice is not money the order has committed.
    expect(summary.billedToDate).not.toBe(200_000)
  })

  it('leaves out invoices billed against a different order', () => {
    expect(summary.billedToDate).toBeLessThan(230_000)
  })

  it('says what is left', () => {
    expect(summary.remaining).toBe(160_000)
  })

  it('counts every invoice against it, whatever each was decided as', () => {
    expect(summary.invoiceCount).toBe(3)
  })

  it('names the vendor it was raised with', () => {
    expect(summary.vendor?.legal_name).toBe(vendor.legal_name)
  })

  it('adds to the opening balance rather than replacing it', () => {
    const [opened] = summariseOrders([{ ...order, amount_billed_to_date: 25_000 }], [vendor], ledger)
    expect(opened.billedToDate).toBe(165_000)
    expect(opened.remaining).toBe(135_000)
  })

  it('states no remaining balance for an order that states no value', () => {
    const [unpriced] = summariseOrders([{ ...order, total_amount: null }], [vendor], ledger)
    expect(unpriced.remaining).toBeNull()
  })
})

describe('the order list behaves like the other lists', () => {
  const rows = summariseOrders(
    [
      order,
      { ...order, po_number: 'WX-1100', total_amount: 50_000, status: 'closed', issued_date: '2026-06-01' },
    ],
    [vendor],
    [],
  )

  it('sorts on any column, both ways', () => {
    expect(sortOrders(rows, 'order', 'asc').map((row) => row.order.po_number)).toEqual(['WX-1100', 'WX-4400'])
    expect(sortOrders(rows, 'order', 'desc').map((row) => row.order.po_number)).toEqual(['WX-4400', 'WX-1100'])
    expect(sortOrders(rows, 'value', 'desc')[0].order.po_number).toBe('WX-4400')
    expect(sortOrders(rows, 'raised', 'asc')[0].order.po_number).toBe('WX-1100')
  })

  it('searches the order number, the vendor and the status', () => {
    expect(matchesOrderSearch(rows[0], '4400')).toBe(true)
    expect(matchesOrderSearch(rows[0], 'westmark')).toBe(true)
    expect(matchesOrderSearch(rows[1], 'closed')).toBe(true)
    expect(matchesOrderSearch(rows[0], 'nothing like it')).toBe(false)
    expect(matchesOrderSearch(rows[0], '  ')).toBe(true)
  })

  it('names a status rather than showing the stored word', () => {
    expect(orderStatusLabel('open')).toBe('Open')
    expect(orderStatusLabel(null)).toBe('Not recorded')
  })
})

// ---------------------------------------------------------------------------
// The arithmetic a reviewer should not have to do
// ---------------------------------------------------------------------------

describe('the figures on one decision', () => {
  const validations = {
    cumulative_overage: {
      passed: false,
      evidence: {
        po_total: 300_000,
        amount_billed_to_date: 270_000,
        this_invoice: 90_000,
        cumulative: 360_000,
        ceiling: 306_000,
      },
    },
  }

  it('takes them from what the invoice was actually measured against', () => {
    const tally = orderTallyFrom({ validations, order, invoiceTotal: 90_000 })
    expect(tally?.orderValue).toBe(300_000)
    expect(tally?.billedBefore).toBe(270_000)
    expect(tally?.thisInvoice).toBe(90_000)
  })

  it('works out the overage, so nobody has to', () => {
    expect(orderTallyFrom({ validations, order, invoiceTotal: 90_000 })?.overage).toBe(54_000)
  })

  it('shows no overage when the invoice sits inside the order', () => {
    const inside = {
      cumulative_overage: {
        passed: true,
        evidence: { po_total: 300_000, amount_billed_to_date: 0, this_invoice: 90_000, cumulative: 90_000, ceiling: 306_000 },
      },
    }
    expect(orderTallyFrom({ validations: inside, order, invoiceTotal: 90_000 })?.overage).toBeNull()
  })

  it('falls back to the order row for a run that never ran the check', () => {
    const tally = orderTallyFrom({
      validations: { cumulative_overage: { passed: true, evidence: { skipped: 'no purchase order matched' } } },
      order: { ...order, amount_billed_to_date: 41_600 },
      invoiceTotal: 12_000,
    })
    expect(tally?.billedBefore).toBe(41_600)
    expect(tally?.thisInvoice).toBe(12_000)
  })

  it('has nothing to say when no order was matched', () => {
    expect(orderTallyFrom({ validations, order: null, invoiceTotal: 90_000 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The other invoices on the order
// ---------------------------------------------------------------------------

describe('the other invoices billed against one order', () => {
  const ledger: LedgerEntry[] = [
    { invoice: invoice('a'), run: run('run-a', 'a') },
    { invoice: invoice('b', { invoice_date: '2026-09-02', total: 60_000 }), run: run('run-b', 'b') },
    {
      invoice: invoice('c', { invoice_date: '2026-09-03' }),
      run: run('run-c', 'c', { verdict: 'REVIEW', reason_codes: ['PO_OVERAGE'] }),
    },
    { invoice: invoice('d'), run: run('run-d', 'd', { matched_po: 'WX-9999' }) },
    { invoice: invoice('e'), run: null },
  ]

  const rows = invoicesOnOrder(order.po_number, ledger, subject)

  it('leaves out the invoice being decided', () => {
    expect(rows.map((row) => row.invoiceId)).not.toContain('a')
  })

  it('leaves out invoices billed against another order, and ones never decided', () => {
    expect(rows.map((row) => row.invoiceId)).toEqual(['b', 'c'])
  })

  it('says which of them are counting against the balance', () => {
    expect(rows.find((row) => row.invoiceId === 'b')?.countsAgainstTheOrder).toBe(true)
    expect(rows.find((row) => row.invoiceId === 'c')?.countsAgainstTheOrder).toBe(false)
  })

  it('carries a link to each decision, and the run behind its outcome', () => {
    expect(rows[0].runId).toBe('run-b')
    expect(rows[0].run?.verdict).toBe('AUTO_APPROVE')
  })

  it('has nothing to show when no order was matched', () => {
    expect(invoicesOnOrder(null, ledger, subject)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// What a cross-invoice check was comparing against
// ---------------------------------------------------------------------------

describe('the invoices a check named', () => {
  const ledger: LedgerEntry[] = [
    { invoice: invoice('a', { invoice_date: '2026-09-20' }), run: run('run-a', 'a') },
    { invoice: invoice('b', { invoice_date: '2026-09-06', total: 99_500 }), run: run('run-b', 'b') },
  ]

  const named = namedInvoices(
    [{ invoice_number: 'WX/b', invoice_date: '2026-09-06', total: 99_500 }],
    ledger,
    subject,
  )

  it('resolves what the check recorded into a row that can be opened', () => {
    expect(named).toHaveLength(1)
    expect(named[0].invoiceId).toBe('b')
    expect(named[0].runId).toBe('run-b')
  })

  it('says how far apart the two invoices are, in days and in money', () => {
    // The two things that separate a resubmission from a monthly bill.
    expect(named[0].gapDays).toBe(14)
    expect(named[0].amountDifference).toBe(500)
  })

  it('names the order each one cites', () => {
    expect(named[0].poNumber).toBe(order.po_number)
  })

  it('tells two records under one invoice number apart by their figures', () => {
    const twins: LedgerEntry[] = [
      { invoice: invoice('x', { invoice_number: 'WX/same', total: 10_000, invoice_date: '2026-09-01' }), run: run('run-x', 'x') },
      { invoice: invoice('y', { invoice_number: 'WX/same', total: 20_000, invoice_date: '2026-09-02' }), run: run('run-y', 'y') },
    ]
    const picked = namedInvoices([{ invoice_number: 'WX/same', invoice_date: '2026-09-02', total: 20_000 }], twins, subject)
    expect(picked[0].invoiceId).toBe('y')
  })

  it('never lists the invoice being decided as one of its own matches', () => {
    expect(namedInvoices([{ invoice_number: 'WX/a', total: 100_000 }], ledger, subject)).toEqual([])
  })

  it('reads the matches off a check that objected', () => {
    const validations = {
      near_duplicate: { passed: false, evidence: { matches: [{ invoice_number: 'WX/b', total: 99_500 }] } },
    }
    expect(comparedInvoices(validations, 'near_duplicate', 'matches')).toHaveLength(1)
  })

  it('shows nothing for a check that passed', () => {
    const validations = {
      near_duplicate: { passed: true, evidence: { matches: [] } },
      threshold_split: { passed: true, evidence: { invoices: [{ invoice_number: 'WX/b' }] } },
    }
    expect(comparedInvoices(validations, 'near_duplicate', 'matches')).toEqual([])
    expect(comparedInvoices(validations, 'threshold_split', 'invoices')).toEqual([])
  })

  it('shows nothing for a run with no validation report at all', () => {
    expect(comparedInvoices(null, 'near_duplicate', 'matches')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The override banner
// ---------------------------------------------------------------------------

describe('what an override says it overrode', () => {
  // The banner read "The checks had review it, and that is still what they
  // found": the chip's label, lower-cased and used as a verb. Chip labels are
  // nouns and do not decline, so each verdict states its own clause.
  const CLAUSE: Record<Verdict, string> = {
    AUTO_APPROVE: 'the checks had approved it too',
    REVIEW: 'the checks had sent it for review',
    HOLD: 'the checks had held it',
    BLOCK: 'the checks had blocked it',
    ROUTED_NOT_PAID: 'the checks had recorded it rather than paying it',
  }

  it.each(VERDICTS)('reads as English after a verdict of %s', (verdict) => {
    const sentence = approvedByPersonSentence('Priya Raghavan', '23 Sep 2026, 11:30', verdict)
    expect(sentence).toBe(
      `Priya Raghavan approved this on 23 Sep 2026, 11:30. Before that, ${CLAUSE[verdict]}, and what they found is unchanged below.`,
    )
  })

  it('never reads a verdict label out as a verb', () => {
    // Which is the whole defect: "review" and "recorded" are not things the
    // checks can have done to an invoice.
    for (const verdict of VERDICTS) {
      const sentence = approvedByPersonSentence('A Person', 'today', verdict)
      expect(sentence, verdict).not.toMatch(/had (review|recorded) it[,.]/)
    }
  })

  it('still reads when the rules never reached a verdict', () => {
    expect(approvedByPersonSentence('Priya Raghavan', 'a date that was not recorded', null)).toContain(
      'the checks had stopped it',
    )
  })

  it('carries no em dash, like everything else a person reads', () => {
    for (const verdict of VERDICTS) {
      expect(approvedByPersonSentence('A Person', 'today', verdict)).not.toContain('—')
    }
  })
})
