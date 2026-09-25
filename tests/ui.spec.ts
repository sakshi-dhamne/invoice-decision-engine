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
import { FAILED_RUN_LABEL, FAILED_RUN_SENTENCE } from '../src/lib/reasonCopy.ts'
import { rowForShortId } from '../src/lib/feed.ts'
import { BUSINESS_DIFF_FIELDS } from '../src/lib/decisionData.ts'
import { EXPLAIN_PROMPT, buildExplainUserMessage, fallbackExplanation } from '../src/rules/explain.ts'
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
// Nothing on screen that does nothing
// ---------------------------------------------------------------------------

describe('the queue offers no control it cannot act on', () => {
  const exceptions = readFileSync(join(repoRoot, 'src/pages/Exceptions.tsx'), 'utf8')

  it('has no fetch button, which only ever had nothing to fetch', () => {
    // Every seeded invoice has a completed run, so it worked through an empty
    // list and reported nothing. A control that answers nothing is worse than no
    // control.
    expect(exceptions).not.toContain('Fetch new invoices')
    expect(exceptions).not.toContain('getInvoicesWithoutCompletedRun')
  })

  it('leaves no query behind that only that button called', () => {
    const queries = readFileSync(join(repoRoot, 'src/lib/queries.ts'), 'utf8')
    expect(queries).not.toContain('getInvoicesWithoutCompletedRun')
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

  // An explanation that asserts an outcome is wrong the moment a person
  // overrides it, and it was: an approved invoice sat under a paragraph
  // explaining why it had been put under review. The chip and the override
  // banner carry the outcome. This carries the findings, which stay true.
  it('forbids the model from saying what happens to the invoice', () => {
    expect(EXPLAIN_PROMPT).toContain('Never say what happens to the invoice')
    for (const outcome of ['approved', 'held', 'blocked', 'under review']) {
      expect(EXPLAIN_PROMPT, outcome).toContain(outcome)
    }
  })

  it('does not hand the model the verdict at all', () => {
    // The surest way not to have it restated.
    const message = buildExplainUserMessage({
      verdict: 'BLOCK',
      reason_codes: ['BANK_DETAIL_MISMATCH'],
      evidence: {},
      summary: { invoice_number: 'ZT-1' },
    })
    expect(message).not.toContain('BLOCK')
    expect(message).toContain('BANK_DETAIL_MISMATCH')
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
    // The problem comes first, and the document second. Neither is an outcome.
    expect(text).toContain('ZT-1')
    for (const outcome of ['on hold', 'needs somebody', 'will not be paid', 'cleared every check']) {
      expect(text.toLowerCase(), outcome).not.toContain(outcome)
    }
  })
})

// ---------------------------------------------------------------------------
// A check that compares against other invoices shows them
// ---------------------------------------------------------------------------

// Whether a near-duplicate is a resubmission or a monthly bill is the whole
// judgement, and it is not one the rules can make. The reader was given the
// finding and none of the evidence behind it.
describe('cross-invoice findings show what they were compared against', () => {
  const detail = readFileSync(join(repoRoot, 'src/components/DecisionDetail.tsx'), 'utf8')

  it('shows the panel only when such a check actually fired', () => {
    expect(detail).toContain('data.othersLikeThis.length > 0')
  })

  it('reads both cross-invoice checks, not just the duplicate one', () => {
    const data = readFileSync(join(repoRoot, 'src/lib/decisionData.ts'), 'utf8')
    expect(data).toContain("comparedInvoices(validations, 'near_duplicate', 'matches')")
    expect(data).toContain("comparedInvoices(validations, 'threshold_split', 'invoices')")
  })

  it('puts the days between them and the difference in amount on each row', () => {
    expect(detail).toContain('days apart')
    expect(detail).toContain('row.amountDifference')
  })

  it('links every invoice it lists to its decision', () => {
    expect(detail).toContain('to={`/decisions/${row.runId}`}')
  })

  it('marks the ones whose value the order has already committed', () => {
    expect(detail).toContain('row.countsAgainstTheOrder')
  })
})

// ---------------------------------------------------------------------------
// Orders are somewhere a person can look
// ---------------------------------------------------------------------------

describe('purchase orders have a screen', () => {
  it('is on the sidebar', () => {
    const shell = readFileSync(join(repoRoot, 'src/components/AppShell.tsx'), 'utf8')
    expect(shell).toContain("{ to: '/orders', label: 'Orders'")
  })

  it('is routed, with the order number never read as the word new', () => {
    const app = readFileSync(join(repoRoot, 'src/App.tsx'), 'utf8')
    const list = app.indexOf('path="/orders"')
    const raise = app.indexOf('path="/orders/new"')
    const one = app.indexOf('path="/orders/:poNumber"')
    expect(list).toBeGreaterThan(-1)
    expect(raise).toBeLessThan(one)
  })

  it('is linked from the order panel on a decision', () => {
    const detail = readFileSync(join(repoRoot, 'src/components/DecisionDetail.tsx'), 'utf8')
    expect(detail).toContain('to={`/orders/${encodeURIComponent(data.order.po_number)}`}')
  })

  it('can be raised before any invoice exists, from the list', () => {
    const orders = readFileSync(join(repoRoot, 'src/pages/Orders.tsx'), 'utf8')
    expect(orders).toContain('to="/orders/new"')
    expect(orders).toContain('{NEW_ORDER_LABEL}')
  })

  it('sends the same address to the standalone form when no invoice is in scope', () => {
    // The two flows are the same act, with and without a document in front of
    // you. Opened without one, this used to answer with an error telling the
    // reader to go and find an invoice first.
    const page = readFileSync(join(repoRoot, 'src/pages/OrderNew.tsx'), 'utf8')
    expect(page).toContain('if (!fromRunId) return <OrderCreate />')
  })

  it('offers only vendors an invoice could actually be paid against', () => {
    const newOrder = readFileSync(join(repoRoot, 'src/lib/newOrder.ts'), 'utf8')
    expect(newOrder).toContain("vendor.status === 'active'")
  })

  it('reads what an order has been billed from the invoices, not from the row', () => {
    // The column is an opening balance and nothing writes to it, so a screen that
    // reads it alone reports zero however much has been approved.
    const orders = readFileSync(join(repoRoot, 'src/lib/orders.ts'), 'utf8')
    expect(orders).toContain('approvedAgainst(order.po_number, documents)')
  })
})

// ---------------------------------------------------------------------------
// Nothing looks like a control unless it is one
// ---------------------------------------------------------------------------

describe('the stages on the process page', () => {
  const process = readFileSync(join(repoRoot, 'src/pages/Process.tsx'), 'utf8')

  it('carries no arrow that does nothing', () => {
    expect(process).not.toContain('ArrowRight')
  })

  it('opens each stage on what that stage looks at', () => {
    expect(process).toContain('aria-expanded={expanded}')
    expect(process).toContain('stageChecks(stage)')
  })

  it('takes the checks from the table the engine is described by', () => {
    // So a check added to the engine appears here without anyone writing it out
    // a second time.
    const copy = readFileSync(join(repoRoot, 'src/lib/reasonCopy.ts'), 'utf8')
    expect(copy).toContain('validate: Object.values(CHECK_LABEL)')
  })
})

// ---------------------------------------------------------------------------
// Lists are keyed on the run, not on the invoice number
// ---------------------------------------------------------------------------

// Invoice numbers repeat. A resubmission carries the number of the document it
// corrects, and so does every copy of a file somebody forwards twice. Keying a
// list on the number highlighted both records and opened neither.
describe('a row is identified by its run', () => {
  const exceptions = readFileSync(join(repoRoot, 'src/pages/Exceptions.tsx'), 'utf8')
  const palette = readFileSync(join(repoRoot, 'src/components/CommandPalette.tsx'), 'utf8')

  it('resolves the selection from the run in the URL', () => {
    expect(exceptions).toContain("rowForShortId(queue, params.get('run'))")
    // Not by looking the number up, which is what could match twice.
    expect(exceptions).not.toMatch(/findIndex\([^)]*invoice_number === /)
  })

  it('writes both the number and the run into the URL', () => {
    expect(exceptions).toContain("next.set('run', shortRunId(row.run.id))")
    expect(exceptions).toContain("next.set('invoice', row.invoice.invoice_number)")
  })

  it('highlights on the run', () => {
    expect(exceptions).toContain('selected?.run.id === row.run.id')
  })

  it('refuses to guess when a short run id matches more than one row', () => {
    const rows = [
      { run: { id: 'abcd1234-aaaa' } },
      { run: { id: 'abcd1234-bbbb' } },
    ] as unknown as Parameters<typeof rowForShortId>[0]
    expect(rowForShortId(rows, 'abcd1234')).toBeNull()
    expect(rowForShortId(rows, 'abcd1234-a')?.run.id).toBe('abcd1234-aaaa')
  })

  it('carries the run in the palette link too', () => {
    expect(palette).toContain('run=${shortRunId(row.run.id)}')
  })
})

// ---------------------------------------------------------------------------
// The words on the stage notes
// ---------------------------------------------------------------------------

describe('how it ran reads as English', () => {
  const pipeline = readFileSync(join(repoRoot, 'src/lib/pipeline.ts'), 'utf8')
  // Only the strings, so a comment explaining the old wording does not fail this.
  const strings = [...pipeline.matchAll(/'([^'\n]{12,})'|`([^`\n]{12,})`/g)]
    .map((match) => match[1] ?? match[2])
    .join('\n')

  it.each([
    ['content-hashed', /content-hashed/],
    ['stood down', /stood down/],
    ['a raw check-name list', /Failed: \$\{/],
    ['a rule number and an arrow', /Rule \$\{[^}]*matched_rule/],
    ['a score to three decimals', /toFixed\(3\)/],
    // A count with nothing a reader could act on. The sentence now names them.
    ['a bare count of objections', /\$\{[^}]*\}\s*checks objected\./],
    // The chain addresses its entries as provider:model. That is configuration,
    // not a name, and it was reaching the screen.
    ['a provider-prefixed model', /\$\{[^}]*provider[^}]*\}:\$\{/],
  ])('says nothing about %s', (_label, pattern) => {
    expect(pattern.test(strings)).toBe(false)
  })

  it('names the checks that objected, through reasonCopy', () => {
    expect(pipeline).toContain('objectionSentence(failures)')
    expect(pipeline).toContain('checksThatObjected(')
  })

  it('names the model through the formatter that drops the provider prefix', () => {
    expect(pipeline).toContain('modelLabel(data.model)')
  })

  it('gives a failed run something to say', () => {
    expect(FAILED_RUN_LABEL).toBe('Failed')
    expect(FAILED_RUN_SENTENCE).toBe('The file could not be read.')
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

  it.each(['setBankAccount', 'setIfsc', 'setConfirmedBy'])('%s is only ever wired to its own input', (setter) => {
    // Passed straight to the field's own onValueChange and called nowhere else.
    // Any other call site is a prefill.
    expect(source).toContain(`onValueChange={${setter}}`)
    const calls = [...source.matchAll(new RegExp(`${setter}\\(([^)]*)\\)`, 'g'))].map((match) => match[1].trim())
    expect(calls, `${setter} is called directly at ${calls.length} place(s)`).toEqual([])
  })

  it.each(['bank-account', 'ifsc', 'confirmed-by'])('%s is a field the browser cannot fill in', (id) => {
    // Autofill and session restore write into the DOM node behind React's back.
    // UnfilledInput is what corrects that; a plain input here would not.
    expect(source).toMatch(new RegExp(`<UnfilledInput\\s+id="${id}"`))
  })

  it('seeds all three from the module that has no document to read', () => {
    expect(source).toContain("useState(emptyPaymentFields().bankAccount)")
    expect(source).toContain("useState(emptyPaymentFields().ifsc)")
    expect(source).toContain("useState(emptyPaymentFields().confirmedBy)")
  })

  it('gates the form on paymentFieldsComplete', () => {
    expect(source).toContain('paymentFieldsComplete({ bankAccount, ifsc, confirmedBy })')
    expect(source).toContain('disabled={!ready || submitting !== null}')
  })

  it('keeps the sentence that says why, in the interface rather than in a comment', () => {
    expect(source).toContain(
      'Confirm these with the vendor on a phone number you already have. If we copied them off the invoice,',
    )
  })

  it('shows the printed account and IFSC for comparison without letting either reach a field', () => {
    expect(source).toContain('printedBankAccount')
    expect(source).toContain('printedIfsc')
    // Displayed, never handed to a setter.
    expect(source).not.toMatch(/setBankAccount\(\s*printedBankAccount/)
    expect(source).not.toMatch(/setIfsc\(\s*printedIfsc/)
  })
})
