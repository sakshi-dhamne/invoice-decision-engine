// Duplicate detection, and the two properties it has to have.
//
// The rule is cheap and it is easy to get subtly wrong, because both documents in
// a pair look identical to it. What separates them is which one arrived first, and
// nothing else. These tests hold that down:
//
//  - deciding a document again never changes what it was;
//  - a copy is blocked, and the original it copies never is.

import { describe, expect, it } from 'vitest'

import { decideInvoice } from '../src/rules/decide.ts'
import { findExactDuplicate } from '../src/rules/validate.ts'
import type { PriorRunHash } from '../src/rules/validate.ts'
import { selectPriorHashes, type ArrivalRecord, type CompletedRunRecord } from '../src/lib/pipeline.ts'
import { corpusInReceiptOrder, ledger, purchaseOrders, rules, vendors } from './fixtures.ts'
import { AS_OF, runCorpusPass } from './harness.ts'

// ---------------------------------------------------------------------------
// Arrival order
// ---------------------------------------------------------------------------

const arrival = (id: string, number: string, hash: string, at: string): ArrivalRecord => ({
  id,
  invoice_number: number,
  file_hash: hash,
  created_at: at,
})

const completed = (id: string, invoiceId: string, at: string): CompletedRunRecord => ({
  id,
  invoice_id: invoiceId,
  finished_at: at,
})

describe('a document is only ever compared against earlier arrivals', () => {
  const original = arrival('doc-1', 'INV-1', 'sha256:same', '2026-09-01T09:00:00Z')
  const copy = arrival('doc-2', 'a-phone-photo.pdf', 'sha256:same', '2026-09-05T14:00:00Z')
  const documents = [original, copy]

  it('gives the copy the original to match against', () => {
    const runs = [completed('run-1', 'doc-1', '2026-09-01T09:00:04Z')]
    const prior = selectPriorHashes(copy, documents, runs)
    expect(prior.map((entry) => entry.invoice_number)).toEqual(['INV-1'])
    expect(findExactDuplicate('sha256:same', prior)?.invoice_number).toBe('INV-1')
  })

  it('gives the original nothing, even once the copy has been decided', () => {
    const runs = [
      completed('run-1', 'doc-1', '2026-09-01T09:00:04Z'),
      completed('run-2', 'doc-2', '2026-09-05T14:00:03Z'),
    ]
    const prior = selectPriorHashes(original, documents, runs)
    expect(prior).toEqual([])
    expect(findExactDuplicate('sha256:same', prior)).toBeNull()
  })

  it('still gives the original nothing when it is decided a second time', () => {
    // Two runs of the original and one of the copy, the original's re-run last.
    const runs = [
      completed('run-1', 'doc-1', '2026-09-01T09:00:04Z'),
      completed('run-2', 'doc-2', '2026-09-05T14:00:03Z'),
      completed('run-3', 'doc-1', '2026-09-06T11:00:02Z'),
    ]
    expect(selectPriorHashes(original, documents, runs)).toEqual([])
    // And the copy keeps pointing at the original, not at the original's re-run.
    expect(selectPriorHashes(copy, documents, runs).map((entry) => entry.run_id)).toEqual(['run-1'])
  })

  it('never lets a document be its own duplicate', () => {
    const runs = [completed('run-1', 'doc-1', '2026-09-01T09:00:04Z')]
    expect(selectPriorHashes(original, [original], runs)).toEqual([])
  })

  it('orders two documents that arrived in the same instant, deterministically', () => {
    // A seeded corpus inserts every row in one statement, so their timestamps are
    // identical. Whichever is first has to stay first.
    const a = arrival('doc-a', 'INV-A', 'sha256:twin', '2026-09-01T09:00:00Z')
    const b = arrival('doc-b', 'INV-B', 'sha256:twin', '2026-09-01T09:00:00Z')
    const runs = [completed('run-a', 'doc-a', 'x'), completed('run-b', 'doc-b', 'y')]
    expect(selectPriorHashes(b, [a, b], runs).map((entry) => entry.invoice_number)).toEqual(['INV-A'])
    expect(selectPriorHashes(a, [a, b], runs)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The corpus, decided twice
// ---------------------------------------------------------------------------

// A replay has to be idempotent. Every fixture carries a distinct file, so no
// fixture is a duplicate of another, and deciding the lot a second time must not
// invent one. This runs the whole corpus through the engine twice, the second pass
// on top of everything the first left behind, lineage included.
describe('deciding every document twice changes nothing', () => {
  const first = runCorpusPass()
  const second = runCorpusPass({ seed: first.state })

  it('matches the expected verdict on the first pass', () => {
    expect(first.results.size).toBe(27)
    for (const [id, outcome] of first.results) {
      expect(outcome.decision.verdict, id).toBe(outcome.document.expected_verdict)
    }
  })

  it('matches the expected verdict again on the second', () => {
    expect(second.results.size).toBe(27)
    for (const [id, outcome] of second.results) {
      expect(outcome.decision.verdict, id).toBe(outcome.document.expected_verdict)
    }
  })

  it('reaches the identical verdict and reasons for every document', () => {
    for (const [id, outcome] of first.results) {
      const again = second.results.get(id)
      expect(again?.decision.verdict, id).toBe(outcome.decision.verdict)
      expect(again?.decision.reason_codes, id).toEqual(outcome.decision.reason_codes)
    }
  })

  it('calls nothing a duplicate of itself', () => {
    for (const [id, outcome] of second.results) {
      expect(outcome.decision.reason_codes, id).not.toContain('EXACT_DUPLICATE')
    }
  })
})

// ---------------------------------------------------------------------------
// A copy of a real fixture
// ---------------------------------------------------------------------------

describe('uploading a copy blocks the copy and not the original', () => {
  // The first document in receipt order, and a second arrival of the same file.
  const subject = corpusInReceiptOrder[0]

  const original: ArrivalRecord = {
    id: subject.id,
    invoice_number: subject.facts.invoice_number ?? subject.id,
    file_hash: subject.facts.file_hash,
    created_at: '2026-09-01T09:00:00Z',
  }
  const copy: ArrivalRecord = {
    id: 'uploaded-copy',
    invoice_number: 'someone-emailed-this.pdf',
    file_hash: subject.facts.file_hash,
    created_at: '2026-09-18T16:00:00Z',
  }

  const documents = [original, copy]
  const runs = [completed('run-original', original.id, '2026-09-01T09:00:04Z')]

  const decide = (priorHashes: PriorRunHash[]) =>
    decideInvoice({
      facts: subject.facts,
      vendors,
      purchaseOrders,
      rules,
      asOf: AS_OF,
      submissionId: copy.id,
      submissions: ledger,
      priorHashes,
      parentRun: null,
    }).decision

  it('blocks the copy, and says nothing else about it', () => {
    const decision = decide(selectPriorHashes(copy, documents, runs))
    expect(decision.verdict).toBe('BLOCK')
    expect(decision.primary).toBe('EXACT_DUPLICATE')
    expect(decision.reason_codes).toEqual(['EXACT_DUPLICATE'])
  })

  it('names the invoice the copy repeats, so the reader can go and look', () => {
    const prior = selectPriorHashes(copy, documents, runs)
    const hit = findExactDuplicate(copy.file_hash, prior)
    expect(hit?.invoice_number).toBe(original.invoice_number)
    expect(hit?.run_id).toBe('run-original')
    expect(hit?.decided_at).toBe('2026-09-01T09:00:04Z')
  })

  it('leaves the original at the verdict it already had', () => {
    const withCopyDecided = [...runs, completed('run-copy', copy.id, '2026-09-18T16:00:02Z')]
    const decision = decideInvoice({
      facts: subject.facts,
      vendors,
      purchaseOrders,
      rules,
      asOf: AS_OF,
      submissionId: original.id,
      submissions: ledger,
      priorHashes: selectPriorHashes(original, documents, withCopyDecided),
      parentRun: null,
    }).decision

    expect(decision.verdict).toBe(subject.expected_verdict)
    expect(decision.reason_codes).not.toContain('EXACT_DUPLICATE')
  })
})
