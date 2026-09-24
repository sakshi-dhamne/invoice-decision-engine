// Raising an order before any invoice exists.
//
// The counterpart to raising one from a held invoice: that flow reacts to an
// invoice that arrived with nothing authorising it, this one is the ordinary way
// round. Both write the same kind of record, and the test that matters is that an
// order raised this way is a real order, so an invoice billing against it later
// clears on the same rules as any other.
//
// The integration half drives the real `runInvoice` against stubbed I/O, the way
// duplicateCost.spec.ts and orderBalance.spec.ts do.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  InvoiceRow,
  PurchaseOrderInsert,
  PurchaseOrderRow,
  RunRow,
  StageLogRow,
  VendorRow,
} from '../src/lib/database.types.ts'

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const BANK = '778899001122334'
const WORK = 'Site preparation and groundworks'
const ORDER_VALUE = 84_000

function vendorRow(id: string, legalName: string, over: Partial<VendorRow> = {}): VendorRow {
  return {
    id,
    legal_name: legalName,
    aliases: [],
    bank_account: BANK,
    bank_ifsc: 'HDFC0009999',
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
    ...over,
  }
}

const westmark = vendorRow('VX1', 'Westmark Industrial Supplies Pvt Ltd', { aliases: ['Westmark'] })
const ashford = vendorRow('VX2', 'Ashford Freight Services Pvt Ltd')
const retired = vendorRow('VX3', 'Calloway Print Works Pvt Ltd', { status: 'inactive' })

function orderRow(poNumber: string, vendorId: string, over: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow {
  return {
    po_number: poNumber,
    vendor_id: vendorId,
    total_amount: 100_000,
    currency: 'INR',
    amount_billed_to_date: 0,
    tax_treatment: 'inclusive',
    status: 'open',
    line_items: [],
    delivery_schedule: null,
    issued_date: '2026-08-01',
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  }
}

// The invoice that turns up afterwards: same vendor, same amount, same wording,
// citing the order that was raised for it.
const invoice: InvoiceRow = {
  id: 'invoice-after-order',
  invoice_number: 'WX/2026/5501',
  file_path: 'fixtures/pdfs/after-order.pdf',
  storage_path: null,
  file_hash: null,
  vendor_name_as_printed: westmark.legal_name,
  vendor_id: null,
  po_reference: null, // filled in once the order has a number
  invoice_date: '2026-09-15',
  currency: 'INR',
  subtotal: null,
  tax: null,
  total: ORDER_VALUE,
  bank_account_printed: BANK,
  remit_to_name: westmark.legal_name,
  document_type: 'invoice',
  line_items: null,
  extraction_confidence: null,
  parent_invoice_number: null,
  notes_field: null,
  expected_verdict: null,
  fields_not_printed: null,
  created_at: '2026-09-15T09:00:00Z',
}

const state = {
  vendors: [westmark, ashford, retired] as VendorRow[],
  orders: [] as PurchaseOrderRow[],
  invoices: [invoice] as InvoiceRow[],
  runs: [] as RunRow[],
  stageLogs: [] as StageLogRow[],
}

vi.mock('../src/lib/extraction.ts', () => ({
  getOrExtract: async (invoiceId: string) => {
    const row = state.invoices.find((entry) => entry.id === invoiceId)
    if (!row) throw new Error(`no invoice ${invoiceId}`)
    return {
      data: {
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        vendor_name: row.vendor_name_as_printed,
        po_reference: row.po_reference,
        currency: 'INR',
        line_items: [{ description: WORK, quantity: 1, unit_price: row.total, amount: row.total }],
        subtotal: null,
        tax: null,
        total: row.total,
        bank_account: row.bank_account_printed,
        bank_ifsc: null,
        remit_to_name: row.remit_to_name,
        document_type: 'invoice' as const,
        notes: null,
        confidence: {},
        // A tax-inclusive layout states one total and prints no split, which is a
        // correct abstention rather than a failed read.
        unreadable_fields: ['subtotal', 'tax'],
        extraction_notes: null,
      },
      model: 'stub',
      duration_ms: 1,
      fromCache: true,
      extractedAt: '2026-09-15T09:00:02Z',
    }
  },
  documentFromBytes: (buffer: ArrayBuffer) => ({ base64: String(buffer.byteLength), mimeType: 'application/pdf' }),
}))

vi.mock('../src/lib/uploads.ts', () => ({
  UPLOAD_BUCKET: 'invoices',
  describeUploadedInvoice: vi.fn(async () => undefined),
}))

vi.mock('../src/lib/supabase.ts', () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://stub/${path}` } }) }) },
    functions: { invoke: async () => ({ data: { ok: false, error: 'off' }, error: null }) },
  },
}))

vi.mock('../src/lib/queries.ts', async () => {
  const { rules } = await import('./fixtures.ts')
  const ruleRows = Object.fromEntries(
    Object.entries(rules).map(([key, value]) => [key, { key, value, unit: null, description: null, updated_at: '' }]),
  )

  return {
    getRules: async () => ruleRows,
    getVendors: async () => state.vendors,
    getPurchaseOrders: async () => state.orders,
    getInvoices: async () => state.invoices,
    getInvoiceById: async (id: string) => state.invoices.find((row) => row.id === id) ?? null,
    getCompletedRuns: async () => state.runs.filter((run) => run.status === 'complete'),
    // The one write this flow makes. A repeated order number is refused the way
    // the database refuses it, because the number is the primary key.
    createPurchaseOrder: async (order: PurchaseOrderInsert) => {
      if (state.orders.some((entry) => entry.po_number === order.po_number)) {
        throw new Error(`duplicate key value violates unique constraint on ${order.po_number}`)
      }
      const row = { ...order, created_at: '2026-09-10T10:00:00Z' } as PurchaseOrderRow
      state.orders.push(row)
      return row
    },
    setInvoiceFileHash: async (invoiceId: string, hash: string) => {
      const row = state.invoices.find((entry) => entry.id === invoiceId)
      if (row) row.file_hash = hash
    },
    createRun: async (invoiceId: string) => {
      const run = {
        id: `run-${state.runs.length + 1}`,
        invoice_id: invoiceId,
        status: 'running',
        verdict: null,
        reason_codes: null,
        parent_run_id: null,
        changed_fields: null,
        matched_po: null,
        explanation: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        touched_by_human: false,
        touched_by: null,
        approved_at: null,
        discarded_at: null,
        discarded_by: null,
      } as RunRow
      state.runs.push(run)
      return run
    },
    updateRun: async (id: string, patch: Partial<RunRow>) => {
      const run = state.runs.find((entry) => entry.id === id)
      if (!run) throw new Error(`no run ${id}`)
      Object.assign(run, patch)
      return run
    },
    logStage: async (runId: string, stage: string, order: number, status: string) => {
      const log = {
        id: `stage-${state.stageLogs.length + 1}`,
        run_id: runId,
        stage,
        stage_order: order,
        status,
        input: null,
        output: null,
        reasoning: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
      } as StageLogRow
      state.stageLogs.push(log)
      return log
    },
    updateStageLog: async (id: string, patch: Partial<StageLogRow>) => {
      const log = state.stageLogs.find((entry) => entry.id === id)
      if (!log) throw new Error(`no stage log ${id}`)
      Object.assign(log, patch)
      return log
    },
  }
})

vi.stubGlobal('fetch', async (url: string) => ({
  ok: true,
  headers: { get: () => 'application/pdf' },
  arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer,
}))

const {
  createOrder,
  currencyIsValid,
  emptyNewOrder,
  newOrderIsComplete,
  orderableVendors,
  orderInsertFor,
  suggestOrderNumber,
  vendorsMatching,
} = await import('../src/lib/newOrder.ts')
const { runInvoice } = await import('../src/lib/pipeline.ts')

// ---------------------------------------------------------------------------
// Choosing the vendor
// ---------------------------------------------------------------------------

describe('the vendors an order can be raised with', () => {
  it('offers the approved list, in the order a person reads it', () => {
    expect(orderableVendors(state.vendors).map((vendor) => vendor.id)).toEqual(['VX2', 'VX1'])
  })

  it('leaves out an inactive vendor', () => {
    // An order against one is an order no invoice can ever be paid against: the
    // vendor check stops the invoice before anything looks at the order.
    expect(orderableVendors(state.vendors).map((vendor) => vendor.id)).not.toContain(retired.id)
  })

  it('searches the registered name and the names it is also known by', () => {
    const offered = orderableVendors(state.vendors)
    expect(vendorsMatching(offered, 'westmark').map((vendor) => vendor.id)).toEqual(['VX1'])
    expect(vendorsMatching(offered, 'FREIGHT').map((vendor) => vendor.id)).toEqual(['VX2'])
    expect(vendorsMatching(offered, '  ').map((vendor) => vendor.id)).toEqual(['VX2', 'VX1'])
    expect(vendorsMatching(offered, 'nobody')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The suggested order number
// ---------------------------------------------------------------------------

describe('the order number suggested for a vendor', () => {
  it('follows the sequence that vendor\'s orders already use', () => {
    const orders = [orderRow('PO-4100', westmark.id), orderRow('PO-4101', westmark.id)]
    expect(suggestOrderNumber(westmark, orders)).toBe('PO-4102')
  })

  it('keeps the width of the numbers it is following', () => {
    expect(suggestOrderNumber(westmark, [orderRow('WX-007', westmark.id)])).toBe('WX-008')
  })

  it('carries on from the highest, not from the most recent', () => {
    const orders = [orderRow('PO-4109', westmark.id), orderRow('PO-4102', westmark.id)]
    expect(suggestOrderNumber(westmark, orders)).toBe('PO-4110')
  })

  it('ignores other vendors\' sequences', () => {
    const orders = [orderRow('PO-9900', ashford.id), orderRow('PO-4100', westmark.id)]
    expect(suggestOrderNumber(westmark, orders)).toBe('PO-4101')
    expect(suggestOrderNumber(ashford, orders)).toBe('PO-9901')
  })

  it('starts a sequence from the vendor name when there is none to follow', () => {
    expect(suggestOrderNumber(westmark, [])).toBe('PO-WESTMA-001')
  })

  it('steps past a number another vendor already holds', () => {
    // The number is the order's primary key, so a collision is a failed save
    // rather than a warning.
    const orders = [orderRow('PO-4100', westmark.id), orderRow('PO-4101', ashford.id)]
    expect(suggestOrderNumber(westmark, orders)).toBe('PO-4102')
  })
})

// ---------------------------------------------------------------------------
// Filling the form in
// ---------------------------------------------------------------------------

describe('the form', () => {
  const filled = {
    ...emptyNewOrder('2026-09-10'),
    vendorId: westmark.id,
    poNumber: 'PO-WESTMA-001',
    description: WORK,
    totalAmount: '84,000',
  }

  it('starts with nothing chosen and nothing typed', () => {
    const blank = emptyNewOrder('2026-09-10')
    expect(blank.vendorId).toBe('')
    expect(blank.poNumber).toBe('')
    expect(blank.description).toBe('')
    expect(blank.totalAmount).toBe('')
  })

  it('opens an order rather than closing one', () => {
    expect(emptyNewOrder('2026-09-10').status).toBe('open')
  })

  it('enables the button once every required field is filled', () => {
    expect(newOrderIsComplete(filled)).toBe(true)
  })

  it.each([
    ['vendor', { vendorId: '' }],
    ['order number', { poNumber: '   ' }],
    ['description', { description: '' }],
    ['order value', { totalAmount: '' }],
    ['a value above zero', { totalAmount: '0' }],
    ['a readable currency', { currency: 'rupees' }],
    ['issue date', { issuedDate: '' }],
  ])('stays disabled without the %s', (_what, missing) => {
    expect(newOrderIsComplete({ ...filled, ...missing })).toBe(false)
  })

  it('reads a currency as three letters, whatever the case', () => {
    expect(currencyIsValid('inr')).toBe(true)
    expect(currencyIsValid('INR')).toBe(true)
    expect(currencyIsValid('IN')).toBe(false)
    expect(currencyIsValid('')).toBe(false)
  })

  it('records what was typed, with the thousands separator read rather than refused', () => {
    const insert = orderInsertFor(filled, westmark)
    expect(insert.po_number).toBe('PO-WESTMA-001')
    expect(insert.vendor_id).toBe(westmark.id)
    expect(insert.total_amount).toBe(ORDER_VALUE)
    expect(insert.currency).toBe('INR')
    expect(insert.status).toBe('open')
    expect(insert.issued_date).toBe('2026-09-10')
    expect(insert.line_items).toEqual([
      { description: WORK, quantity: null, unit_price: null, amount: ORDER_VALUE },
    ])
  })

  it('opens the order with nothing billed against it', () => {
    // What is billed against it later is derived from the invoices, never written
    // here.
    expect(orderInsertFor(filled, westmark).amount_billed_to_date).toBe(0)
  })

  it('states a tax treatment, so an invoice can be put on a common basis with it', () => {
    // An order that states none fails the tax check on every invoice billed
    // against it, whatever else is right about them.
    expect(orderInsertFor(filled, westmark).tax_treatment).toBe('exclusive')
    expect(orderInsertFor({ ...filled, taxTreatment: 'inclusive' }, westmark).tax_treatment).toBe('inclusive')
  })

  it('refuses to raise an order with no value, whatever the caller passes', () => {
    expect(() => orderInsertFor({ ...filled, totalAmount: '' }, westmark)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The order is a real order
// ---------------------------------------------------------------------------

describe('an invoice billed against an order raised this way', () => {
  beforeEach(() => {
    state.orders.length = 0
    state.runs.length = 0
    state.stageLogs.length = 0
    invoice.file_hash = null
    invoice.po_reference = null
  })

  // The form as a person fills it in, and then the invoice that turns up against
  // it: same vendor, same amount, same wording.
  async function raiseThenInvoice() {
    const inputs = {
      ...emptyNewOrder('2026-09-10'),
      vendorId: westmark.id,
      poNumber: suggestOrderNumber(westmark, state.orders),
      description: WORK,
      totalAmount: '84,000',
      taxTreatment: 'inclusive' as const,
    }
    const order = await createOrder(inputs, westmark)
    invoice.po_reference = order.po_number
    const outcome = await runInvoice(invoice.id, { explain: false, asOf: new Date('2026-09-18T00:00:00Z') })
    return { order, outcome }
  }

  it('clears on a clean match', async () => {
    const { outcome } = await raiseThenInvoice()
    expect(outcome.verdict).toBe('AUTO_APPROVE')
    expect(outcome.reasonCodes[0]).toBe('CLEAN_MATCH')
  })

  it('is matched to the order that was raised for it', async () => {
    const { order, outcome } = await raiseThenInvoice()
    expect(outcome.matchedPo).toBe(order.po_number)
  })

  it('was checked against the value that was typed, not against the invoice', async () => {
    const { outcome } = await raiseThenInvoice()
    const log = state.stageLogs.find((entry) => entry.run_id === outcome.run.id && entry.stage === 'validate')
    const report = log?.output as Record<string, { evidence?: Record<string, number> }>
    expect(report.cumulative_overage.evidence?.po_total).toBe(ORDER_VALUE)
    expect(report.cumulative_overage.evidence?.amount_billed_to_date).toBe(0)
  })

  it('records the order under the number the form suggested', async () => {
    const { order } = await raiseThenInvoice()
    expect(order.po_number).toBe('PO-WESTMA-001')
    expect(state.orders).toHaveLength(1)
  })

  it('refuses a second order under the same number', async () => {
    await raiseThenInvoice()
    const taken = {
      ...emptyNewOrder('2026-09-11'),
      vendorId: westmark.id,
      poNumber: 'PO-WESTMA-001',
      description: WORK,
      totalAmount: '10,000',
    }
    await expect(createOrder(taken, westmark)).rejects.toThrow()
    expect(state.orders).toHaveLength(1)
  })

  it('suggests the next number once one has been raised', async () => {
    await raiseThenInvoice()
    expect(suggestOrderNumber(westmark, state.orders)).toBe('PO-WESTMA-002')
  })
})
