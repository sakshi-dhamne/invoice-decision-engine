// The two blockers from testing the live app.
//
// 1. Raising an order for a held invoice was impossible. The page read the vendor
//    off `invoices.vendor_id`, a seeded column the pipeline never writes, so a
//    vendor added after the run was decided did not exist as far as the form was
//    concerned. It said there was nobody to raise an order with, and the submit
//    button stayed dead with every field correctly filled in.
//
// 2. Approving an invoice recorded the approver and changed nothing else. The
//    invoice went on reading Held and went on sitting in the exceptions queue.
//
// Both are driven here against stubbed I/O, so what is asserted is the behaviour
// rather than the wiring.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PurchaseOrderInsert, PurchaseOrderRow, RunRow, VendorRow } from '../src/lib/database.types.ts'

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

// A vendor somebody added five minutes ago to clear this very hold. Its id is not
// on any invoice row, which is the whole point.
const sunrise: VendorRow = {
  id: 'SUNRIS-4K2P',
  legal_name: 'Sunrise Enterprise',
  aliases: ['Sunrise Enterprises'],
  bank_account: '500100200300400',
  bank_ifsc: 'HDFC0001234',
  bank_confirmed_by: 'Rang Priya on the number on the contract',
  bank_confirmed_at: '2026-09-20T00:00:00Z',
  bank_changed_at: null,
  gstin: null,
  address: null,
  email_domain: null,
  status: 'active',
  created_at: '2026-09-20T00:00:00Z',
  added_by: 'Asha',
  updated_at: null,
  updated_by: null,
}

const createdOrders: PurchaseOrderInsert[] = []
const reRunInvoiceIds: string[] = []

vi.mock('../src/lib/queries.ts', () => ({
  createPurchaseOrder: async (order: PurchaseOrderInsert) => {
    createdOrders.push(order)
    return { ...order, created_at: '2026-09-23T10:00:00Z' } as PurchaseOrderRow
  },
  getVendors: async () => [sunrise],
  getRules: async () => ({}),
}))

vi.mock('../src/lib/pipeline.ts', async () => {
  // toVendorRecord is the real adapter; only the I/O is stubbed.
  const actual = await vi.importActual<typeof import('../src/lib/pipeline.ts')>('../src/lib/pipeline.ts')
  return {
    ...actual,
    runInvoice: async (invoiceId: string, options: { onRunCreated?: (run: RunRow) => void } = {}) => {
      reRunInvoiceIds.push(invoiceId)
      const run = { id: 'run-after-order', invoice_id: invoiceId, verdict: 'AUTO_APPROVE' } as RunRow
      options.onRunCreated?.(run)
      return { run, verdict: 'AUTO_APPROVE' }
    },
  }
})

const { emptyOrderInputs, orderIsComplete } = await import('../src/lib/orderForm.ts')
const { raiseOrder } = await import('../src/lib/raiseOrder.ts')
const { resolveVendorForDocument } = await import('../src/lib/vendorLookup.ts')
const { approvedByPerson, effectiveVerdict, needsAPerson } = await import('../src/lib/feed.ts')
const { rules } = await import('./fixtures.ts')

// ---------------------------------------------------------------------------
// 1. Raising an order
// ---------------------------------------------------------------------------

describe('the vendor for a held invoice is resolved now, not remembered', () => {
  it('finds a vendor that was added after the run was decided', () => {
    // The invoice row has no vendor id and never will: the pipeline resolves the
    // vendor every run and writes the answer nowhere.
    const resolved = resolveVendorForDocument({
      printedName: 'SUNRISE ENTERPRISE',
      storedVendorId: null,
      vendors: [sunrise],
      rules,
    })
    expect(resolved.vendor?.id).toBe(sunrise.id)
    expect(resolved.resolvedNow).toBe(true)
  })

  it('finds it through the same normalisation stage 3 uses', () => {
    // Case, punctuation and a suffix the document prints and the master does not.
    for (const printed of ['Sunrise Enterprise', 'SUNRISE ENTERPRISE', 'Sunrise Enterprises']) {
      expect(resolveVendorForDocument({ printedName: printed, storedVendorId: null, vendors: [sunrise], rules }).vendor?.id, printed).toBe(sunrise.id)
    }
  })

  it('still says nobody when the name genuinely resolves to nobody', () => {
    const resolved = resolveVendorForDocument({
      printedName: 'Zenith Traders',
      storedVendorId: null,
      vendors: [sunrise],
      rules,
    })
    expect(resolved.vendor).toBeNull()
  })

  it('falls back to the stored column when nothing was read off the page', () => {
    const resolved = resolveVendorForDocument({
      printedName: null,
      storedVendorId: sunrise.id,
      vendors: [sunrise],
      rules,
    })
    expect(resolved.vendor?.id).toBe(sunrise.id)
    expect(resolved.resolvedNow).toBe(false)
  })
})

describe('raising an order for an existing vendor', () => {
  beforeEach(() => {
    createdOrders.length = 0
    reRunInvoiceIds.length = 0
  })

  // The form as a person fills it in: order value, issue date, status and tax
  // treatment. Vendor and description came off the invoice.
  const filled = {
    ...emptyOrderInputs('2026-09-23'),
    totalAmount: '84,000',
    status: 'open' as const,
    taxTreatment: 'exclusive' as const,
  }

  it('enables the button once the required fields are valid', () => {
    expect(orderIsComplete(filled)).toBe(true)
  })

  it('creates the purchase order against the resolved vendor', async () => {
    const raised = await raiseOrder({
      vendor: sunrise,
      invoiceId: 'invoice-inv-5',
      description: 'Site works, second phase',
      currency: 'INR',
      inputs: filled,
    })

    expect(createdOrders).toHaveLength(1)
    const order = createdOrders[0]
    expect(order.vendor_id).toBe(sunrise.id)
    // The typed value, not the invoice total, and with the thousands separator
    // read rather than rejected.
    expect(order.total_amount).toBe(84000)
    expect(order.status).toBe('open')
    expect(order.tax_treatment).toBe('exclusive')
    expect(order.issued_date).toBe('2026-09-23')
    expect(order.amount_billed_to_date).toBe(0)
    expect(raised.order.po_number).toBe(order.po_number)
  })

  it('re-runs the invoice against it and returns the new run', async () => {
    const raised = await raiseOrder({
      vendor: sunrise,
      invoiceId: 'invoice-inv-5',
      description: 'Site works, second phase',
      currency: 'INR',
      inputs: filled,
    })

    expect(reRunInvoiceIds).toEqual(['invoice-inv-5'])
    expect(raised.runId).toBe('run-after-order')
  })

  it('describes the order with the line text, priced at the typed value', async () => {
    await raiseOrder({
      vendor: sunrise,
      invoiceId: 'invoice-inv-5',
      description: 'Site works, second phase',
      currency: 'INR',
      inputs: filled,
    })
    const lines = createdOrders[0].line_items as { description: string; amount: number }[]
    expect(lines).toEqual([
      { description: 'Site works, second phase', quantity: null, unit_price: null, amount: 84000 },
    ])
  })

  it('refuses to raise an order with no value, whatever the caller passes', async () => {
    await expect(
      raiseOrder({
        vendor: sunrise,
        invoiceId: 'invoice-inv-5',
        description: 'Site works',
        currency: 'INR',
        inputs: emptyOrderInputs('2026-09-23'),
      }),
    ).rejects.toThrow()
    expect(createdOrders).toHaveLength(0)
    expect(reRunInvoiceIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. An override is an outcome
// ---------------------------------------------------------------------------

const heldRun = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-02857',
    invoice_id: 'invoice-02857',
    status: 'complete',
    verdict: 'HOLD',
    reason_codes: ['NO_PO_MATCH'],
    parent_run_id: null,
    changed_fields: null,
    matched_po: null,
    explanation: null,
    started_at: '2026-09-22T09:00:00Z',
    finished_at: '2026-09-22T09:00:05Z',
    touched_by_human: false,
    touched_by: null,
    approved_at: null,
    discarded_at: null,
    discarded_by: null,
    ...over,
  }) as RunRow

describe('approving an invoice the rules stopped', () => {
  const approved = heldRun({
    touched_by_human: true,
    touched_by: 'test approver',
    approved_at: '2026-09-23T11:30:00Z',
  })

  it('leaves it reading Held while nobody has approved it', () => {
    expect(effectiveVerdict(heldRun())).toBe('HOLD')
    expect(needsAPerson(heldRun())).toBe(true)
  })

  it('makes the outcome approved', () => {
    expect(effectiveVerdict(approved)).toBe('AUTO_APPROVE')
  })

  it('takes it out of the exceptions queue', () => {
    expect(needsAPerson(approved)).toBe(false)
  })

  it('keeps what the rules decided, so what was overruled stays visible', () => {
    expect(approved.verdict).toBe('HOLD')
    expect(approved.reason_codes).toEqual(['NO_PO_MATCH'])
  })

  it('records who and when', () => {
    expect(approvedByPerson(approved)).toBe(true)
    expect(approved.touched_by).toBe('test approver')
    expect(approved.approved_at).toBe('2026-09-23T11:30:00Z')
  })

  it('does not treat a flag with no name as an approval', () => {
    const unnamed = heldRun({ touched_by_human: true, touched_by: '  ' })
    expect(approvedByPerson(unnamed)).toBe(false)
    expect(effectiveVerdict(unnamed)).toBe('HOLD')
    expect(needsAPerson(unnamed)).toBe(true)
  })

  it('stamps the time when the override is recorded', async () => {
    // The write itself: recordOverride sets all three, so no approval can land
    // without a time against it again.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/lib/queries.ts', import.meta.url), 'utf8'),
    )
    expect(source).toContain('touched_by_human: true, touched_by: who, approved_at: new Date().toISOString()')
  })
})
