// The generality guard.
//
// Two halves. First, a company that appears nowhere in the fixture corpus is
// pushed through the same pipeline and must reach a sensible verdict — and must
// flip to BLOCK when its bank account is mutated. Second, the rules engine's own
// source is scanned for fixture identifiers, so the constraint stays enforced
// rather than being checked once by hand.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { decideInvoice } from '../src/rules/decide.ts'
import { INVOICE_FIXTURES, PO_FIXTURES, VENDOR_FIXTURES, rules } from './fixtures.ts'
import { AS_OF } from './harness.ts'
import { SYNTHETIC_POS, SYNTHETIC_VENDORS, syntheticInvoice } from './synthetic.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// A company that is in no fixture
// ---------------------------------------------------------------------------

describe('an invoice from a company absent from every fixture', () => {
  const run = (facts = syntheticInvoice()) =>
    decideInvoice({
      facts,
      vendors: SYNTHETIC_VENDORS,
      purchaseOrders: SYNTHETIC_POS,
      rules,
      asOf: AS_OF,
      submissionId: 'westmark-0042',
      submissions: [],
      priorHashes: [],
      parentRun: null,
    })

  it('shares no identifier with the corpus', () => {
    const facts = syntheticInvoice()
    const corpusStrings = new Set<string>([
      ...INVOICE_FIXTURES.map((invoice) => invoice.invoice_number),
      ...PO_FIXTURES.map((po) => po.po_number),
      ...VENDOR_FIXTURES.flatMap((vendor) => [vendor.id, vendor.legal_name, ...(vendor.aliases ?? [])]),
    ])
    for (const value of [facts.invoice_number, facts.po_reference, facts.vendor_name, SYNTHETIC_VENDORS[0].id]) {
      expect(corpusStrings.has(String(value))).toBe(false)
    }
    const corpusTotals = new Set(INVOICE_FIXTURES.map((invoice) => invoice.total))
    expect(corpusTotals.has(facts.total)).toBe(false)
  })

  it('resolves its vendor, matches its order and auto-approves', () => {
    const result = run()
    expect(result.vendorMatch.vendor?.id).toBe(SYNTHETIC_VENDORS[0].id)
    expect(result.poMatch.outcome).toBe('explicit')
    expect(result.poMatch.matched?.po_number).toBe(SYNTHETIC_POS[0].po_number)
    expect(result.decision.verdict).toBe('AUTO_APPROVE')
    expect(result.decision.primary).toBe('CLEAN_MATCH')
  })

  it('flips to BLOCK when its bank account is mutated', () => {
    const mutated = run(syntheticInvoice({ bank_account: '778899001122999' }))
    expect(mutated.decision.verdict).toBe('BLOCK')
    expect(mutated.decision.primary).toBe('BANK_DETAIL_MISMATCH')
    expect(mutated.decision.evidence.BANK_DETAIL_MISMATCH).toMatchObject({
      invoice_bank: '778899001122999',
      master_bank: '778899001122334',
    })
  })

  it('flows through identical code with an empty vendor master — nothing is assumed present', () => {
    const result = decideInvoice({
      facts: syntheticInvoice(),
      vendors: [],
      purchaseOrders: [],
      rules,
      asOf: AS_OF,
    })
    expect(result.decision.verdict).toBe('HOLD')
    expect(result.decision.primary).toBe('UNKNOWN_VENDOR')
  })
})

// ---------------------------------------------------------------------------
// No fixture identifier in the engine's source
// ---------------------------------------------------------------------------

// Removes line and block comments while leaving string and template literals
// intact, so a fixture name mentioned in prose does not count but one in code does.
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (quote) {
      if (char === '\\') {
        out += char + (next ?? '')
        index += 2
        continue
      }
      if (char === quote) quote = null
      out += char
      index++
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index++
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index += 2
      continue
    }

    out += char
    index++
  }

  return out
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

const scannedFiles = [
  ...walk(join(repoRoot, 'src/rules')),
  join(repoRoot, 'src/lib/pipeline.ts'),
  ...walk(join(repoRoot, 'supabase/functions')),
]

// The brief's list, plus every identifier and name the corpus actually contains.
const FORBIDDEN_LITERALS = [
  'INV-',
  'PO-20',
  'V00',
  'CN-SOS',
  ...INVOICE_FIXTURES.map((invoice) => invoice.invoice_number),
  ...PO_FIXTURES.map((po) => po.po_number),
  ...VENDOR_FIXTURES.flatMap((vendor) => [vendor.id, vendor.legal_name, ...(vendor.aliases ?? [])]),
  // The distinctive word of each vendor's name on its own, so a partial reference
  // cannot slip through either.
  ...VENDOR_FIXTURES.map((vendor) => vendor.legal_name.split(' ')[0]),
]

const uniqueLiterals = [...new Set(FORBIDDEN_LITERALS)].filter((literal) => literal.length >= 2)

describe('the rules engine names no fixture', () => {
  it('scans the engine, the pipeline and the edge functions', () => {
    expect(scannedFiles.length).toBeGreaterThan(8)
  })

  it.each(uniqueLiterals)('no executable code contains %s', (literal) => {
    const offenders = scannedFiles
      .map((path) => ({ path, code: stripComments(readFileSync(path, 'utf8')) }))
      .filter((file) => file.code.toLowerCase().includes(literal.toLowerCase()))
      .map((file) => file.path.slice(repoRoot.length))

    expect(offenders).toEqual([])
  })

  it('the comment stripper keeps strings and drops comments', () => {
    expect(stripComments('const a = "keep // this"; // drop this')).toBe('const a = "keep // this"; ')
    expect(stripComments('/* drop */ const b = 1')).toBe(' const b = 1')
  })
})
