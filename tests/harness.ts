// Runs corpus documents through stages 3-6 in receipt order, threading the
// cross-invoice context (prior runs, file hashes, resubmission parents) the way
// pipeline.ts does against the database.

import { decideInvoice } from '../src/rules/decide.ts'
import type { EngineResult } from '../src/rules/decide.ts'
import type { PriorRunHash } from '../src/rules/validate.ts'
import type { PriorRun, ReasonCode, SubmissionRecord, VendorRecord, PurchaseOrderRecord, RuleSet } from '../src/rules/types.ts'
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
}

export function runCorpus(options: CorpusRunOptions = {}): Map<string, CorpusOutcome> {
  const documents = options.documents ?? corpusInReceiptOrder
  const activeRules = options.rules ?? rules
  const results = new Map<string, CorpusOutcome>()

  const priorHashes: PriorRunHash[] = []
  const priorRuns: PriorRun[] = []

  for (const document of documents) {
    const vendorId = document.resolved_vendor_id

    // Most recent prior run of the same invoice number for the same vendor.
    const parentRun =
      [...priorRuns]
        .reverse()
        .find(
          (run) => run.invoice_number === document.facts.invoice_number && run.vendor_id === vendorId,
        ) ?? null

    const result = decideInvoice({
      facts: document.facts,
      vendors: options.vendors ?? vendors,
      purchaseOrders: options.purchaseOrders ?? purchaseOrders,
      rules: activeRules,
      asOf: options.asOf ?? AS_OF,
      submissionId: document.id,
      submissions: options.submissions ?? ledger,
      priorHashes,
      parentRun,
    })

    results.set(document.id, { ...result, document })

    if (document.facts.file_hash) {
      priorHashes.push({
        run_id: `run:${document.id}`,
        invoice_number: document.facts.invoice_number ?? '',
        file_hash: document.facts.file_hash,
      })
    }
    priorRuns.push({
      run_id: `run:${document.id}`,
      invoice_number: document.facts.invoice_number ?? '',
      vendor_id: vendorId,
      verdict: result.decision.verdict,
      reason_codes: result.decision.reason_codes as ReasonCode[],
      facts: document.facts,
      started_at: String(document.facts.invoice_date),
    })
  }

  return results
}

export function outcomeFor(results: Map<string, CorpusOutcome>, pdfFilename: string): CorpusOutcome {
  const outcome = results.get(pdfFilename)
  if (!outcome) throw new Error(`No outcome for ${pdfFilename}`)
  return outcome
}
