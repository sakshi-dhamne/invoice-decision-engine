// The product's main workflow, end to end.
//
// An invoice arrives from a company nobody has paid before, citing an order nobody
// has raised. Two people do two things to it, and it clears. That sequence is what
// the whole application is for, and nothing asserted it worked.
//
// It did not. Raising an order for an invoice that cites one created the order under
// an invented number (PO-KAVERI-7B3C) instead of the number the document cites
// (PO-2075), so stage 4's reference lookup never found it and the invoice held on
// NO_PO_MATCH for ever. Re-running could not help: the order that existed was not
// the order the invoice was asking to be paid against.
//
// Driven through the rules engine rather than the database, which is what lets the
// three states be asserted as one sequence with no network. Each step is the engine
// seeing the world as it stands after the previous person's action, which is exactly
// what a re-run is.

import { describe, expect, it } from 'vitest'

import { decideInvoice } from '../src/rules/decide.ts'
import { orderNumberFor, orderNumberToRaise } from '../src/lib/orderForm.ts'
import { rules } from './fixtures.ts'
import type { InvoiceFacts, PurchaseOrderRecord, VendorRecord } from '../src/rules/types.ts'

// Fixed, so a date-sensitive rule cannot make this depend on when it is run.
const AS_OF = new Date('2026-09-18T00:00:00Z')

/** The order number printed on the document. */
const CITED = 'PO-2075'

// A company and an invoice that share no name, number or amount with the corpus, so
// this proves the path rather than a fixture.
const kaveri: VendorRecord = {
  id: 'KAVERI-3F21',
  legal_name: 'Kaveri Precision Engineering LLP',
  aliases: ['Kaveri Precision'],
  bank_account: '918020045566778',
  status: 'active',
}

const invoice: InvoiceFacts = {
  invoice_number: 'KPE-2026-0447',
  invoice_date: '2026-09-10',
  vendor_name: 'Kaveri Precision Engineering LLP',
  po_reference: CITED,
  currency: 'INR',
  // Lines stated net. 120000 x 1.18 = 141600 gross, which is what the order
  // authorises once it is raised.
  line_items: [{ description: 'Precision machined housings', quantity: 40, unit_price: 3000, amount: 120000 }],
  subtotal: 120000,
  tax: 21600,
  total: 141600,
  bank_account: '918020045566778',
  remit_to_name: 'Kaveri Precision Engineering LLP',
  document_type: 'invoice',
  notes: null,
  file_hash: 'sha256:kpe-0447',
  fields_not_printed: [],
}

/**
 * An order shaped exactly as the form creates one.
 *
 * One line, described as the invoice describes the work, with no quantity and no
 * unit price, priced at the value the person typed. Asserting against an idealised
 * order would not test the path a person actually takes.
 */
function asRaisedByTheForm(poNumber: string, value = 141600): PurchaseOrderRecord {
  return {
    po_number: poNumber,
    vendor_id: kaveri.id,
    total_amount: value,
    currency: 'INR',
    amount_billed_to_date: 0,
    tax_treatment: 'inclusive',
    status: 'open',
    line_items: [{ description: 'Precision machined housings', quantity: null, unit_price: null, amount: value }],
    delivery_schedule: null,
    issued_date: '2026-09-01',
  }
}

/** The engine, against the world as it stands. A re-run is this, called again. */
function decide(vendors: readonly VendorRecord[], purchaseOrders: readonly PurchaseOrderRecord[]) {
  return decideInvoice({
    facts: invoice,
    vendors,
    purchaseOrders,
    rules,
    asOf: AS_OF,
    submissionId: 'kpe-0447',
    submissions: [],
  })
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

describe('the remediation sequence, from an unknown vendor to a clean match', () => {
  it('holds the invoice when the vendor is not on the approved list', () => {
    const outcome = decide([], [])
    expect(outcome.decision.verdict).toBe('HOLD')
    expect(outcome.decision.reason_codes).toContain('UNKNOWN_VENDOR')
  })

  it('moves to NO_PO_MATCH once the vendor is onboarded and it is re-run', () => {
    // The vendor exists now. Nothing about the document changed, and nothing was
    // carried over from the earlier decision.
    const outcome = decide([kaveri], [])
    expect(outcome.decision.verdict).toBe('HOLD')
    expect(outcome.decision.reason_codes).toContain('NO_PO_MATCH')
    expect(outcome.decision.reason_codes).not.toContain('UNKNOWN_VENDOR')
  })

  it('reaches CLEAN_MATCH once the cited order is raised and it is re-run', () => {
    const raised = asRaisedByTheForm(orderNumberToRaise(CITED, kaveri.legal_name))
    const outcome = decide([kaveri], [raised])

    expect(outcome.decision.verdict).toBe('AUTO_APPROVE')
    expect(outcome.decision.reason_codes).toEqual(['CLEAN_MATCH'])
    // Matched on the printed reference, not inferred from the amount. An inferred
    // match is a suggestion and never authoritative.
    expect(outcome.poMatch.outcome).toBe('explicit')
    expect(outcome.poMatch.method).toBe('explicit')
    expect(outcome.poMatch.matched?.po_number).toBe(CITED)
  })

  it('walks all three states in order, which is the workflow', () => {
    const raised = asRaisedByTheForm(orderNumberToRaise(CITED, kaveri.legal_name))

    const sequence = [
      decide([], []),
      decide([kaveri], []),
      decide([kaveri], [raised]),
    ].map((outcome) => [outcome.decision.verdict, outcome.decision.reason_codes[0]])

    expect(sequence).toEqual([
      ['HOLD', 'UNKNOWN_VENDOR'],
      ['HOLD', 'NO_PO_MATCH'],
      ['AUTO_APPROVE', 'CLEAN_MATCH'],
    ])
  })

  it('leaves each step to be earned, so neither action clears the other problem', () => {
    // Raising the order without onboarding the vendor changes nothing: an invoice
    // can only bill against its own vendor's orders, and it has no vendor yet.
    const orderOnly = decide([], [asRaisedByTheForm(CITED)])
    expect(orderOnly.decision.reason_codes).toContain('UNKNOWN_VENDOR')
    expect(orderOnly.poMatch.outcome).not.toBe('explicit')
  })
})

// ---------------------------------------------------------------------------
// Why it used to fail
// ---------------------------------------------------------------------------

describe('an order is raised under the number the invoice cites', () => {
  it('uses the cited reference as the order number', () => {
    expect(orderNumberToRaise(CITED, kaveri.legal_name)).toBe(CITED)
  })

  it('never matches when the order is raised under an invented number', () => {
    // The bug, pinned. The order exists, belongs to the right vendor, is open and
    // is priced exactly right, and the invoice still holds, because it is not the
    // order the document cites.
    const invented = orderNumberFor(kaveri.legal_name)
    expect(invented).not.toBe(CITED)

    const outcome = decide([kaveri], [asRaisedByTheForm(invented)])
    expect(outcome.poMatch.outcome).not.toBe('explicit')
    expect(outcome.decision.reason_codes).toContain('NO_PO_MATCH')
    expect(outcome.decision.verdict).toBe('HOLD')
  })

  it('matches through the normalisation stage 4 already applies', () => {
    // Case and surrounding whitespace on either side. The number is compared as a
    // string and never interpreted, so this is the whole of what tolerance means.
    for (const stored of [' po-2075 ', 'PO-2075', 'Po-2075']) {
      const outcome = decide([kaveri], [asRaisedByTheForm(orderNumberToRaise(stored, kaveri.legal_name))])
      expect(outcome.poMatch.outcome, stored).toBe('explicit')
      expect(outcome.decision.reason_codes, stored).toEqual(['CLEAN_MATCH'])
    }
  })

  it('invents a legible number only when the invoice cites none', () => {
    // The other way an invoice reaches NO_PO_MATCH: there is no reference to
    // honour, so something readable is generated instead.
    for (const nothing of [null, undefined, '', '   ']) {
      expect(orderNumberToRaise(nothing, kaveri.legal_name)).toMatch(/^PO-KAVERI-[A-Z0-9]{4}$/)
    }
  })

  it('keeps the cited number as printed rather than rewriting it', () => {
    // Storing a normalised form would mangle a legitimate number that contains a
    // space, and stage 4 normalises both sides anyway.
    expect(orderNumberToRaise('REQ 4417/B', kaveri.legal_name)).toBe('REQ 4417/B')
  })
})
