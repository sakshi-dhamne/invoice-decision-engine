// Where a run stands, as a question about the run alone.
//
// These are the predicates every screen, the queue's counts and the pipeline's
// billing ledger all have to agree on: which run of a document is the current
// one, whether a person approved it, and what its outcome therefore is. They live
// in a module of their own because everything needs them and they need nothing:
// no database, no fetching, no other module of this app.

import type { RunRow, Verdict } from './database.types.ts'

/**
 * The most recent run of each invoice record.
 *
 * Keyed on the invoice record, not on the invoice number. An invoice re-run after
 * its vendor was onboarded has two runs, and the queue showed both, which is two
 * answers to one question. Only the latest is where the document stands; the
 * earlier ones are its History.
 *
 * Two separate records that happen to share an invoice number each keep their own
 * latest run, and that is deliberate. An uploaded copy of a document is a
 * different record from the original, both are real, and collapsing them on the
 * number would hide the copy that was blocked behind the original that was not.
 *
 * Takes runs already ordered newest first, which is how the query returns them.
 */
export function latestRunPerInvoice(runs: readonly RunRow[]): RunRow[] {
  const seen = new Set<string>()
  const latest: RunRow[] = []
  for (const run of runs) {
    const record = run.invoice_id ?? run.id
    if (seen.has(record)) continue
    seen.add(record)
    latest.push(run)
  }
  return latest
}

export function hasFailed(run: Pick<RunRow, 'status'>): boolean {
  return run.status === 'failed'
}

export function wasDiscarded(run: Pick<RunRow, 'discarded_at'>): boolean {
  return run.discarded_at !== null
}

// The three verdicts that put a document in front of a person.
export const NEEDS_A_PERSON: readonly Verdict[] = ['REVIEW', 'HOLD', 'BLOCK']

/**
 * Whether a person has approved this invoice over the rules.
 *
 * Both halves are required, the same test the History tab uses: a flag with no
 * name against it names nobody, and an approval nobody will own is an approval
 * nobody made.
 */
export function approvedByPerson(run: Pick<RunRow, 'touched_by_human' | 'touched_by'>): boolean {
  return run.touched_by_human && (run.touched_by?.trim().length ?? 0) > 0
}

/**
 * The outcome, as opposed to the record.
 *
 * `runs.verdict` is what the rules decided and is never rewritten: it is the whole
 * point of the system that what was caught stays visible, including when it was
 * overruled. But once a person has approved an invoice, the invoice is approved,
 * and every screen that answers "where does this stand" has to say so. Recording
 * the approver and then leaving the invoice reading Held in the exceptions queue
 * was not a halfway position, it was the approval failing to do anything.
 *
 * So the record and the outcome are two questions, and this answers the second.
 * Who approved it is shown wherever the outcome is, so nobody reads it as the
 * rules having cleared something they did not.
 */
export function effectiveVerdict(run: Pick<RunRow, 'touched_by_human' | 'touched_by' | 'verdict'>): Verdict | null {
  return approvedByPerson(run) ? 'AUTO_APPROVE' : run.verdict
}

/**
 * Whether the invoice is approved as things stand, by the rules or by a person.
 *
 * This is the test the billing ledger uses: an approved invoice's value is
 * committed against the order it bills, and anything else is not. A document
 * somebody filed away is not an approval of it.
 */
export function isApproved(run: Pick<RunRow, 'touched_by_human' | 'touched_by' | 'verdict' | 'discarded_at'> | null): boolean {
  if (!run || wasDiscarded(run)) return false
  return effectiveVerdict(run) === 'AUTO_APPROVE'
}

/**
 * Whether this run is an open exception.
 *
 * An exception is a decision that needs a person. Three things are not one: a run
 * that failed outright, because nothing was decided about it and nothing on the
 * queue's screen applies; a run somebody has already discarded; and a run a person
 * has already approved, because it has had the person it needed.
 */
export function needsAPerson(run: RunRow): boolean {
  if (wasDiscarded(run) || hasFailed(run) || approvedByPerson(run)) return false
  const verdict = effectiveVerdict(run)
  return run.status === 'complete' && verdict !== null && NEEDS_A_PERSON.includes(verdict)
}
