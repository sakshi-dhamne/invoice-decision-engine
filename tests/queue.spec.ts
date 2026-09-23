// What belongs in the exceptions queue, what the trail says about a run, and the
// words the product uses for both.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { latestRunPerInvoice, needsAPerson, wasUploaded, type FeedRow } from '../src/lib/feed.ts'
import { approverOf } from '../src/lib/decisionData.ts'
import { modelLabel } from '../src/lib/format.ts'
import { checkLabel, checksThatObjected, objectionSentence } from '../src/lib/reasonCopy.ts'
import {
  describeFromLines,
  emptyOrderInputs,
  orderIsComplete,
  orderNumberFor,
  parseOrderValue,
} from '../src/lib/orderForm.ts'
import type { RunRow } from '../src/lib/database.types.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const run = (over: Partial<RunRow>): RunRow =>
  ({
    id: 'run-1',
    invoice_id: 'invoice-1',
    status: 'complete',
    verdict: 'HOLD',
    reason_codes: ['NO_PO_MATCH'],
    parent_run_id: null,
    changed_fields: null,
    matched_po: null,
    explanation: null,
    started_at: '2026-09-10T09:00:00Z',
    finished_at: '2026-09-10T09:00:04Z',
    touched_by_human: false,
    touched_by: null,
    discarded_at: null,
    discarded_by: null,
    ...over,
  }) as RunRow

// ---------------------------------------------------------------------------
// Only the latest run of a record is in the queue
// ---------------------------------------------------------------------------

describe('a superseded run is history, not an exception', () => {
  it('keeps only the newest run of an invoice record', () => {
    // Newest first, as the query returns them: the invoice was held, its vendor
    // was added, and the re-run blocked it. It is one invoice and it is blocked.
    const runs = [
      run({ id: 'run-new', invoice_id: 'ztr-1', verdict: 'BLOCK' }),
      run({ id: 'run-old', invoice_id: 'ztr-1', verdict: 'HOLD' }),
    ]
    const latest = latestRunPerInvoice(runs)
    expect(latest.map((entry) => entry.id)).toEqual(['run-new'])
  })

  it('keeps one run for each separate record that shares an invoice number', () => {
    // An uploaded copy is its own record. Both are real documents and both keep
    // their own latest run; collapsing them would hide the blocked copy behind
    // the original.
    const runs = [
      run({ id: 'run-copy', invoice_id: 'ztr-copy', verdict: 'BLOCK' }),
      run({ id: 'run-original-rerun', invoice_id: 'ztr-1', verdict: 'HOLD' }),
      run({ id: 'run-original-first', invoice_id: 'ztr-1', verdict: 'HOLD' }),
    ]
    expect(latestRunPerInvoice(runs).map((entry) => entry.id)).toEqual(['run-copy', 'run-original-rerun'])
  })

  it('keeps a run that is attached to no invoice record at all', () => {
    const orphan = run({ id: 'run-orphan', invoice_id: null })
    expect(latestRunPerInvoice([orphan])).toEqual([orphan])
  })
})

// ---------------------------------------------------------------------------
// A failed upload is not an exception
// ---------------------------------------------------------------------------

describe('what counts as needing a person', () => {
  it.each(['REVIEW', 'HOLD', 'BLOCK'] as const)('%s does', (verdict) => {
    expect(needsAPerson(run({ verdict }))).toBe(true)
  })

  it('an approved invoice does not', () => {
    expect(needsAPerson(run({ verdict: 'AUTO_APPROVE' }))).toBe(false)
  })

  it('a run that failed does not, because nothing was decided about it', () => {
    expect(needsAPerson(run({ status: 'failed', verdict: null }))).toBe(false)
  })

  it('a duplicate somebody has filed away does not', () => {
    expect(needsAPerson(run({ verdict: 'BLOCK', discarded_at: '2026-09-11T10:00:00Z' }))).toBe(false)
  })

  it('leaves the Failed filter on Invoices as the place those live', () => {
    const dashboard = readFileSync(join(repoRoot, 'src/pages/Dashboard.tsx'), 'utf8')
    expect(dashboard).toContain("{ value: 'failed', label: 'Failed' }")
    expect(dashboard).toContain("{ value: 'uploaded', label: 'Uploaded' }")
    // And the queue no longer offers it.
    const exceptions = readFileSync(join(repoRoot, 'src/pages/Exceptions.tsx'), 'utf8')
    expect(exceptions).not.toContain("value: 'failed'")
  })
})

describe('an uploaded document is an invoice with an origin, not a kind of its own', () => {
  const rowFor = (storagePath: string | null) =>
    ({ run: run({}), invoice: { storage_path: storagePath }, vendor: null, primaryCode: null, duplicateOf: null }) as unknown as FeedRow

  it('recognises one that was uploaded', () => {
    expect(wasUploaded(rowFor('uploads/1234-invoice.pdf'))).toBe(true)
  })

  it('does not call a seeded document uploaded', () => {
    expect(wasUploaded(rowFor(null))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The upload dialog holds this session and no other
// ---------------------------------------------------------------------------

describe('the upload dialog starts empty every time it is opened', () => {
  const source = readFileSync(join(repoRoot, 'src/components/UploadDialog.tsx'), 'utf8')

  it('clears the list on open rather than only on close', () => {
    expect(source).toContain('if (open && !busy.current) reset()')
    expect(source).toContain('}, [open, reset])')
  })

  it('does not clear a queue that is still working', () => {
    // Closing the dialog leaves the uploads running, so reopening it mid-queue
    // must not empty the list out from under them.
    expect(source).toContain('busy.current = running')
  })
})

// ---------------------------------------------------------------------------
// Who approved what
// ---------------------------------------------------------------------------

describe('an approver is only shown where somebody actually approved', () => {
  it('names the person who overrode the verdict', () => {
    expect(approverOf(run({ touched_by_human: true, touched_by: 'Asha Menon' }))).toBe('Asha Menon')
  })

  it('says nobody when nobody overrode it', () => {
    expect(approverOf(run({ touched_by_human: false, touched_by: null }))).toBeNull()
  })

  it('says nobody when the flag is set but no name was recorded', () => {
    // The shape the legacy rows are in. 011_override_names.sql clears them; this
    // is what the screen does in the meantime, and for any row that slips through.
    expect(approverOf(run({ touched_by_human: true, touched_by: null }))).toBeNull()
    expect(approverOf(run({ touched_by_human: true, touched_by: '   ' }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The words on the trail
// ---------------------------------------------------------------------------

describe('the checks stage names what objected', () => {
  it('says so plainly when nothing did', () => {
    expect(objectionSentence([])).toBe('Every check that applies to this invoice passed.')
  })

  it('names the one check that did', () => {
    expect(objectionSentence(['bank_account'])).toBe('One check objected: the bank account.')
  })

  it('names all of them rather than counting them', () => {
    const sentence = objectionSentence(['bank_account', 'invoice_date'])
    expect(sentence).toBe('Two checks objected: the bank account and the invoice date.')
    // The failure this replaces: a number and nothing a reader could act on.
    expect(sentence).not.toBe('2 checks objected.')
  })

  it('reads as a list once there are three', () => {
    expect(objectionSentence(['bank_account', 'invoice_date', 'currency'])).toBe(
      'Three checks objected: the bank account, the invoice date, and the currency.',
    )
  })

  it('finds the failures on a report without naming any check itself', () => {
    const report = {
      bank_account: { passed: false, code: 'BANK_DETAIL_MISMATCH' },
      currency: { passed: true },
      // A skipped check passes, and must not be reported as an objection.
      remit_to: { passed: true, evidence: { skipped: 'vendor unresolved' } },
      reconciliation: null,
      resubmission: null,
    }
    expect(checksThatObjected(report)).toEqual(['bank_account'])
  })

  it('has a plain name for every check on the report', () => {
    const checks = [
      'credit_note',
      'exact_duplicate',
      'bank_account',
      'remit_to',
      'vendor_status',
      'vendor_resolved',
      'po_status',
      'currency',
      'invoice_date',
      'required_fields',
      'arithmetic',
      'tax_treatment',
      'quantities',
      'unit_prices',
      'line_coverage',
      'threshold_split',
      'near_duplicate',
      'cumulative_overage',
    ]
    for (const check of checks) {
      const label = checkLabel(check)
      expect(label, check).not.toContain('_')
      expect(label.length, check).toBeGreaterThan(3)
    }
  })
})

describe('a model is named the way a person would write it', () => {
  it('drops the provider prefix the chain addresses it by', () => {
    expect(modelLabel('gemini:gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite')
    expect(modelLabel('anthropic:claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })

  it('leaves a bare model name alone', () => {
    expect(modelLabel('gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite')
  })

  it('says something rather than nothing when no model was recorded', () => {
    expect(modelLabel(null)).toBe('Not recorded')
  })
})

// ---------------------------------------------------------------------------
// Raising an order
// ---------------------------------------------------------------------------

describe('raising an order for a held invoice', () => {
  it('starts the order value empty, so it cannot come off the invoice', () => {
    expect(emptyOrderInputs('2026-09-20').totalAmount).toBe('')
  })

  it('will not save until somebody types a value', () => {
    const inputs = emptyOrderInputs('2026-09-20')
    expect(orderIsComplete(inputs, 'MER-1')).toBe(false)
    expect(orderIsComplete({ ...inputs, totalAmount: '84000' }, 'MER-1')).toBe(true)
  })

  it('will not save against a vendor we do not have', () => {
    expect(orderIsComplete({ ...emptyOrderInputs('2026-09-20'), totalAmount: '84000' }, null)).toBe(false)
  })

  it.each([
    ['84000', 84000],
    ['84,000', 84000],
    [' 84000 ', 84000],
    ['84000.50', 84000.5],
  ])('reads %s as an order value', (typed, expected) => {
    expect(parseOrderValue(typed)).toBe(expected)
  })

  it.each(['', '   ', 'nought', '0', '-500'])('refuses %s as an order value', (typed) => {
    expect(parseOrderValue(typed)).toBeNull()
  })

  it('prefills the description from the invoice lines, because a label is not a control', () => {
    expect(describeFromLines([{ description: 'Recycled Kraft Paper Reels' }, { description: 'Delivery' }])).toBe(
      'Recycled Kraft Paper Reels, Delivery',
    )
  })

  it('does not repeat a description that appears on several lines', () => {
    expect(describeFromLines([{ description: 'Consulting' }, { description: 'Consulting' }])).toBe('Consulting')
  })

  it('stops rather than producing a paragraph from a long invoice', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f'].map((description) => ({ description }))
    expect(describeFromLines(lines)).toBe('a, b, c, d, and more')
  })

  it('has nothing to say when the invoice described nothing', () => {
    expect(describeFromLines([])).toBe('')
    expect(describeFromLines(null)).toBe('')
    expect(describeFromLines([{ description: '  ' }])).toBe('')
  })

  it('derives a legible order number that cannot collide', () => {
    const first = orderNumberFor('Meridian Components Pvt Ltd', () => 0.111111)
    const second = orderNumberFor('Meridian Components Pvt Ltd', () => 0.999999)
    expect(first.startsWith('PO-MERIDI-')).toBe(true)
    expect(first).not.toBe(second)
  })

  it('still produces an order number for a vendor whose name has no letters', () => {
    expect(orderNumberFor('!!!', () => 0.5).startsWith('PO-ORDER-')).toBe(true)
  })
})
