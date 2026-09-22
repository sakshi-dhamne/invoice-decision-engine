// Pipeline orchestration — stages 1 to 7.
//
// This is the only file in the decision path that talks to the database or the
// network. Everything in `src/rules/` is pure; the pipeline fetches what those
// rules need, runs them, and writes the result. That split is what lets the whole
// engine be tested offline.
//
// Each stage writes a `stage_logs` row as `running` before it executes and updates
// it to `passed` or `flagged` afterwards, with its input, output, reasoning and
// duration. A stage that throws is marked `failed`, the run is marked `failed` with
// the stage named, and nothing is left stuck in `running`.

import { getOrExtract } from './extraction.ts'
import { describeUploadedInvoice, UPLOAD_BUCKET } from './uploads.ts'
import type { ExtractionResult } from './extractionSchema.ts'
import { supabase } from './supabase.ts'
import {
  createRun,
  getCompletedRuns,
  getInvoiceById,
  getInvoices,
  getPurchaseOrders,
  getRules,
  getVendors,
  logStage,
  setInvoiceFileHash,
  updateRun,
  updateStageLog,
} from './queries.ts'
import type { InvoiceRow, Json, PurchaseOrderRow, RunRow, StageLogStatus, VendorRow } from './database.types.ts'

import { decide } from '@/rules/decide.ts'
import { matchPurchaseOrder } from '@/rules/poMatch.ts'
import { resolveVendor } from '@/rules/vendor.ts'
import { findExactDuplicate, runValidations } from '@/rules/validate.ts'
import type { PriorRunHash, ValidationReport } from '@/rules/validate.ts'
import { toRuleSet } from '@/rules/types.ts'
import type {
  Evidence,
  InvoiceFacts,
  LineItemFact,
  PriorRun,
  PurchaseOrderLine,
  PurchaseOrderRecord,
  ReasonCode,
  RuleSet,
  SubmissionRecord,
  Verdict,
  VendorRecord,
} from '@/rules/types.ts'
import { fallbackExplanation } from '@/rules/explain.ts'
import { reasonSentence } from './reasonCopy.ts'
import type { ExplainDecisionRequest, ExplainDecisionResponse } from '@/rules/explain.ts'

// ---------------------------------------------------------------------------
// Row adapters — Supabase shapes in, plain rule records out
// ---------------------------------------------------------------------------

function asArray<T>(value: Json | null): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : []
}

export function toVendorRecord(row: VendorRow): VendorRecord {
  return {
    id: row.id,
    legal_name: row.legal_name,
    aliases: row.aliases ?? [],
    bank_account: row.bank_account,
    status: row.status,
  }
}

export function toPurchaseOrderRecord(row: PurchaseOrderRow): PurchaseOrderRecord {
  return {
    po_number: row.po_number,
    vendor_id: row.vendor_id,
    total_amount: row.total_amount,
    currency: row.currency,
    amount_billed_to_date: row.amount_billed_to_date,
    tax_treatment: row.tax_treatment,
    status: row.status,
    line_items: asArray<PurchaseOrderLine>(row.line_items),
    delivery_schedule: row.delivery_schedule ? asArray(row.delivery_schedule) : null,
    issued_date: row.issued_date,
  }
}

/**
 * The facts the rules decide on come from the extraction, never from the fixture
 * columns on `invoices` — those exist so the harness can score extraction accuracy.
 *
 * `fields_not_printed` is the union of what the document is known not to print and
 * what the model reported it could not read. Both mean the same thing to a rule: a
 * null there is an absence, not a wrong value.
 *
 * A value arriving for one of those fields is therefore self-contradictory: the
 * document has no such figure to transcribe, or the model has just said it could
 * not read the one that is there. Either way what came back is something the model
 * worked out, not something the vendor printed, and this is where it stops. Every
 * downstream check reads the stated figure — the total above all, since that is
 * what the vendor is asking to be paid — so an absence is carried through as a
 * null and left for `INCOMPLETE_EXTRACTION` to report. A computed figure allowed
 * through here would not merely be wrong; seated in place of the stated total it
 * would agree with its own inputs and silently disarm the arithmetic check.
 */
export function toInvoiceFacts(extraction: ExtractionResult, invoice: InvoiceRow): InvoiceFacts {
  const notPrinted = new Set<string>([...(invoice.fields_not_printed ?? []), ...(extraction.unreadable_fields ?? [])])

  // Null for a field the document does not print or the model could not read,
  // whatever value came back alongside that declaration.
  const asStated = <T>(field: string, value: T): T | null => (notPrinted.has(field) ? null : value)

  return {
    invoice_number: asStated('invoice_number', extraction.invoice_number),
    invoice_date: asStated('invoice_date', extraction.invoice_date),
    vendor_name: asStated('vendor_name', extraction.vendor_name),
    po_reference: asStated('po_reference', extraction.po_reference),
    currency: asStated('currency', extraction.currency),
    line_items: (extraction.line_items ?? []).map(
      (line): LineItemFact => ({
        description: line.description ?? null,
        quantity: line.quantity ?? null,
        unit_price: line.unit_price ?? null,
        amount: line.amount ?? null,
      }),
    ),
    subtotal: asStated('subtotal', extraction.subtotal),
    tax: asStated('tax', extraction.tax),
    total: asStated('total', extraction.total),
    bank_account: asStated('bank_account', extraction.bank_account),
    remit_to_name: asStated('remit_to_name', extraction.remit_to_name),
    document_type: extraction.document_type,
    notes: asStated('notes', extraction.notes),
    file_hash: invoice.file_hash,
    fields_not_printed: [...notPrinted],
  }
}

// ---------------------------------------------------------------------------
// Shared read-only context
// ---------------------------------------------------------------------------

export interface PipelineContext {
  rules: RuleSet
  vendors: VendorRecord[]
  purchaseOrders: PurchaseOrderRecord[]
  invoices: InvoiceRow[]
  // The received-document ledger, with each document's vendor resolved by the same
  // stage-3 resolver rather than read from a stored label.
  ledger: SubmissionRecord[]
}

export async function loadPipelineContext(): Promise<PipelineContext> {
  const [ruleRows, vendorRows, poRows, invoiceRows] = await Promise.all([
    getRules(),
    getVendors(),
    getPurchaseOrders(),
    getInvoices(),
  ])

  const rules = toRuleSet(Object.fromEntries(Object.entries(ruleRows).map(([key, row]) => [key, row.value])))
  const vendors = vendorRows.map(toVendorRecord)

  const ledger: SubmissionRecord[] = invoiceRows.map((row) => ({
    id: row.id,
    invoice_number: row.invoice_number,
    vendor_id: resolveVendor(row.vendor_name_as_printed, vendors, rules).vendor?.id ?? null,
    po_reference: row.po_reference,
    invoice_date: row.invoice_date,
    total: row.total,
    document_type: row.document_type,
    notes: row.notes_field,
    file_hash: row.file_hash,
  }))

  return { rules, vendors, purchaseOrders: poRows.map(toPurchaseOrderRecord), invoices: invoiceRows, ledger }
}

// ---------------------------------------------------------------------------
// Ingest helpers
// ---------------------------------------------------------------------------

/**
 * Where this document's PDF can be fetched from.
 *
 * An uploaded document lives in the Storage bucket and carries the key that finds
 * it. A seeded fixture has no key and is served from public/invoices. Everything
 * downstream takes the URL and never learns which kind it was.
 */
export function pdfUrlFor(invoice: InvoiceRow): string {
  if (invoice.storage_path) {
    return supabase.storage.from(UPLOAD_BUCKET).getPublicUrl(invoice.storage_path).data.publicUrl
  }
  const filename = invoice.file_path?.split('/').pop() ?? `${invoice.invoice_number}.pdf`
  return `/invoices/${filename}`
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Best effort. A hash we cannot compute means the exact-duplicate check stands
// down for this document; it must never stop the run.
async function ensureFileHash(invoice: InvoiceRow, pdfUrl: string): Promise<string | null> {
  if (invoice.file_hash) return invoice.file_hash
  try {
    const response = await fetch(pdfUrl)
    if (!response.ok) return null
    const hash = `sha256:${await sha256Hex(await response.arrayBuffer())}`
    await setInvoiceFileHash(invoice.id, hash)
    return hash
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Prior-run context
// ---------------------------------------------------------------------------

/**
 * Just enough of a document to place it in arrival order.
 *
 * Narrow on purpose: the selection below is the rule that decides which of two
 * copies of a file is the original, and it is worth being able to test that rule
 * without a database.
 */
export interface ArrivalRecord {
  id: string
  invoice_number: string
  file_hash: string | null
  created_at: string
}

export interface CompletedRunRecord {
  id: string
  invoice_id: string | null
  finished_at: string | null
}

/**
 * Arrival order.
 *
 * `created_at` is when the record was opened, which is when the document arrived.
 * The row id breaks a tie so the order is total and does not shift between runs:
 * a seeded corpus inserts every row in one statement and they share a timestamp
 * to the microsecond.
 */
function arrivedBefore(candidate: ArrivalRecord, subject: ArrivalRecord): boolean {
  const a = String(candidate.created_at ?? '')
  const b = String(subject.created_at ?? '')
  if (a !== b) return a < b
  return candidate.id < subject.id
}

/**
 * The documents this one could be a duplicate of.
 *
 * Only earlier arrivals, and that scoping is the whole point. It gives the rule
 * two properties it did not have:
 *
 *  - the first copy of a file to arrive is the original, however many times either
 *    of them is decided again;
 *  - deciding the original a second time after a copy has landed leaves the
 *    original alone, because the copy arrived later and is therefore not in this
 *    list.
 *
 * Without it, whichever of the pair was re-run last became the duplicate, so a
 * re-run could block the document it should have been comparing against.
 */
export function selectPriorHashes(
  subject: ArrivalRecord,
  documents: readonly ArrivalRecord[],
  runs: readonly CompletedRunRecord[],
): PriorRunHash[] {
  const byId = new Map(documents.map((row) => [row.id, row]))
  const priorHashes: PriorRunHash[] = []
  const seen = new Set<string>()

  for (const run of runs) {
    const row = run.invoice_id ? byId.get(run.invoice_id) : undefined
    if (!row?.file_hash || row.id === subject.id) continue
    if (!arrivedBefore(row, subject)) continue
    // One entry per document, the earliest run of it, so a duplicate points at the
    // first time we saw the file rather than the most recent re-run.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    priorHashes.push({
      run_id: run.id,
      invoice_number: row.invoice_number,
      file_hash: row.file_hash,
      received_at: row.created_at,
      decided_at: run.finished_at,
    })
  }

  return priorHashes
}

export async function loadPriorHashes(context: PipelineContext, invoice: InvoiceRow): Promise<PriorRunHash[]> {
  return selectPriorHashes(invoice, context.invoices, await getCompletedRuns())
}

async function loadParentRun(
  context: PipelineContext,
  invoice: InvoiceRow,
  vendorId: string | null,
): Promise<PriorRun | null> {
  const runs = await getCompletedRuns()
  const byId = new Map(context.invoices.map((row) => [row.id, row]))

  // The most recent prior run of this invoice number for this vendor.
  //
  // A parent has to have been received before its child, which is not the same as
  // having been *processed* first: replaying the corpus on top of an earlier pass
  // would otherwise let a resubmission become the parent of the document it
  // amended, and the diff would read backwards.
  const lineage = runs.filter((run) => {
    const row = run.invoice_id ? byId.get(run.invoice_id) : undefined
    if (!row || row.id === invoice.id) return false
    if (row.invoice_number !== invoice.invoice_number) return false
    if (String(row.invoice_date) > String(invoice.invoice_date)) return false
    const rowVendor = context.ledger.find((entry) => entry.id === row.id)?.vendor_id ?? null
    return rowVendor === vendorId
  })

  const latest = lineage[lineage.length - 1]
  if (!latest?.invoice_id) return null

  const parentInvoice = byId.get(latest.invoice_id)
  if (!parentInvoice) return null

  const parentExtraction = await getOrExtract(
    parentInvoice.id,
    pdfUrlFor(parentInvoice),
    parentInvoice.invoice_number,
  )

  return {
    run_id: latest.id,
    invoice_number: parentInvoice.invoice_number,
    vendor_id: vendorId,
    verdict: latest.verdict,
    reason_codes: (latest.reason_codes ?? []) as ReasonCode[],
    facts: toInvoiceFacts(parentExtraction.data, parentInvoice),
    started_at: latest.started_at,
  }
}

/**
 * Settles a run that stopped at stage 1 because the file had been seen before.
 *
 * The stages after ingest never executed, so they are recorded as skipped rather
 * than left absent: a reader looking at the run should see that we chose not to
 * read the document, not wonder whether something broke.
 *
 * An uploaded copy opened its row under the file's own name, because nothing had
 * read it yet and nothing ever will. The original's invoice number is adopted onto
 * it, which is not a guess: the two files are identical byte for byte, so they are
 * the same document and it is the same invoice number printed on both.
 */
async function concludeAsDuplicate(input: {
  run: RunRow
  invoice: InvoiceRow
  duplicateOf: PriorRunHash
  fileHash: string | null
}): Promise<RunOutcome> {
  const { run, invoice, duplicateOf, fileHash } = input

  const evidence: Record<string, Evidence> = {
    EXACT_DUPLICATE: {
      file_hash: fileHash,
      prior_run_id: duplicateOf.run_id,
      prior_invoice_number: duplicateOf.invoice_number,
      prior_decided_at: duplicateOf.decided_at ?? null,
    },
  }

  for (const stage of PIPELINE_STAGES) {
    if (stage === 'ingest') continue
    await logStage(run.id, stage, PIPELINE_STAGES.indexOf(stage) + 1, 'pending', {
      reasoning: 'Not needed. We had already been through this exact file.',
    }).catch(() => undefined)
  }

  if (invoice.storage_path && invoice.invoice_number !== duplicateOf.invoice_number) {
    await describeUploadedInvoice(invoice.id, { invoice_number: duplicateOf.invoice_number }).catch(() => undefined)
  }

  const explainRequest: ExplainDecisionRequest = {
    verdict: 'BLOCK',
    reason_codes: ['EXACT_DUPLICATE'],
    evidence,
    summary: {
      invoice_number: duplicateOf.invoice_number,
      vendor_name: invoice.vendor_name_as_printed,
      total: invoice.total,
      currency: invoice.currency,
      matched_po: null,
    },
  }

  const finished = await updateRun(run.id, {
    status: 'complete',
    verdict: 'BLOCK',
    reason_codes: ['EXACT_DUPLICATE'],
    matched_po: null,
    explanation: fallbackExplanation(explainRequest),
    finished_at: new Date().toISOString(),
  })

  return {
    run: finished,
    invoice,
    verdict: 'BLOCK',
    reasonCodes: ['EXACT_DUPLICATE'],
    matchedPo: null,
    explanation: finished.explanation ?? '',
    explanationSource: 'fallback',
    checks: null,
    facts: null,
  }
}

// ---------------------------------------------------------------------------
// Stage logging
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = [
  'ingest',
  'extract',
  'resolve_vendor',
  'match_po',
  'validate',
  'decide',
  'explain',
] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export interface StageEvent {
  stage: PipelineStage
  order: number
  status: StageLogStatus
  durationMs: number
  reasoning: string
}

interface StageOutcome<T> {
  value: T
  output: Json
  reasoning: string
  flagged?: boolean
}

// ---------------------------------------------------------------------------
// runInvoice
// ---------------------------------------------------------------------------

export interface RunInvoiceOptions {
  // The clock the date rules read. Defaults to now; tests and replays pass a fixed
  // date so a run is reproducible.
  asOf?: Date
  // Pre-fetched shared context, so a batch does not re-read the master data per
  // invoice.
  context?: PipelineContext
  // Force a fresh extraction instead of reading the cache.
  force?: boolean
  // Stage 7 calls a model. Off, the run still completes on the deterministic
  // reason-code summary — the explanation is presentational either way.
  explain?: boolean
  onStage?: (event: StageEvent) => void
  // Fires as soon as the run row exists, before stage 1 executes. The upload flow
  // uses it to send the person to the live view and watch the rest happen.
  onRunCreated?: (run: RunRow) => void
}

export interface RunOutcome {
  run: RunRow
  invoice: InvoiceRow
  verdict: Verdict
  reasonCodes: ReasonCode[]
  matchedPo: string | null
  explanation: string
  explanationSource: 'model' | 'fallback'
  // Null on a run that stopped at stage 1, which is the duplicate short-circuit:
  // the document was never read, so there is nothing to have checked.
  checks: ValidationReport | null
  facts: InvoiceFacts | null
}

export async function runInvoice(invoiceId: string, options: RunInvoiceOptions = {}): Promise<RunOutcome> {
  const asOf = options.asOf ?? new Date()
  const context = options.context ?? (await loadPipelineContext())

  const invoice = await getInvoiceById(invoiceId)
  if (!invoice) throw new Error(`No invoice with id ${invoiceId}`)

  const run = await createRun(invoice.id)
  options.onRunCreated?.(run)
  let currentStage: PipelineStage = 'ingest'

  const runStage = async <T>(
    stage: PipelineStage,
    input: Json,
    execute: () => Promise<StageOutcome<T>> | StageOutcome<T>,
  ): Promise<T> => {
    currentStage = stage
    const order = PIPELINE_STAGES.indexOf(stage) + 1
    const log = await logStage(run.id, stage, order, 'running', { input })
    const startedAt = performance.now()

    try {
      const outcome = await execute()
      const durationMs = Math.round(performance.now() - startedAt)
      const status: StageLogStatus = outcome.flagged ? 'flagged' : 'passed'
      await updateStageLog(log.id, {
        status,
        output: outcome.output,
        reasoning: outcome.reasoning,
        duration_ms: durationMs,
      })
      options.onStage?.({ stage, order, status, durationMs, reasoning: outcome.reasoning })
      return outcome.value
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt)
      const message = error instanceof Error ? error.message : String(error)
      await updateStageLog(log.id, { status: 'failed', reasoning: message, duration_ms: durationMs })
      options.onStage?.({ stage, order, status: 'failed', durationMs, reasoning: message })
      throw error
    }
  }

  try {
    // Stage 1 — ingest. Locates the document and records its content hash.
    const ingested = await runStage('ingest', { invoice_id: invoice.id, file_path: invoice.file_path }, async () => {
      const pdfUrl = pdfUrlFor(invoice)
      const fileHash = await ensureFileHash(invoice, pdfUrl)
      const priorHashes = await loadPriorHashes(context, invoice)
      const duplicateOf = findExactDuplicate(fileHash, priorHashes)
      return {
        value: { pdfUrl, fileHash, priorHashes, duplicateOf },
        output: {
          pdf_url: pdfUrl,
          file_hash: fileHash,
          duplicate_of: duplicateOf?.invoice_number ?? null,
          prior_run_id: duplicateOf?.run_id ?? null,
          prior_decided_at: duplicateOf?.decided_at ?? null,
        } as Json,
        reasoning: duplicateOf
          ? `This is the same file as ${duplicateOf.invoice_number}, which we have already been through. Nothing further was read.`
          : fileHash
            ? 'Found the document and took its fingerprint, so a second copy of it will be recognised.'
            : 'Found the document. We could not take its fingerprint, so we cannot tell whether this file has arrived before.',
        flagged: Boolean(duplicateOf) || !fileHash,
      }
    })

    /**
     * An exact duplicate stops here, before the document is read.
     *
     * This check needs the fingerprint and nothing else, so running it at stage 1
     * costs nothing. Running it after stage 2, which is where it used to sit, meant
     * paying a model to read a file we had already read, and taking seventeen
     * seconds to reach an answer the hash gave us instantly.
     *
     * The verdict is still the rules engine's: rule 1 blocks an exact duplicate,
     * and this short-circuit reaches the same outcome by the same rule.
     */
    if (ingested.duplicateOf) {
      return await concludeAsDuplicate({
        run,
        invoice,
        duplicateOf: ingested.duplicateOf,
        fileHash: ingested.fileHash,
      })
    }

    // Stage 2 — extract. Reads through the cache; a cached extraction is not a
    // model call.
    const extraction = await runStage('extract', { pdf_url: ingested.pdfUrl }, async () => {
      const cached = await getOrExtract(invoice.id, ingested.pdfUrl, invoice.invoice_number, { force: options.force })
      return {
        value: cached,
        output: cached.data as unknown as Json,
        reasoning: cached.fromCache
          ? 'We had already read this page, so we used what we read the first time.'
          : 'Read the page and copied out what it says.',
      }
    })

    const facts = toInvoiceFacts(extraction.data, { ...invoice, file_hash: ingested.fileHash })

    // An uploaded document opened its row before anything had read it, so the row
    // still carries a placeholder number and no figures. Stage 2 is the first thing
    // that knows what the page says, so bring the row up to date from it. These
    // columns are for display and for the cross-invoice ledger; the rules go on
    // deciding from the extraction itself, never from what is written back here.
    if (invoice.storage_path) {
      await describeUploadedInvoice(invoice.id, {
        invoice_number: facts.invoice_number ?? invoice.invoice_number,
        vendor_name_as_printed: facts.vendor_name,
        po_reference: facts.po_reference,
        invoice_date: facts.invoice_date,
        currency: facts.currency,
        subtotal: facts.subtotal,
        tax: facts.tax,
        total: facts.total,
        bank_account_printed: facts.bank_account,
        remit_to_name: facts.remit_to_name,
        document_type: facts.document_type,
        notes_field: facts.notes,
      }).catch(() => undefined)
    }

    // Stage 3 — resolve vendor.
    const vendorMatch = await runStage('resolve_vendor', { printed_name: facts.vendor_name }, () => {
      const match = resolveVendor(facts.vendor_name, context.vendors, context.rules)
      return {
        value: match,
        output: {
          vendor_id: match.vendor?.id ?? null,
          score: match.score,
          status: match.status,
          matched_on: match.matched_on,
          matched_value: match.matched_value,
          normalized_input: match.normalized_input,
          runners_up: match.runners_up,
        } as unknown as Json,
        reasoning: match.vendor
          ? match.status === 'matched'
            ? `The printed name is ${match.vendor.legal_name}, which is on the approved vendor list.`
            : `The printed name is close to ${match.vendor.legal_name}, but not close enough to be sure.`
          : 'The printed name does not match any company on the approved vendor list.',
        flagged: match.status !== 'matched',
      }
    })

    const parentRun = await loadParentRun(context, invoice, vendorMatch.vendor?.id ?? null)
    const priorHashes = ingested.priorHashes

    // Stage 4 — match PO.
    const vendorPos = vendorMatch.vendor
      ? context.purchaseOrders.filter((po) => po.vendor_id === vendorMatch.vendor?.id)
      : []

    const poMatch = await runStage(
      'match_po',
      { po_reference: facts.po_reference, candidate_pos: vendorPos.map((po) => po.po_number) } as Json,
      () => {
        const match = matchPurchaseOrder(facts, vendorPos, context.rules)
        return {
          value: match,
          output: {
            outcome: match.outcome,
            method: match.method,
            score: match.score,
            matched_po: match.matched?.po_number ?? null,
            candidates: match.candidates.map((po) => po.po_number),
            breakdown: match.breakdown,
          } as unknown as Json,
          reasoning:
            match.outcome === 'explicit'
              ? `The invoice cites ${match.matched?.po_number}, and that order belongs to this vendor.`
              : match.outcome === 'ambiguous'
                ? `The invoice cites no order number, and ${match.candidates.length} of this vendor's orders fit it equally well, so we did not pick one.`
                : match.outcome === 'inferred'
                  ? `The invoice cites no order number. ${match.candidates[0]?.po_number} is the closest fit, but a guess is not a match.`
                  : 'The invoice cites no order number, and none of this vendor\'s orders fit it.',
          flagged: match.outcome !== 'explicit',
        }
      },
    )

    // Stage 5 — validate.
    const checks = await runStage('validate', { po_number: poMatch.matched?.po_number ?? null } as Json, () => {
      const report = runValidations({
        facts,
        vendorMatch,
        poMatch,
        rules: context.rules,
        asOf,
        submissionId: invoice.id,
        submissions: context.ledger,
        priorHashes,
        parentRun,
      })

      const failures = Object.entries(report)
        .filter(([, value]) => value !== null && typeof value === 'object' && 'passed' in value && !value.passed)
        .map(([name]) => name)

      return {
        value: report,
        output: report as unknown as Json,
        reasoning:
          failures.length === 0
            ? 'Every check that applies to this invoice passed.'
            : failures.length === 1
              ? 'One check objected.'
              : `${failures.length} checks objected.`,
        flagged: failures.length > 0,
      }
    })

    // Stage 6 — decide.
    const decision = await runStage('decide', { reason_codes_in: [] } as Json, () => {
      const result = decide({ facts, vendorMatch, poMatch, checks, rules: context.rules })
      return {
        value: result,
        output: {
          verdict: result.verdict,
          primary: result.primary,
          matched_rule: result.matched_rule,
          reason_codes: result.reason_codes,
          reevaluated: result.reevaluated,
          evidence: result.evidence,
        } as Json,
        reasoning: `${reasonSentence(result.primary)} That is what set the outcome.`,
        flagged: result.verdict !== 'AUTO_APPROVE',
      }
    })

    const explainRequest: ExplainDecisionRequest = {
      verdict: decision.verdict,
      reason_codes: decision.reason_codes,
      evidence: decision.evidence,
      summary: {
        invoice_number: facts.invoice_number,
        vendor_name: vendorMatch.vendor?.legal_name ?? facts.vendor_name,
        total: facts.total,
        currency: facts.currency,
        matched_po: poMatch.matched?.po_number ?? null,
      },
    }

    // Stage 7 — explain. Presentational: a failure here never changes or blocks a
    // verdict.
    type ExplanationOutcome = { explanation: string; source: 'model' | 'fallback' }
    const explained = await runStage<ExplanationOutcome>('explain', explainRequest as unknown as Json, async () => {
      const fallback = fallbackExplanation(explainRequest)
      if (options.explain === false) {
        return {
          value: { explanation: fallback, source: 'fallback' },
          output: { explanation: fallback, source: 'fallback' } as Json,
          reasoning: 'Wrote the explanation from the decision itself.',
        }
      }

      try {
        const { data, error } = await supabase.functions.invoke<ExplainDecisionResponse>('explain-decision', {
          body: explainRequest,
        })
        if (error) throw error
        if (!data || !data.ok) throw new Error(data?.ok === false ? data.error : 'explain-decision returned no data')

        return {
          value: { explanation: data.explanation, source: 'model' },
          output: { explanation: data.explanation, model: data.model, provider: data.provider } as Json,
          reasoning: 'Wrote up what was decided, in a sentence or two.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          value: { explanation: fallback, source: 'fallback' },
          output: { explanation: fallback, source: 'fallback', error: message } as Json,
          reasoning:
            'Could not phrase the explanation, so we wrote it from the decision itself. The outcome is the same either way.',
          flagged: true,
        }
      }
    })

    const finished = await updateRun(run.id, {
      status: 'complete',
      verdict: decision.verdict,
      reason_codes: decision.reason_codes,
      matched_po: poMatch.matched?.po_number ?? null,
      parent_run_id: checks.resubmission?.parent_run_id ?? null,
      changed_fields: (checks.resubmission?.changed_fields ?? null) as Json,
      explanation: explained.explanation,
      finished_at: new Date().toISOString(),
    })

    return {
      run: finished,
      invoice,
      verdict: decision.verdict,
      reasonCodes: decision.reason_codes,
      matchedPo: poMatch.matched?.po_number ?? null,
      explanation: explained.explanation,
      explanationSource: explained.source,
      checks,
      facts,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Never leave a run stuck in `running`.
    await updateRun(run.id, {
      status: 'failed',
      explanation: `Stage "${currentStage}" threw: ${message}`,
      finished_at: new Date().toISOString(),
    }).catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export interface BatchResult {
  invoice: InvoiceRow
  verdict: Verdict | null
  reasonCodes: ReasonCode[]
  matchedPo: string | null
  explanation: string | null
  error: string | null
}

/**
 * Runs every invoice in receipt order.
 *
 * Order matters: a resubmission has to see its parent, and a near-duplicate has to
 * see the invoice it duplicates. Sorting by invoice date replays the order the
 * documents actually arrived in.
 */
export async function runAllInvoices(
  options: RunInvoiceOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<BatchResult[]> {
  const context = options.context ?? (await loadPipelineContext())
  const ordered = [...context.invoices].sort((a, b) => {
    const byDate = String(a.invoice_date).localeCompare(String(b.invoice_date))
    return byDate !== 0 ? byDate : a.invoice_number.localeCompare(b.invoice_number)
  })

  const results: BatchResult[] = []
  for (const [index, invoice] of ordered.entries()) {
    try {
      const outcome = await runInvoice(invoice.id, { ...options, context })
      results.push({
        invoice,
        verdict: outcome.verdict,
        reasonCodes: outcome.reasonCodes,
        matchedPo: outcome.matchedPo,
        explanation: outcome.explanation,
        error: null,
      })
    } catch (error) {
      results.push({
        invoice,
        verdict: null,
        reasonCodes: [],
        matchedPo: null,
        explanation: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    options.onProgress?.(index + 1, ordered.length)
  }

  return results
}
