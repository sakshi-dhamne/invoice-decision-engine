// The corpus, with every approved invoice counting against its order.
//
// Deriving what an order has been billed changes what later invoices are measured
// against, so it is a change to the engine's inputs and not only to a screen. The
// 27 fixtures are the standing answer to "does the engine still decide correctly",
// and the per-fixture suite decides each one against a fixed set of orders.
//
// This is the other question: replayed in receipt order, with each approval
// committed against its order the way the live pipeline commits it, does the
// corpus still reach the same 27 verdicts? Three orders in the corpus carry more
// than one invoice, and one of them is billed to its exact value by three
// milestone invoices, so the answer is not obvious by inspection.

import { describe, expect, it } from 'vitest'

import type { BilledDocument } from '../src/rules/billing.ts'
import { corpusInReceiptOrder, purchaseOrders } from './fixtures.ts'
import { runCorpusPass, type CorpusOutcome, type CorpusReplayState } from './harness.ts'

/** Replays the corpus, committing each approval against its order as it goes. */
function replayWithBilling(): Map<string, CorpusOutcome> {
  const results = new Map<string, CorpusOutcome>()
  const billed: BilledDocument[] = []
  let state: CorpusReplayState | undefined

  for (const document of corpusInReceiptOrder) {
    const pass = runCorpusPass({
      documents: [document],
      // What the orders have been billed by everything approved so far. The
      // document being decided is left out of its own ledger by its own id,
      // exactly as the pipeline leaves it out.
      billed,
      seed: state,
    })
    state = pass.state

    const outcome = pass.results.get(document.id)
    if (!outcome) throw new Error(`no outcome for ${document.id}`)
    results.set(document.id, outcome)

    billed.push({
      invoice_id: document.id,
      po_number: outcome.poMatch.matched?.po_number ?? null,
      amount: document.facts.total,
      approved: outcome.decision.verdict === 'AUTO_APPROVE',
    })
  }

  return results
}

const replayed = replayWithBilling()

describe('the corpus with approvals counting against their orders', () => {
  it.each(corpusInReceiptOrder.map((document) => [document.id, document.expected_verdict] as const))(
    '%s still produces %s',
    (id, expected) => {
      expect(replayed.get(id)?.decision.verdict).toBe(expected)
    },
  )

  it('decides all 27', () => {
    expect(replayed.size).toBe(27)
  })
})

describe('what the replay actually committed', () => {
  // Without this the test above could pass by the billing never being threaded
  // at all, which is the thing it exists to check.
  const approved = corpusInReceiptOrder.filter(
    (document) => replayed.get(document.id)?.decision.verdict === 'AUTO_APPROVE',
  )

  it('approved some invoices, so something was committed', () => {
    expect(approved.length).toBeGreaterThan(0)
  })

  it('billed at least one order with more than one approved invoice against it', () => {
    const tally = new Map<string, number>()
    for (const document of approved) {
      const po = replayed.get(document.id)?.poMatch.matched?.po_number
      if (po) tally.set(po, (tally.get(po) ?? 0) + 1)
    }
    expect([...tally.values()].some((invoices) => invoices > 1)).toBe(true)
  })

  it('leaves an order billed to its exact value inside its tolerance', () => {
    // A milestone schedule that adds up to the order is the case this change
    // could plausibly have broken: the last invoice of the set is measured
    // against a remaining balance of nothing.
    for (const po of purchaseOrders) {
      const billed = approved
        .filter((document) => replayed.get(document.id)?.poMatch.matched?.po_number === po.po_number)
        .reduce((total, document) => total + (document.facts.total ?? 0), 0)
      if (billed === 0 || po.total_amount === null) continue
      expect(billed, po.po_number).toBeLessThanOrEqual(po.total_amount)
    }
  })
})
