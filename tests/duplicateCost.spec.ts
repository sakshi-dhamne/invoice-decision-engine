// What a duplicate costs.
//
// The point of moving the file-hash check into stage 1 is that recognising a
// document we have already been through should cost a hash and nothing else. It
// used to cost a full extraction: the model read a page we had already read, took
// sixteen seconds over it, and then the rules blocked the result anyway. Money
// spent to learn nothing, and a demo nobody wants to run live.
//
// So this drives the real `runInvoice` against stubbed I/O and asserts the two
// things that actually matter: the extraction is never called, and the whole run
// finishes in well under a second.
//
// Everything the pipeline touches outside itself is stubbed here. That is the
// point of the file: it is a test of the pipeline's shape, not of Supabase.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InvoiceRow, RunRow, StageLogRow } from '../src/lib/database.types.ts'

// ---------------------------------------------------------------------------
// The world the pipeline runs against
// ---------------------------------------------------------------------------

const FILE_BYTES = new TextEncoder().encode('a pretend invoice, identical both times').buffer

const original: InvoiceRow = {
  id: 'invoice-original',
  invoice_number: 'MER/2026/0044',
  file_path: 'fixtures/pdfs/meridian.pdf',
  storage_path: null,
  file_hash: null,
  vendor_name_as_printed: 'Meridian Components Pvt Ltd',
  vendor_id: null,
  po_reference: null,
  invoice_date: '2026-09-01',
  currency: 'INR',
  subtotal: null,
  tax: null,
  total: 84000,
  bank_account_printed: null,
  remit_to_name: null,
  document_type: 'invoice',
  line_items: null,
  extraction_confidence: null,
  parent_invoice_number: null,
  notes_field: null,
  expected_verdict: null,
  fields_not_printed: null,
  created_at: '2026-09-01T09:00:00Z',
}

// The same file, uploaded again a fortnight later under whatever name the mail
// client gave it.
const copy: InvoiceRow = {
  ...original,
  id: 'invoice-copy',
  invoice_number: 'forwarded-again.pdf',
  file_path: 'uploads/forwarded-again.pdf',
  storage_path: 'uploads/forwarded-again.pdf',
  created_at: '2026-09-15T16:00:00Z',
}

const state = {
  invoices: [original, copy] as InvoiceRow[],
  runs: [] as RunRow[],
  stageLogs: [] as StageLogRow[],
}

let extractionCalls = 0
let explainCalls = 0
let fetchCalls = 0

const getOrExtract = vi.fn(async () => {
  extractionCalls += 1
  // A real extraction is a network round trip and a model call. Standing in for
  // the cheapest plausible version of that still dwarfs a hash.
  await new Promise((resolve) => setTimeout(resolve, 25))
  return {
    data: {
      invoice_number: original.invoice_number,
      invoice_date: original.invoice_date,
      vendor_name: original.vendor_name_as_printed,
      po_reference: null,
      currency: 'INR',
      line_items: [],
      subtotal: null,
      tax: null,
      total: original.total,
      bank_account: null,
      bank_ifsc: null,
      remit_to_name: null,
      document_type: 'invoice' as const,
      notes: null,
      confidence: {},
      unreadable_fields: [],
      extraction_notes: null,
    },
    model: 'gemini-3.5-flash-lite',
    duration_ms: 25,
    fromCache: false,
    extractedAt: '2026-09-01T09:00:02Z',
  }
})

vi.mock('../src/lib/extraction.ts', () => ({
  getOrExtract: (...args: unknown[]) => getOrExtract(...(args as [])),
  documentFromBytes: (buffer: ArrayBuffer) => ({ base64: String(buffer.byteLength), mimeType: 'application/pdf' }),
}))

vi.mock('../src/lib/uploads.ts', () => ({
  UPLOAD_BUCKET: 'invoices',
  describeUploadedInvoice: vi.fn(async () => undefined),
}))

vi.mock('../src/lib/supabase.ts', () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://stub/${path}` } }) }) },
    functions: {
      invoke: async () => {
        explainCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { data: { ok: true, explanation: 'A sentence.', model: 'gemini-3.5-flash-lite', provider: 'gemini' }, error: null }
      },
    },
  },
}))

vi.mock('../src/lib/queries.ts', async () => {
  // The real thresholds, so the rules engine behaves exactly as it does anywhere
  // else. Nothing in this file tunes a rule.
  const { rules } = await import('./fixtures.ts')
  const ruleRows = Object.fromEntries(
    Object.entries(rules).map(([key, value]) => [key, { key, value, unit: null, description: null, updated_at: '' }]),
  )

  return {
  getRules: async () => ruleRows,
  getVendors: async () => [],
  getPurchaseOrders: async () => [],
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

// The document itself. A fetch is the one real cost stage 1 has, and both copies
// of the file return the same bytes, which is what makes them the same document.
vi.stubGlobal('fetch', async () => {
  fetchCalls += 1
  return {
    ok: true,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => FILE_BYTES,
  }
})

const { runInvoice, PIPELINE_STAGES } = await import('../src/lib/pipeline.ts')

// ---------------------------------------------------------------------------

describe('a duplicate is recognised before the document is read', () => {
  beforeEach(() => {
    extractionCalls = 0
    explainCalls = 0
    fetchCalls = 0
  })

  it('reads the original once, as it has to', async () => {
    const outcome = await runInvoice(original.id, { explain: false })
    expect(extractionCalls).toBe(1)
    expect(outcome.run.status).toBe('complete')
  })

  it('costs the copy no extraction at all', async () => {
    const outcome = await runInvoice(copy.id, { explain: false })

    expect(extractionCalls).toBe(0)
    expect(outcome.verdict).toBe('BLOCK')
    expect(outcome.reasonCodes).toEqual(['EXACT_DUPLICATE'])
  })

  it('finishes the copy in well under a second', async () => {
    const startedAt = performance.now()
    await runInvoice(copy.id, { explain: false })
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })

  it('never reads the document, so nothing after ingest ran', async () => {
    state.stageLogs.length = 0
    await runInvoice(copy.id, { explain: false })

    const ingest = state.stageLogs.filter((log) => log.stage === 'ingest')
    expect(ingest).toHaveLength(1)

    // Every later stage is recorded as pending rather than left absent: a reader
    // should see that we chose not to read the document, not wonder what broke.
    for (const stage of PIPELINE_STAGES) {
      if (stage === 'ingest') continue
      const logged = state.stageLogs.filter((log) => log.stage === stage)
      expect(logged, stage).toHaveLength(1)
      expect(logged[0].status, stage).toBe('pending')
    }
  })

  it('says which invoice the copy repeats, without having read it', async () => {
    state.stageLogs.length = 0
    await runInvoice(copy.id, { explain: false })
    const ingest = state.stageLogs.find((log) => log.stage === 'ingest')
    expect((ingest?.output as Record<string, unknown>)?.duplicate_of).toBe(original.invoice_number)
  })

  it('does not fetch the file again once it has been fingerprinted', async () => {
    // Both documents were hashed by the runs above, so a further run of either has
    // nothing to download at stage 1.
    fetchCalls = 0
    await runInvoice(copy.id, { explain: false })
    expect(fetchCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The explanation is not on the critical path
// ---------------------------------------------------------------------------

describe('the verdict does not wait for the explanation', () => {
  beforeEach(() => {
    extractionCalls = 0
    explainCalls = 0
  })

  it('completes the run before stage 7 has answered', async () => {
    const outcome = await runInvoice(original.id, {})

    // The run is already complete and already carries an explanation, written
    // from the decision itself.
    expect(outcome.run.status).toBe('complete')
    expect(outcome.explanation.length).toBeGreaterThan(0)
    expect(outcome.explanationSource).toBe('fallback')

    // And the model's wording replaces it afterwards.
    const settled = await outcome.explanationSettled
    expect(settled.source).toBe('model')
    expect(settled.explanation).toBe('A sentence.')
    expect(explainCalls).toBe(1)
  })
})
