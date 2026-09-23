// Everything one decision needs, assembled once and read by both the queue's
// detail pane and the standalone decision page.
//
// Nothing here recomputes a verdict. The run holds what the rules decided; the
// stage logs hold what they decided it on. This reads and shapes.

import { getInvoiceById, getPurchaseOrders, getRunById, getStageLogs } from './queries.ts'
import { pdfUrlFor } from './pipeline.ts'
import { loadVendorMaster, resolveVendorForDocument } from './vendorLookup.ts'
import { REASON_CODE_FIELDS } from '@/rules/validate.ts'
import type { FieldChange } from '@/rules/validate.ts'
import type { ReasonCode } from '@/rules/types.ts'
import type { InvoiceRow, PurchaseOrderRow, RunRow, StageLogRow, VendorRow } from './database.types.ts'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Who overrode this verdict, if anybody did.
 *
 * Both halves are required. `touched_by_human` on its own says an override was
 * recorded but not by whom, which is how "Approved by: Approved at this
 * workstation" came to sit on a blocked invoice: an early version of the override
 * button wrote that string in place of asking for a name. A placeholder is not an
 * approver, so it reads here as nobody, and 011_override_names.sql clears the
 * rows that still carry it.
 */
export function approverOf(run: Pick<RunRow, 'touched_by_human' | 'touched_by'>): string | null {
  if (!run.touched_by_human) return null
  const name = run.touched_by?.trim() ?? ''
  return name.length > 0 ? name : null
}

export interface OrderLine {
  description?: string | null
  quantity?: number | null
  unit_price?: number | null
  amount?: number | null
}

// The two sides of a check that failed: what the document prints, and what we hold
// on file. Shown together so the gap is the first thing a person sees.
export interface DisputedPair {
  label: string
  printedLabel: string
  printed: unknown
  onFileLabel: string
  onFile: unknown
}

// Which evidence keys hold the two sides, per check. Only checks where a
// side-by-side actually reads as a comparison are listed; the rest are explained
// by their sentence alone.
const DISPUTES: Record<string, { label: string; printed: [string, string]; onFile: [string, string] }> = {
  bank_account: {
    label: 'Bank account',
    printed: ['invoice_bank', 'On this invoice'],
    onFile: ['master_bank', 'On file for this vendor'],
  },
  currency: {
    label: 'Currency',
    printed: ['invoice_currency', 'On this invoice'],
    onFile: ['po_currency', 'On the order'],
  },
  arithmetic: {
    label: 'Total',
    printed: ['stated_total', 'Printed on the invoice'],
    onFile: ['computed_total', 'Line items plus tax'],
  },
  cumulative_overage: {
    label: 'Against the order',
    printed: ['cumulative', 'Billed once this is paid'],
    onFile: ['ceiling', 'The order allows'],
  },
  unit_prices: {
    label: 'Amount billed',
    printed: ['net_variance', 'Over the order price by'],
    onFile: ['allowance', 'Allowed over by'],
  },
}

// Business fields a finance person recognises. A resubmission diff lists these and
// nothing else: the file hash and the free-text notes are how the document was
// delivered, not what it asks to be paid.
export const BUSINESS_DIFF_FIELDS = [
  'vendor_name',
  'po_reference',
  'invoice_date',
  'line_items',
  'subtotal',
  'tax',
  'total',
  'bank_account',
  'remit_to_name',
  'invoice_number',
  'currency',
  'document_type',
] as const

export interface DecisionData {
  run: RunRow
  invoice: InvoiceRow | null
  // Resolved against the vendor master as it stands, not read off the invoice
  // row's seeded column. A vendor added since this run was decided is found.
  vendor: VendorRow | null
  // True when the printed name does not resolve to any vendor we hold right now.
  // The run's UNKNOWN_VENDOR code says what was true when it was decided, which is
  // not the same question: somebody may have added the vendor since.
  vendorUnknownNow: boolean
  order: PurchaseOrderRow | null
  stages: StageLogRow[]
  extraction: Record<string, unknown> | null
  validations: Record<string, unknown> | null
  codes: string[]
  flaggedFields: Set<string>
  disputes: DisputedPair[]
  // Only fields that actually changed, and only ones a person would recognise.
  businessChanges: FieldChange[]
  // True when the resubmission replaced the file without changing any figure.
  fileReplacedOnly: boolean
  documentUrl: string | null
  documentIsImage: boolean
}

export async function loadDecision(runId: string): Promise<DecisionData | null> {
  const run = await getRunById(runId)
  if (!run) return null

  const [stages, orders, master, invoice] = await Promise.all([
    getStageLogs(runId),
    getPurchaseOrders(),
    loadVendorMaster(),
    run.invoice_id ? getInvoiceById(run.invoice_id) : Promise.resolve(null),
  ])

  const extraction = asRecord(stages.find((stage) => stage.stage === 'extract')?.output)

  // The name as the document printed it, which is what stage 3 resolved and what
  // this resolves again now.
  const printedName =
    (typeof extraction?.vendor_name === 'string' ? extraction.vendor_name : null) ??
    invoice?.vendor_name_as_printed ??
    null
  const resolved = resolveVendorForDocument({
    printedName,
    storedVendorId: invoice?.vendor_id,
    vendors: master.vendors,
    rules: master.rules,
  })
  const validations = asRecord(stages.find((stage) => stage.stage === 'validate')?.output)
  const codes = run.reason_codes ?? []

  const flaggedFields = new Set<string>()
  for (const code of codes) {
    for (const field of REASON_CODE_FIELDS[code as ReasonCode] ?? []) flaggedFields.add(field)
  }

  const disputes: DisputedPair[] = []
  for (const [check, spec] of Object.entries(DISPUTES)) {
    const result = asRecord(validations?.[check])
    if (!result || result.passed !== false) continue
    const evidence = asRecord(result.evidence)
    if (!evidence) continue
    const printed = evidence[spec.printed[0]]
    const onFile = evidence[spec.onFile[0]]
    if (printed === undefined && onFile === undefined) continue
    disputes.push({
      label: spec.label,
      printedLabel: spec.printed[1],
      printed,
      onFileLabel: spec.onFile[1],
      onFile,
    })
  }

  const allChanges = (run.changed_fields as unknown as FieldChange[] | null) ?? []
  const business = new Set<string>(BUSINESS_DIFF_FIELDS)
  const businessChanges = Array.isArray(allChanges)
    ? allChanges.filter((change) => business.has(change.field))
    : []
  const fileReplacedOnly =
    Array.isArray(allChanges) && allChanges.length > 0 && businessChanges.length === 0

  const documentUrl = invoice ? pdfUrlFor(invoice) : null
  const documentIsImage = Boolean(invoice?.storage_path && /\.(png|jpe?g|webp|heic)$/i.test(invoice.storage_path))

  return {
    run,
    invoice,
    vendor: resolved.vendor,
    vendorUnknownNow: resolved.vendor === null,
    order: orders.find((entry) => entry.po_number === run.matched_po) ?? null,
    stages,
    extraction,
    validations,
    codes,
    flaggedFields,
    disputes,
    businessChanges,
    fileReplacedOnly,
    documentUrl,
    documentIsImage,
  }
}

// The extracted fields, in the order a person reads an invoice.
export interface ReadField {
  key: string
  label: string
  value: string
  mono?: boolean
  flagged: boolean
}

export function readFields(data: DecisionData, format: { money: (v: number | null) => string; date: (v: string | null) => string }): ReadField[] {
  const extraction = data.extraction
  const text = (key: string) => (typeof extraction?.[key] === 'string' ? (extraction[key] as string) : 'Not read')
  const num = (key: string) => (typeof extraction?.[key] === 'number' ? (extraction[key] as number) : null)
  const flagged = (key: string) => data.flaggedFields.has(key)

  return [
    { key: 'invoice_number', label: 'Invoice number', value: text('invoice_number'), mono: true, flagged: flagged('invoice_number') },
    { key: 'invoice_date', label: 'Invoice date', value: format.date(text('invoice_date')), flagged: flagged('invoice_date') },
    { key: 'vendor_name', label: 'Vendor as printed', value: text('vendor_name'), flagged: flagged('vendor_name') },
    { key: 'po_reference', label: 'Order cited', value: text('po_reference'), mono: true, flagged: flagged('po_reference') },
    { key: 'currency', label: 'Currency', value: text('currency'), flagged: flagged('currency') },
    { key: 'subtotal', label: 'Subtotal', value: format.money(num('subtotal')), flagged: flagged('subtotal') },
    { key: 'tax', label: 'Tax', value: format.money(num('tax')), flagged: flagged('tax') },
    { key: 'total', label: 'Total', value: format.money(num('total')), flagged: flagged('total') },
    { key: 'bank_account', label: 'Bank account', value: text('bank_account'), mono: true, flagged: flagged('bank_account') },
    { key: 'remit_to_name', label: 'Pay to', value: text('remit_to_name'), flagged: flagged('remit_to_name') },
  ]
}
