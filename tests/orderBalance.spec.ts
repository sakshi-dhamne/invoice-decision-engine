// An approved invoice counts against the order it bills.
//
// Several invoices could each pass on their own and overdraw one purchase order
// between them, which is exactly the failure the cumulative check exists to
// prevent. It could not prevent it, because what the order had been billed was
// read off a column nothing ever wrote to: every invoice was measured against the
// order's full value, however many had already been paid out of it.
//
// What has been billed is now derived from the invoices themselves, so the
// awkward half is correct without being maintained: an invoice that is later
// held, blocked or filed away stops counting the moment it stops being approved,
// because nothing was ever added to a running total that would have to be taken
// back out.
//
// This drives the real `runInvoice` against stubbed I/O, the same way
// duplicateCost.spec.ts does, so what is asserted is the engine's behaviour
// rather than the wiring.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  InvoiceRow,
  PurchaseOrderRow,
  RunRow,
  StageLogRow,
  VendorRow,
} from '../src/lib/database.types.ts'

// ---------------------------------------------------------------------------
// One vendor, one order, three invoices against it
// ---------------------------------------------------------------------------

const BANK = '778899001122334'
const WORK = 'Site preparation and groundworks'

const vendor: VendorRow = {
  id: 'VX1',
  legal_name: 'Westmark Industrial Supplies Pvt Ltd',
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
}

// Three invoices against an order of 300,000. Each one is below the limit for
// approving without a person, so nothing stops them individually; the first two
// use the order up between them, and the third takes it past its value.
//
// The amounts differ and the dates are three weeks apart on purpose. Three
// invoices of one amount in quick succession is a different finding, and this is
// a test of the arithmetic rather than of the duplicate and split checks.
const ORDER_VALUE = 300_000
const FIRST_TOTAL = 150_000
const SECOND_TOTAL = 120_000
const THIRD_TOTAL = 90_000

const order: PurchaseOrderRow = {
  po_number: 'WX-4400',
  vendor_id: vendor.id,
  total_amount: ORDER_VALUE,
  currency: 'INR',
  // The opening balance: what had been billed before any of this was recorded
  // here. Nothing writes to it, and the derivation adds to it rather than
  // replacing it.
  amount_billed_to_date: 0,
  tax_treatment: 'inclusive',
  status: 'open',
  line_items: [{ description: WORK, quantity: 1, unit_price: ORDER_VALUE, amount: ORDER_VALUE }],
  delivery_schedule: null,
  issued_date: '2026-08-01',
  created_at: '2026-08-01T00:00:00Z',
}

function invoiceRow(suffix: string, day: string, total: number, over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: `invoice-${suffix}`,
    invoice_number: `WX/2026/${suffix}`,
    file_path: `fixtures/pdfs/${suffix}.pdf`,
    storage_path: null,
    file_hash: null,
    vendor_name_as_printed: vendor.legal_name,
    vendor_id: null,
    po_reference: order.po_number,
    invoice_date: day,
    currency: 'INR',
    subtotal: null,
    tax: null,
    total,
    bank_account_printed: BANK,
    remit_to_name: vendor.legal_name,
    document_type: 'invoice',
    line_items: null,
    extraction_confidence: null,
    parent_invoice_number: null,
    notes_field: null,
    expected_verdict: null,
    fields_not_printed: null,
    created_at: `${day}T09:00:00Z`,
    ...over,
  }
}

const first = invoiceRow('0101', '2026-07-01', FIRST_TOTAL)
const second = invoiceRow('0102', '2026-07-22', SECOND_TOTAL)
const third = invoiceRow('0103', '2026-08-12', THIRD_TOTAL)

const state = {
  invoices: [first, second, third] as InvoiceRow[],
  runs: [] as RunRow[],
  stageLogs: [] as StageLogRow[],
}

// Each document is read as what it prints. The bank account is the vendor's, so
// nothing here is stopped by anything but the arithmetic against the order.
vi.mock('../src/lib/extraction.ts', () => ({
  getOrExtract: async (invoiceId: string) => {
    const invoice = state.invoices.find((row) => row.id === invoiceId)
    if (!invoice) throw new Error(`no invoice ${invoiceId}`)
    return {
      data: {
        invoice_number: invoice.invoice_number,
        invoice_date: invoice.invoice_date,
        vendor_name: invoice.vendor_name_as_printed,
        po_reference: invoice.po_reference,
        currency: 'INR',
        line_items: [{ description: WORK, quantity: 1, unit_price: invoice.total, amount: invoice.total }],
        subtotal: null,
        tax: null,
        total: invoice.total,
        bank_account: invoice.bank_account_printed,
        bank_ifsc: null,
        remit_to_name: invoice.remit_to_name,
        document_type: 'invoice' as const,
        notes: null,
        confidence: {},
        unreadable_fields: ['subtotal', 'tax'],
        extraction_notes: null,
      },
      model: 'stub',
      duration_ms: 1,
      fromCache: true,
      extractedAt: '2026-09-01T09:00:02Z',
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
  // The real thresholds. Nothing in this file tunes a rule.
  const { rules } = await import('./fixtures.ts')
  const ruleRows = Object.fromEntries(
    Object.entries(rules).map(([key, value]) => [key, { key, value, unit: null, description: null, updated_at: '' }]),
  )

  return {
    getRules: async () => ruleRows,
    getVendors: async () => [vendor],
    getPurchaseOrders: async () => [order],
    getInvoices: async () => state.invoices,
    getInvoiceById: async (id: string) => state.invoices.find((row) => row.id === id) ?? null,
    getCompletedRuns: async () => state.runs.filter((run) => run.status === 'complete'),
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
    logStage: async (runId: string, stage: string, order_: number, status: string) => {
      const log = {
        id: `stage-${state.stageLogs.length + 1}`,
        run_id: runId,
        stage,
        stage_order: order_,
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

// Every document is a different file, so nothing here is an exact duplicate.
vi.stubGlobal('fetch', async (url: string) => ({
  ok: true,
  headers: { get: () => 'application/pdf' },
  arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer,
}))

const { runInvoice, toPurchaseOrderRecord } = await import('../src/lib/pipeline.ts')
const { approvedAgainst, withApprovedBilling } = await import('../src/rules/billing.ts')

// What the cumulative check measured, off the run's own validate log. This is the
// figure the invoice was actually decided against.
function cumulativeEvidence(runId: string): Record<string, number> {
  const log = state.stageLogs.find((entry) => entry.run_id === runId && entry.stage === 'validate')
  const report = log?.output as Record<string, { evidence?: Record<string, number> }> | null
  return report?.cumulative_overage?.evidence ?? {}
}

function reset() {
  state.runs.length = 0
  state.stageLogs.length = 0
  for (const invoice of state.invoices) invoice.file_hash = null
}

// ---------------------------------------------------------------------------
// The behaviour the brief asks for
// ---------------------------------------------------------------------------

describe('an approved invoice reduces what the order has left', () => {
  beforeEach(reset)

  it('measures the first invoice against the whole order', async () => {
    const outcome = await runInvoice(first.id, { explain: false })
    expect(outcome.verdict).toBe('AUTO_APPROVE')
    expect(cumulativeEvidence(outcome.run.id).amount_billed_to_date).toBe(0)
  })

  it('measures the next invoice against what is left of it', async () => {
    const one = await runInvoice(first.id, { explain: false })
    expect(one.verdict).toBe('AUTO_APPROVE')

    const two = await runInvoice(second.id, { explain: false })
    const evidence = cumulativeEvidence(two.run.id)

    // The first invoice was approved, so its value is committed against the order
    // and the second is measured against the remainder.
    expect(evidence.amount_billed_to_date).toBe(FIRST_TOTAL)
    expect(evidence.this_invoice).toBe(SECOND_TOTAL)
    expect(evidence.cumulative).toBe(FIRST_TOTAL + SECOND_TOTAL)
  })

  it('stops the invoice that would take the order past its value', async () => {
    await runInvoice(first.id, { explain: false })
    await runInvoice(second.id, { explain: false })
    const three = await runInvoice(third.id, { explain: false })

    expect(cumulativeEvidence(three.run.id).amount_billed_to_date).toBe(FIRST_TOTAL + SECOND_TOTAL)
    expect(three.reasonCodes).toContain('PO_OVERAGE')
    expect(three.verdict).toBe('REVIEW')
  })

  it('counts a person\'s approval exactly as it counts the rules\'', async () => {
    const one = await runInvoice(first.id, { explain: false })

    // The rules did approve it, so take that away and leave only the person: the
    // run reads as blocked, with somebody's name against it.
    const run = state.runs.find((entry) => entry.id === one.run.id)
    Object.assign(run as RunRow, {
      verdict: 'BLOCK',
      reason_codes: ['BANK_DETAIL_MISMATCH'],
      touched_by_human: true,
      touched_by: 'Priya Raghavan',
      approved_at: '2026-09-05T10:00:00Z',
    })

    const two = await runInvoice(second.id, { explain: false })
    expect(cumulativeEvidence(two.run.id).amount_billed_to_date).toBe(FIRST_TOTAL)
  })

  it('does not count an invoice the rules stopped and nobody passed', async () => {
    const one = await runInvoice(first.id, { explain: false })
    Object.assign(state.runs.find((entry) => entry.id === one.run.id) as RunRow, {
      verdict: 'HOLD',
      reason_codes: ['NO_PO_MATCH'],
    })

    const two = await runInvoice(second.id, { explain: false })
    expect(cumulativeEvidence(two.run.id).amount_billed_to_date).toBe(0)
  })

  it('stops counting one that was approved and has since been filed away', async () => {
    const one = await runInvoice(first.id, { explain: false })
    Object.assign(state.runs.find((entry) => entry.id === one.run.id) as RunRow, {
      discarded_at: '2026-09-06T09:00:00Z',
      discarded_by: 'Priya Raghavan',
    })

    const two = await runInvoice(second.id, { explain: false })
    expect(cumulativeEvidence(two.run.id).amount_billed_to_date).toBe(0)
  })

  it('never measures an invoice against itself', async () => {
    await runInvoice(first.id, { explain: false })
    // Approved, and run again. Its own value must not appear as something already
    // billed, or re-running an approved invoice would eventually overdraw the
    // order on its own.
    const again = await runInvoice(first.id, { explain: false })
    expect(cumulativeEvidence(again.run.id).amount_billed_to_date).toBe(0)
    expect(again.verdict).toBe('AUTO_APPROVE')
  })

  it('reads only the latest run of a document, not every run it has had', async () => {
    await runInvoice(first.id, { explain: false })
    const one = await runInvoice(first.id, { explain: false })
    Object.assign(state.runs.find((entry) => entry.id === one.run.id) as RunRow, {
      verdict: 'HOLD',
      reason_codes: ['NO_PO_MATCH'],
    })

    // Approved once and held on the re-run: where it stands is held, so nothing
    // of it is committed.
    const two = await runInvoice(second.id, { explain: false })
    expect(cumulativeEvidence(two.run.id).amount_billed_to_date).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The arithmetic on its own
// ---------------------------------------------------------------------------

describe('what an order has been billed', () => {
  const documents = [
    { invoice_id: 'a', po_number: 'WX-4400', amount: 40_000, approved: true },
    { invoice_id: 'b', po_number: 'WX-4400', amount: 25_000, approved: false },
    { invoice_id: 'c', po_number: 'WX-9999', amount: 90_000, approved: true },
    { invoice_id: 'd', po_number: null, amount: 10_000, approved: true },
    { invoice_id: 'e', po_number: 'WX-4400', amount: null, approved: true },
  ]

  it('adds up the approved invoices against that order and nothing else', () => {
    expect(approvedAgainst('WX-4400', documents)).toBe(40_000)
  })

  it('matches the order number however it was cased or spaced', () => {
    // The same comparison the split check uses, so an order is one order to both.
    expect(approvedAgainst('  wx-4400 ', documents)).toBe(40_000)
  })

  it('leaves out the document being decided', () => {
    expect(approvedAgainst('WX-4400', documents, 'a')).toBe(0)
  })

  it('counts nothing against an order nobody has billed', () => {
    expect(approvedAgainst('WX-0000', documents)).toBe(0)
  })

  it('adds what was approved to the opening balance rather than replacing it', () => {
    const [adjusted] = withApprovedBilling([toPurchaseOrderRecord({ ...order, amount_billed_to_date: 12_000 })], documents)
    expect(adjusted.amount_billed_to_date).toBe(52_000)
  })

  it('leaves an order with no approved invoices exactly as it was', () => {
    const [adjusted] = withApprovedBilling(
      [toPurchaseOrderRecord({ ...order, po_number: 'WX-0000', amount_billed_to_date: 7_000 })],
      documents,
    )
    expect(adjusted.amount_billed_to_date).toBe(7_000)
  })
})
