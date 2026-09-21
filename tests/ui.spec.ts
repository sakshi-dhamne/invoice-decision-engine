// Guards on the two things about this interface that are not a matter of taste:
// the words a user reads, and the split in the vendor onboarding form.
//
// Both are checked by reading the source, the way tests/generality.spec.ts checks
// that the rules engine names no fixture. A convention nobody can break by
// accident is worth more than one written down in a comment.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { REASON_SENTENCE, VERDICT_LABEL } from '../src/lib/reasonCopy.ts'
import { INTERNAL_KEYS } from '../src/lib/format.ts'
import { BUSINESS_DIFF_FIELDS } from '../src/lib/decisionData.ts'
import { EXPLAIN_PROMPT, fallbackExplanation } from '../src/rules/explain.ts'
import { REASON_CODES } from '../src/rules/types.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

// Everything that produces words a user reads, plus the stage reasoning the live
// run view prints. The harness is a development tool and is held to none of this.
//
// extractionSchema.ts is left out deliberately: what it holds is the prompt sent to
// the model, which is addressed to a model and not to a person.
const MODEL_FACING = ['extractionSchema.ts']

const productFiles = [
  ...walk(join(repoRoot, 'src/components')),
  ...walk(join(repoRoot, 'src/lib')),
  ...walk(join(repoRoot, 'src/pages')).filter((path) => !path.includes('Harness')),
].filter((path) => !MODEL_FACING.some((name) => path.endsWith(name)))

// ---------------------------------------------------------------------------
// The copy table
// ---------------------------------------------------------------------------

// Transcribed from the brief. If a sentence here and the one the product renders
// ever disagree, the product is wrong.
const BRIEF_SENTENCES: Record<string, string> = {
  CLEAN_MATCH: 'Matched the order and passed every check.',
  BANK_DETAIL_MISMATCH: 'The bank account on this invoice is not the one we have on file for this vendor.',
  PAYEE_ENTITY_MISMATCH: 'Payment is directed to a different company than the one the order was raised with.',
  UNDECLARED_AMENDMENT: 'The resubmitted invoice changes a figure we did not ask about.',
  EXACT_DUPLICATE: 'We have already processed this exact document.',
  RESUBMISSION: 'A corrected version of an invoice we held earlier. Checked again in full.',
  VENDOR_INACTIVE: 'This vendor is no longer active.',
  UNKNOWN_VENDOR: 'This company is not in the approved vendor list.',
  PO_NOT_OPEN: 'The order this invoice cites has been closed.',
  NO_PO_MATCH: 'The invoice cites no order number, so there is nothing to check it against.',
  AMBIGUOUS_PO_MATCH: 'Two open orders fit this invoice equally well.',
  INCOMPLETE_EXTRACTION: 'Something we need was not legible on the page.',
  ARITHMETIC_INCONSISTENT: 'The line items and tax do not add up to the total printed on the invoice.',
  TAX_TREATMENT_UNCLEAR: 'We cannot tell whether the figures include tax.',
  CURRENCY_MISMATCH: 'The invoice is in a different currency than the order.',
  DATE_OUT_OF_RANGE: 'The invoice date falls outside the window we accept.',
  QUANTITY_MISMATCH: 'The quantity billed is more than the order has left.',
  PRICE_VARIANCE: 'The amount billed is above the order price by more than we allow.',
  UNMATCHED_LINE_ITEM: 'A line on this invoice does not appear on the order.',
  THRESHOLD_SPLIT_SUSPECTED: 'Several invoices on one order, each just under the approval limit.',
  NEAR_DUPLICATE: 'A recent invoice from this vendor has almost the same total.',
  PO_OVERAGE: 'Billing this would take the order past its value.',
  ABOVE_AUTO_APPROVE_LIMIT: 'Above the limit for approving without a person.',
  CREDIT_NOTE: 'A credit note, so it is recorded rather than paid.',
}

describe('reason-code copy', () => {
  it.each(Object.entries(BRIEF_SENTENCES))('%s reads exactly as the brief specifies', (code, sentence) => {
    expect(REASON_SENTENCE[code as keyof typeof REASON_SENTENCE]).toBe(sentence)
  })

  it('covers every code the rules engine can emit, including the advisory one', () => {
    for (const code of REASON_CODES) {
      expect(REASON_SENTENCE[code], code).toBeTruthy()
    }
  })

  it('labels the five verdicts the way a finance person would name them', () => {
    expect(VERDICT_LABEL).toEqual({
      AUTO_APPROVE: 'Approved',
      REVIEW: 'Review',
      HOLD: 'Held',
      BLOCK: 'Blocked',
      ROUTED_NOT_PAID: 'Recorded',
    })
  })

  it('writes no sentence anywhere but reasonCopy.ts', () => {
    const elsewhere = productFiles.filter((path) => !path.endsWith('reasonCopy.ts'))
    for (const sentence of Object.values(BRIEF_SENTENCES)) {
      const offenders = elsewhere.filter((path) => readFileSync(path, 'utf8').includes(sentence))
      expect(offenders, sentence).toEqual([])
    }
  })
})

describe('house style', () => {
  it('uses no em dash in anything a user reads', () => {
    // Comments are prose for whoever maintains this, not interface copy.
    const stripComments = (source: string) =>
      source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')

    const offenders = productFiles.filter((path) => stripComments(readFileSync(path, 'utf8')).includes('—'))
    expect(offenders.map((path) => path.slice(repoRoot.length))).toEqual([])
  })

  it('defines every colour in the token block and nowhere else', () => {
    const offenders = productFiles.filter((path) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(path, 'utf8')))
    expect(offenders.map((path) => path.slice(repoRoot.length))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// What reaches the screen
// ---------------------------------------------------------------------------

// A file hash, a row id and a storage key are how this software finds things
// again, not facts about an invoice. They appear in the audit block on the
// History tab and nowhere else.
describe('internal references stay out of the way', () => {
  const detail = readFileSync(join(repoRoot, 'src/components/DecisionDetail.tsx'), 'utf8')

  it('filters them out of every evidence block, centrally', () => {
    const primitives = readFileSync(join(repoRoot, 'src/components/Primitives.tsx'), 'utf8')
    expect(primitives).toContain('isInternalKey(key)')
    for (const key of ['file_hash', 'run_id', 'invoice_id', 'storage_path']) {
      expect(INTERNAL_KEYS.has(key), key).toBe(true)
    }
  })

  it('names the hash and the storage key only inside the audit block', () => {
    // Both appear twice: once in the copied text, once in the rendered list. Both
    // of those are the audit block on the History tab.
    expect(detail.match(/file_hash/g)?.length ?? 0).toBeLessThanOrEqual(2)
    expect(detail.match(/storage_path/g)?.length ?? 0).toBeLessThanOrEqual(2)
    expect(detail).toContain('For an auditor')
  })

  it('shows the reason codes once, in the verdict card', () => {
    // The chip markup appears once. "Why this outcome" lists sentences only.
    expect(detail.match(/identifier inline-flex items-center rounded border/g)?.length ?? 0).toBe(1)
  })

  it('diffs business fields, and never the file', () => {
    expect(BUSINESS_DIFF_FIELDS).toContain('total')
    expect(BUSINESS_DIFF_FIELDS).toContain('bank_account')
    expect(BUSINESS_DIFF_FIELDS).not.toContain('file_hash')
    expect(BUSINESS_DIFF_FIELDS).not.toContain('notes')
  })
})

// ---------------------------------------------------------------------------
// The shell fills the screen
// ---------------------------------------------------------------------------

describe('layout', () => {
  it('puts no maximum width on the shell', () => {
    const shell = readFileSync(join(repoRoot, 'src/components/AppShell.tsx'), 'utf8')
    expect(shell).not.toMatch(/max-w-\[/)
    expect(shell).not.toMatch(/\bmax-w-(screen|7xl|6xl|5xl|4xl|3xl|2xl|xl|lg)\b/)
  })
})

// ---------------------------------------------------------------------------
// The explanation voice
// ---------------------------------------------------------------------------

describe('explanations are written to the reader', () => {
  it('asks the model for the register the brief specifies', () => {
    expect(EXPLAIN_PROMPT).toContain('under 60 words')
    expect(EXPLAIN_PROMPT.toLowerCase()).toContain('never name the system')
    expect(EXPLAIN_PROMPT).toContain('Write to the reader')
  })

  it('never lets the system be the subject of the fallback sentence', () => {
    const text = fallbackExplanation({
      verdict: 'HOLD',
      reason_codes: ['UNKNOWN_VENDOR', 'NO_PO_MATCH'],
      evidence: {},
      summary: { invoice_number: 'ZT-1', vendor_name: 'A Company', total: 92000, currency: 'INR' },
    })
    expect(text.toLowerCase()).not.toContain('accounts payable')
    expect(text.split(/\s+/).length).toBeLessThan(60)
    // The problem comes first, the outcome second.
    expect(text.indexOf('approved vendor') === -1 || text.indexOf('on hold') > 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The onboarding split
// ---------------------------------------------------------------------------

// This is a control, not a preference. Filling the bank fields from the invoice
// would point the bank-detail check at the document it is meant to be checking,
// and every future invoice from the vendor would then agree with itself.
describe('vendor onboarding keeps payment details off the invoice', () => {
  const source = readFileSync(join(repoRoot, 'src/pages/VendorNew.tsx'), 'utf8')

  it.each(['setBankAccount', 'setIfsc', 'setConfirmedBy'])('%s is only ever called from its own input', (setter) => {
    const calls = [...source.matchAll(new RegExp(`${setter}\\(([^)]*)\\)`, 'g'))].map((match) => match[1].trim())
    // Two callers are legitimate: the useState declaration's own setter name, and
    // the onChange handler. Anything else is a prefill.
    for (const argument of calls) {
      expect(argument, `${setter} was called with ${argument}`).toBe('event.target.value')
    }
  })

  it.each(['bankAccount', 'ifsc', 'confirmedBy'])('%s starts empty', (field) => {
    const declaration = new RegExp(`const \\[${field}, set\\w+\\] = useState\\(''\\)`)
    expect(declaration.test(source), `${field} does not start as an empty string`).toBe(true)
  })

  it('requires all three before the form can be submitted', () => {
    expect(source).toContain('bankAccount.trim().length > 0')
    expect(source).toContain('ifsc.trim().length > 0')
    expect(source).toContain('confirmedBy.trim().length > 0')
    expect(source).toContain('disabled={!ready || submitting !== null}')
  })

  it('keeps the sentence that says why, in the interface rather than in a comment', () => {
    expect(source).toContain(
      'Confirm these with the vendor on a phone number you already have. If we copied them off the invoice,',
    )
  })

  it('shows the printed account for comparison without letting it reach a field', () => {
    expect(source).toContain('printedBankAccount')
    // The value read off the document is displayed, never handed to a setter.
    expect(source).not.toMatch(/setBankAccount\(\s*printedBankAccount/)
  })
})
