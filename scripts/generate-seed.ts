import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURES_DIR = path.join(ROOT, 'fixtures')
const OUTPUT_PATH = path.join(ROOT, 'supabase/migrations/002_seed.sql')

interface VendorAddress {
  line1: string
  city: string
  state: string
  pincode: string
}

interface VendorFixture {
  id: string
  legal_name: string
  aliases: string[]
  bank_account: string
  ifsc: string
  gstin: string
  email_domain: string
  status: 'active' | 'inactive'
  address: VendorAddress
}

interface LineItem {
  description: string
  quantity: number
  unit_price: number
  amount: number
}

interface DeliveryMilestone {
  milestone: string
  description: string
  amount: number
  due_date: string
}

interface PurchaseOrderFixture {
  po_number: string
  vendor_id: string
  total_amount: number
  currency: string
  amount_billed_to_date: number
  tax_treatment: 'inclusive' | 'exclusive'
  status: 'open' | 'closed' | 'cancelled'
  issued_date: string
  line_items: LineItem[]
  delivery_schedule?: DeliveryMilestone[]
}

interface InvoiceFixture {
  invoice_number: string
  vendor_name_as_printed: string
  vendor_id: string | null
  po_reference: string | null
  invoice_date: string
  currency: string
  line_items: LineItem[]
  subtotal: number
  tax: number
  total: number
  bank_account_printed: string
  remit_to_name: string
  document_type: 'invoice' | 'credit_note'
  notes_field: string | null
  parent_invoice_number: string | null
  expected_verdict: string
  pdf_filename: string
}

interface RuleSeed {
  key: string
  value: number
  unit: string
  description: string
}

interface AssumptionSeed {
  text: string
  category: string
}

const RULES: RuleSeed[] = [
  { key: 'matching_tolerance_pct', value: 0.02, unit: 'percent', description: 'Max variance between invoice and PO amount' },
  { key: 'matching_tolerance_floor', value: 1000, unit: 'INR', description: "Minimum absolute tolerance, so small invoices aren't over-policed" },
  { key: 'auto_approve_limit', value: 200000, unit: 'INR', description: 'Authority ceiling — above this a human approves regardless of match quality' },
  { key: 'vendor_match_threshold', value: 0.85, unit: 'score', description: 'Fuzzy name match score for confident vendor resolution' },
  { key: 'vendor_match_floor', value: 0.6, unit: 'score', description: 'Below this, vendor is treated as unknown' },
  { key: 'po_ambiguity_margin', value: 0.15, unit: 'score', description: 'Two PO candidates within this margin are ambiguous, never auto-picked' },
  { key: 'near_duplicate_window_days', value: 14, unit: 'days', description: 'Lookback window for near-duplicate detection' },
  { key: 'split_pattern_window_days', value: 10, unit: 'days', description: 'Window for threshold-splitting pattern detection' },
  { key: 'split_pattern_min_invoices', value: 3, unit: 'count', description: 'Minimum invoices against one PO to consider a split pattern' },
  { key: 'stale_invoice_days', value: 180, unit: 'days', description: 'Beyond this, invoice date is out of range' },
]

const ASSUMPTIONS: AssumptionSeed[] = [
  {
    text: 'Two-way match only — goods-receipt data unavailable, so quantity is checked against PO quantity rather than what was delivered',
    category: 'matching',
  },
  {
    text: 'PO data is trusted; this process validates invoices against it, not the reverse',
    category: 'matching',
  },
  {
    text: 'Vendor master is authoritative for bank details; changes to the master are out of scope',
    category: 'vendor',
  },
  {
    text: 'Single currency per invoice; no FX conversion, so a currency mismatch holds rather than converting',
    category: 'currency',
  },
  {
    text: 'Near-duplicate window of 14 days chosen to cover monthly billing without catching quarterly',
    category: 'matching',
  },
  {
    text: 'Tolerance has both a percentage and an absolute floor, because 2% of a small invoice is tighter than any real AP team enforces',
    category: 'matching',
  },
  {
    text: 'No authentication in scope; the demo uses permissive row-level security. Production would scope access per organisation',
    category: 'security',
  },
]

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return String(value)
}

function sqlDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return sqlString(value)
}

function sqlTextArray(values: string[] | null | undefined): string {
  if (!values || values.length === 0) return 'NULL'
  return `ARRAY[${values.map(sqlString).join(', ')}]::text[]`
}

function sqlJson(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

function formatAddress(address: VendorAddress): string {
  return `${address.line1}, ${address.city}, ${address.state} ${address.pincode}`
}

function buildInsert(table: string, columns: string[], rows: string[][]): string {
  if (rows.length === 0) return ''
  const values = rows.map((row) => `  (${row.join(', ')})`).join(',\n')
  return `insert into ${table} (${columns.join(', ')})\nvalues\n${values};\n`
}

async function main() {
  const [vendors, purchaseOrders, invoices] = await Promise.all([
    readFile(path.join(FIXTURES_DIR, 'vendors.json'), 'utf-8').then((t) => JSON.parse(t) as VendorFixture[]),
    readFile(path.join(FIXTURES_DIR, 'purchase_orders.json'), 'utf-8').then((t) => JSON.parse(t) as PurchaseOrderFixture[]),
    readFile(path.join(FIXTURES_DIR, 'invoices.json'), 'utf-8').then((t) => JSON.parse(t) as InvoiceFixture[]),
  ])

  const parts: string[] = []

  parts.push('-- Invoice Decision Engine — seed data')
  parts.push('-- Generated by scripts/generate-seed.ts from fixtures/*.json — do not hand-edit.')
  parts.push('-- Paste into the Supabase SQL editor after 001_schema.sql.')
  parts.push('')
  parts.push('-- Clean slate: cascade covers runs/stage_logs even though this file never inserts into them.')
  parts.push(
    'truncate table stage_logs, runs, invoices, purchase_orders, vendors, rules, assumptions restart identity cascade;',
  )
  parts.push('')

  parts.push('-- vendors')
  parts.push(
    buildInsert(
      'vendors',
      ['id', 'legal_name', 'aliases', 'bank_account', 'bank_ifsc', 'gstin', 'address', 'email_domain', 'status'],
      vendors.map((v) => [
        sqlString(v.id),
        sqlString(v.legal_name),
        sqlTextArray(v.aliases),
        sqlString(v.bank_account),
        sqlString(v.ifsc),
        sqlString(v.gstin),
        sqlString(formatAddress(v.address)),
        sqlString(v.email_domain),
        sqlString(v.status),
      ]),
    ),
  )

  parts.push('-- purchase_orders')
  parts.push(
    buildInsert(
      'purchase_orders',
      [
        'po_number',
        'vendor_id',
        'total_amount',
        'currency',
        'amount_billed_to_date',
        'tax_treatment',
        'status',
        'line_items',
        'delivery_schedule',
        'issued_date',
      ],
      purchaseOrders.map((po) => [
        sqlString(po.po_number),
        sqlString(po.vendor_id),
        sqlNumber(po.total_amount),
        sqlString(po.currency),
        sqlNumber(po.amount_billed_to_date),
        sqlString(po.tax_treatment),
        sqlString(po.status),
        sqlJson(po.line_items),
        sqlJson(po.delivery_schedule ?? null),
        sqlDate(po.issued_date),
      ]),
    ),
  )

  parts.push('-- rules')
  parts.push(
    buildInsert(
      'rules',
      ['key', 'value', 'unit', 'description'],
      RULES.map((r) => [sqlString(r.key), sqlNumber(r.value), sqlString(r.unit), sqlString(r.description)]),
    ),
  )

  parts.push('-- assumptions')
  parts.push(
    buildInsert(
      'assumptions',
      ['text', 'category'],
      ASSUMPTIONS.map((a) => [sqlString(a.text), sqlString(a.category)]),
    ),
  )

  parts.push('-- invoices')
  parts.push(
    buildInsert(
      'invoices',
      [
        'invoice_number',
        'file_path',
        'file_hash',
        'vendor_name_as_printed',
        'vendor_id',
        'po_reference',
        'invoice_date',
        'currency',
        'subtotal',
        'tax',
        'total',
        'bank_account_printed',
        'remit_to_name',
        'document_type',
        'line_items',
        'extraction_confidence',
        'parent_invoice_number',
        'notes_field',
        'expected_verdict',
      ],
      invoices.map((inv) => [
        sqlString(inv.invoice_number),
        sqlString(`fixtures/pdfs/${inv.pdf_filename}`),
        'NULL',
        sqlString(inv.vendor_name_as_printed),
        sqlString(inv.vendor_id),
        sqlString(inv.po_reference),
        sqlDate(inv.invoice_date),
        sqlString(inv.currency),
        sqlNumber(inv.subtotal),
        sqlNumber(inv.tax),
        sqlNumber(inv.total),
        sqlString(inv.bank_account_printed),
        sqlString(inv.remit_to_name),
        sqlString(inv.document_type),
        sqlJson(inv.line_items),
        'NULL',
        sqlString(inv.parent_invoice_number),
        sqlString(inv.notes_field),
        sqlString(inv.expected_verdict),
      ]),
    ),
  )

  const sql = parts.filter((p) => p.length > 0).join('\n') + '\n'
  await writeFile(OUTPUT_PATH, sql, 'utf-8')

  const counts: [string, number][] = [
    ['vendors', vendors.length],
    ['purchase_orders', purchaseOrders.length],
    ['rules', RULES.length],
    ['assumptions', ASSUMPTIONS.length],
    ['invoices', invoices.length],
  ]

  console.log(`\nWrote ${path.relative(ROOT, OUTPUT_PATH)}\n`)
  console.log('Row counts:')
  const nameWidth = Math.max(...counts.map(([name]) => name.length))
  for (const [name, count] of counts) {
    console.log(`  ${name.padEnd(nameWidth)}  ${count}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
