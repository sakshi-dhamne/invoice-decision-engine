// Runs corpus documents through stages 3-6 in receipt order, threading the
// cross-invoice context (prior runs, file hashes, resubmission parents) the way
// pipeline.ts does against the database.

import { decideInvoice } from '../src/rules/decide.ts'
import type { EngineResult } from '../src/rules/decide.ts'
import type { PriorRunHash } from '../src/rules/validate.ts'
import type { PriorRun, ReasonCode, SubmissionRecord, VendorRecord, PurchaseOrderRecord, RuleSet } from '../src/rules/types.ts'
import type { BilledDocument } from '../src/rules/billing.ts'
import { corpusInReceiptOrder, ledger, purchaseOrders, rules, vendors, type CorpusDocument } from './fixtures.ts'

// A fixed clock: a date-sensitive rule must not make the suite depend on when it
// is run. Two days after the newest document in the corpus.
export const AS_OF = new Date('2026-09-18T00:00:00Z')

export interface CorpusOutcome extends EngineResult {
  document: CorpusDocument
}

export interface CorpusRunOptions {
  vendors?: readonly VendorRecord[]
  purchaseOrders?: readonly PurchaseOrderRecord[]
  submissions?: readonly SubmissionRecord[]
  rules?: RuleSet
  asOf?: Date
  documents?: readonly CorpusDocument[]
  // What has been approved against each order so far, so a replay measures an
  // invoice against what its order has left, exactly as the pipeline does.
  billed?: readonly BilledDocument[]
  // What the engine has already been through. Passing the state a previous pass
  // left behind replays the corpus on top of it, the way the live pipeline does
  // when someone re-runs a document that has already been decided.
  seed?: CorpusReplayState
}

/**
 * The cross-invoice context a pass leaves behind.
 *
 * Handed back so a caller can replay the corpus on top of its own history, which
 * is the thing a database-backed re-run does and an in-memory pass otherwise
 * cannot model.
 */
export interface CorpusReplayState {
  priorHashes: PriorRunHash[]
  priorRuns: PriorRun[]
}

export function runCorpus(options: CorpusRunOptions = {}): Map<string, CorpusOutcome> {
  return runCorpusPass(options).results
}

export function runCorpusPass(options: CorpusRunOptions = {}): {
  results: Map<string, CorpusOutcome>
  state: CorpusReplayState
} {
  const documents = options.documents ?? corpusInReceiptOrder
  const activeRules = options.rules ?? rules
  const results = new Map<string, CorpusOutcome>()

  const priorHashes: PriorRunHash[] = [...(options.seed?.priorHashes ?? [])]
  const priorRuns: PriorRun[] = [...(options.seed?.priorRuns ?? [])]

  for (const document of documents) {
    const vendorId = document.resolved_vendor_id

    // Most recent prior run of the same invoice number for the same vendor, on a
    // different document.
    //
    // Excluding this document's own earlier runs is what pipeline.ts does when it
    // looks for a parent, and it matters: a document compared against its own
    // previous pass has changed nothing, which the resubmission classifier reads
    // as an exact duplicate. A replay would then block every clean document for
    // duplicating itself.
    const parentRun =
      [...priorRuns]
        .reverse()
        .find(
          (run) =>
            run.run_id !== runIdFor(document) &&
            run.invoice_number === document.facts.invoice_number &&
            run.vendor_id === vendorId &&
            // A parent has to have been received before its child, which is not
            // the same as having been decided first. Without this, a replay hands
            // the original document its own resubmission as a parent and the diff
            // reads backwards: the corrected version becomes the thing the
            // original amended. pipeline.ts guards the same way.
            String(run.started_at) <= String(document.facts.invoice_date),
        ) ?? null

    const result = decideInvoice({
      facts: document.facts,
      vendors: options.vendors ?? vendors,
      purchaseOrders: options.purchaseOrders ?? purchaseOrders,
      rules: activeRules,
      asOf: options.asOf ?? AS_OF,
      submissionId: document.id,
      submissions: options.submissions ?? ledger,
      // Earlier arrivals only, which on a replay means everything except this
      // document's own previous passes. A re-run is not a new arrival, so a
      // document can never become a duplicate of itself.
      priorHashes: priorHashes.filter((entry) => entry.run_id !== runIdFor(document)),
      parentRun,
      billed: options.billed,
    })

    results.set(document.id, { ...result, document })

    if (document.facts.file_hash && !priorHashes.some((entry) => entry.run_id === runIdFor(document))) {
      priorHashes.push({
        run_id: runIdFor(document),
        invoice_number: document.facts.invoice_number ?? '',
        file_hash: document.facts.file_hash,
        received_at: String(document.facts.invoice_date),
        decided_at: String(document.facts.invoice_date),
      })
    }
    priorRuns.push({
      run_id: runIdFor(document),
      invoice_number: document.facts.invoice_number ?? '',
      vendor_id: vendorId,
      verdict: result.decision.verdict,
      reason_codes: result.decision.reason_codes as ReasonCode[],
      facts: document.facts,
      started_at: String(document.facts.invoice_date),
    })
  }

  return { results, state: { priorHashes, priorRuns } }
}

// One identity per document, so a replay recognises its own earlier passes.
function runIdFor(document: CorpusDocument): string {
  return `run:${document.id}`
}

export function outcomeFor(results: Map<string, CorpusOutcome>, pdfFilename: string): CorpusOutcome {
  const outcome = results.get(pdfFilename)
  if (!outcome) throw new Error(`No outcome for ${pdfFilename}`)
  return outcome
}
