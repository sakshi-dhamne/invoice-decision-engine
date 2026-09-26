// Deleting test data without taking the test corpus with it.
//
// Three things here are not a matter of taste. The 27 seeded invoices cannot be
// deleted, because the suite asserts 27 of 27 against them and the demo needs every
// case. An invoice that is staying whose run points at a run that is going has to be
// named before anybody confirms, not discovered afterwards. And the order the
// deletion happens in has to make a foreign-key violation impossible, which is
// checked against the foreign keys the migrations actually declare rather than
// against a copy of them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { INVOICE_FIXTURES } from './fixtures.ts'
import {
  buildInventory,
  canDelete,
  deletableIds,
  DELETION_ORDER,
  deletionImpact,
  failedUploadIds,
  originOf,
  sortMaintenanceRows,
  stepFromMessage,
  STEP_PHRASE,
  storagePathsFor,
} from '../src/lib/maintenance.ts'
import { orphanWarning } from '../src/lib/maintenanceCopy.ts'
import type { InvoiceRow, RunRow, Verdict } from '../src/lib/database.types.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(join(repoRoot, 'supabase/migrations/013_maintenance_delete.sql'), 'utf8')
const schema = readFileSync(join(repoRoot, 'supabase/migrations/001_schema.sql'), 'utf8')
const extractions = readFileSync(join(repoRoot, 'supabase/migrations/003_extractions.sql'), 'utf8')

// ---------------------------------------------------------------------------
// Rows, as the two ways a document can arrive produce them
// ---------------------------------------------------------------------------

function invoice(overrides: Partial<InvoiceRow> & Pick<InvoiceRow, 'id' | 'invoice_number'>): InvoiceRow {
  return {
    file_path: null,
    storage_path: null,
    file_hash: null,
    vendor_name_as_printed: null,
    vendor_id: null,
    po_reference: null,
    invoice_date: null,
    currency: null,
    subtotal: null,
    tax: null,
    total: null,
    bank_account_printed: null,
    remit_to_name: null,
    document_type: 'invoice',
    line_items: null,
    extraction_confidence: null,
    parent_invoice_number: null,
    notes_field: null,
    expected_verdict: null,
    fields_not_printed: null,
    created_at: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

// 002_seed.sql inserts the corpus with a file_path off the fixture and no
// storage_path, which is the whole reason a seeded row is recognisable.
function seeded(number: string, pdf: string): InvoiceRow {
  return invoice({ id: `seeded-${number}-${pdf}`, invoice_number: number, file_path: pdf, storage_path: null })
}

function uploaded(id: string, number: string): InvoiceRow {
  const path = `uploads/1759000000000-abc123-${number}.pdf`
  return invoice({ id, invoice_number: number, file_path: path, storage_path: path })
}

function run(overrides: Partial<RunRow> & Pick<RunRow, 'id'>): RunRow {
  return {
    invoice_id: null,
    status: 'complete',
    verdict: 'AUTO_APPROVE' as Verdict,
    reason_codes: null,
    parent_run_id: null,
    changed_fields: null,
    matched_po: null,
    explanation: null,
    started_at: '2026-09-20T10:00:00Z',
    finished_at: '2026-09-20T10:00:05Z',
    touched_by_human: false,
    touched_by: null,
    approved_at: null,
    discarded_at: null,
    discarded_by: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The test corpus is not deletable
// ---------------------------------------------------------------------------

describe('the seeded corpus cannot be deleted', () => {
  const corpusRows = INVOICE_FIXTURES.map((fixture) => seeded(fixture.invoice_number, fixture.pdf_filename))

  it('is the 27 invoices the fixtures describe', () => {
    expect(INVOICE_FIXTURES).toHaveLength(27)
  })

  it.each(corpusRows.map((row) => [row.invoice_number, row] as const))(
    '%s reads as seeded and refuses deletion',
    (_number, row) => {
      expect(originOf(row)).toBe('seeded')
      expect(canDelete(row)).toBe(false)
    },
  )

  it('locks every one of them in the inventory', () => {
    const rows = buildInventory({ invoices: corpusRows, runs: [], stageLogCounts: new Map() })
    expect(rows).toHaveLength(27)
    expect(rows.filter((row) => row.locked)).toHaveLength(27)
  })

  it('deletes none of them even when every one is selected', () => {
    const rows = buildInventory({ invoices: corpusRows, runs: [], stageLogCounts: new Map() })
    const impact = deletionImpact({
      rows,
      runs: [],
      stageLogCounts: new Map(),
      selected: new Set(corpusRows.map((row) => row.id)),
    })
    expect(impact.invoices).toBe(0)
    expect(impact.runs).toBe(0)
    expect(impact.refused).toBe(27)
  })

  it('offers no storage path for one, so nothing of theirs is removed from the bucket', () => {
    const rows = buildInventory({ invoices: corpusRows, runs: [], stageLogCounts: new Map() })
    expect(storagePathsFor(rows, new Set(corpusRows.map((row) => row.id)))).toEqual([])
  })

  it('never counts one as a failed upload, however its run went', () => {
    const runs = corpusRows.map((row, index) =>
      run({ id: `run-${index}`, invoice_id: row.id, status: 'failed', verdict: null }),
    )
    const rows = buildInventory({ invoices: corpusRows, runs, stageLogCounts: new Map() })
    expect(failedUploadIds(rows)).toEqual([])
  })

  it('is refused by the database as well, not only by the screen', () => {
    // A guard that lives in a React component is one anybody can walk past by
    // calling the function directly.
    expect(migration).toContain('Refusing to delete')
    expect(migration).toMatch(/storage_path is null or btrim\(storage_path\) = ''/)
  })

  it('separates the two origins on the same test the rest of the app uses', () => {
    expect(originOf(uploaded('u1', 'INV-1'))).toBe('uploaded')
    expect(canDelete(uploaded('u1', 'INV-1'))).toBe(true)
    // An empty string is not a storage path, and a row carrying one is not an upload.
    expect(originOf(invoice({ id: 'x', invoice_number: 'INV-2', storage_path: '   ' }))).toBe('seeded')
  })
})

// ---------------------------------------------------------------------------
// The link a surviving invoice would lose
// ---------------------------------------------------------------------------

describe('the parent-link warning', () => {
  // The shape that failed in SQL: an uploaded invoice was read, held, and
  // resubmitted. The resubmission's run points back at the first attempt. Deleting
  // the first attempt while the resubmission stays is the case.
  const first = uploaded('first', 'INV-DUP-1')
  const resubmission = uploaded('resubmission', 'INV-DUP-2')
  const other = uploaded('other', 'INV-OTHER')

  const firstRun = run({ id: 'run-first', invoice_id: first.id, verdict: 'HOLD' })
  const resubmissionRun = run({
    id: 'run-resubmission',
    invoice_id: resubmission.id,
    parent_run_id: firstRun.id,
  })
  const otherRun = run({ id: 'run-other', invoice_id: other.id })

  const invoices = [first, resubmission, other]
  const runs = [resubmissionRun, firstRun, otherRun]
  const stageLogCounts = new Map([
    [firstRun.id, 7],
    [resubmissionRun.id, 7],
    [otherRun.id, 7],
  ])
  const rows = buildInventory({ invoices, runs, stageLogCounts })

  it('names the surviving invoice when its parent is being deleted', () => {
    const impact = deletionImpact({ rows, runs, stageLogCounts, selected: new Set([first.id]) })
    expect(impact.invoices).toBe(1)
    expect(impact.runs).toBe(1)
    expect(impact.stageLogs).toBe(7)
    expect(impact.orphaned).toEqual([{ invoiceNumber: 'INV-DUP-2', links: 1 }])
    expect(impact.detachedLinks).toBe(1)
  })

  it('says plainly what the surviving invoice loses', () => {
    const sentence = orphanWarning(['INV-DUP-2'])
    expect(sentence).toContain('INV-DUP-2')
    expect(sentence).toContain('is staying')
    expect(sentence).toContain('no longer show that it was submitted before')
    // What it does not lose, said in the same breath.
    expect(sentence).toContain('untouched')
  })

  it('stays quiet when both halves of the link are going', () => {
    const impact = deletionImpact({
      rows,
      runs,
      stageLogCounts,
      selected: new Set([first.id, resubmission.id]),
    })
    expect(impact.invoices).toBe(2)
    expect(impact.orphaned).toEqual([])
    // The link is still detached first. It just belongs to a run that is going too,
    // so there is nobody to warn about it.
    expect(impact.detachedLinks).toBe(1)
  })

  it('stays quiet when nothing points at what is being deleted', () => {
    const impact = deletionImpact({ rows, runs, stageLogCounts, selected: new Set([other.id]) })
    expect(impact.invoices).toBe(1)
    expect(impact.orphaned).toEqual([])
    expect(impact.detachedLinks).toBe(0)
  })

  it('names every surviving invoice, not just the first', () => {
    const secondResubmission = uploaded('second-resubmission', 'INV-DUP-3')
    const secondRun = run({
      id: 'run-second-resubmission',
      invoice_id: secondResubmission.id,
      parent_run_id: firstRun.id,
    })
    const allRuns = [...runs, secondRun]
    const allRows = buildInventory({
      invoices: [...invoices, secondResubmission],
      runs: allRuns,
      stageLogCounts,
    })
    const impact = deletionImpact({
      rows: allRows,
      runs: allRuns,
      stageLogCounts,
      selected: new Set([first.id]),
    })
    expect(impact.orphaned.map((entry) => entry.invoiceNumber)).toEqual(['INV-DUP-2', 'INV-DUP-3'])
    expect(orphanWarning(['INV-DUP-2', 'INV-DUP-3'])).toContain('INV-DUP-2 and INV-DUP-3 are staying')
  })
})

// ---------------------------------------------------------------------------
// The order, checked against the foreign keys themselves
// ---------------------------------------------------------------------------

interface ForeignKey {
  table: string
  column: string
  target: string
  cascades: boolean
}

/** Every foreign key the migrations declare, read from the create-table blocks. */
function foreignKeys(sql: string): ForeignKey[] {
  const keys: ForeignKey[] = []
  for (const block of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
    const table = block[1]
    for (const line of block[2].split('\n')) {
      const match = /^\s*(\w+)\s+[\w()]+.*?references\s+(\w+)\s*\(/.exec(line)
      if (!match) continue
      keys.push({
        table,
        column: match[1],
        target: match[2],
        cascades: /on delete cascade/.test(line),
      })
    }
  }
  return keys
}

describe('the deletion order makes a foreign-key violation impossible', () => {
  const keys = [...foreignKeys(schema), ...foreignKeys(extractions)]
  const intoTargets = keys.filter((key) => key.target === 'invoices' || key.target === 'runs')

  it('reads the foreign keys it is reasoning about', () => {
    // If this ever comes back empty the rest of this block proves nothing.
    expect(intoTargets.length).toBeGreaterThan(0)
  })

  it('finds exactly the references into what gets deleted', () => {
    expect(
      intoTargets
        .map((key) => `${key.table}.${key.column} -> ${key.target}${key.cascades ? ' (cascade)' : ''}`)
        .sort(),
    ).toEqual([
      'extractions.invoice_id -> invoices (cascade)',
      'runs.invoice_id -> invoices',
      'runs.parent_run_id -> runs',
      'stage_logs.run_id -> runs (cascade)',
    ])
  })

  it('handles every reference that does not cascade, and leaves the rest to Postgres', () => {
    // A cascading reference needs no step. A reference that does not cascade needs
    // either its own rows deleted first or its column detached first, and the plan
    // has to say which. This is what fails if somebody adds a third one.
    const handled: Record<string, 'detach' | 'runs'> = {
      'runs.parent_run_id': 'detach',
      'runs.invoice_id': 'runs',
    }
    for (const key of intoTargets) {
      if (key.cascades) continue
      expect(handled[`${key.table}.${key.column}`], `${key.table}.${key.column} is unhandled`).toBeTruthy()
    }
  })

  it('detaches the parent links before deleting any run', () => {
    // runs.parent_run_id points at runs and does not cascade, so a surviving run
    // pointing into the set is a violation unless the column is cleared first.
    expect(DELETION_ORDER.indexOf('detach')).toBeLessThan(DELETION_ORDER.indexOf('runs'))
  })

  it('deletes the runs before the invoices they decided', () => {
    // runs.invoice_id points at invoices and does not cascade.
    expect(DELETION_ORDER.indexOf('runs')).toBeLessThan(DELETION_ORDER.indexOf('invoices'))
  })

  it('removes the stored files last, because storage is not in the transaction', () => {
    expect(DELETION_ORDER[DELETION_ORDER.length - 1]).toBe('files')
  })

  it('is the order the migration actually executes', () => {
    const detach = migration.indexOf('update runs\n     set parent_run_id = null')
    const deleteRuns = migration.indexOf('delete from runs where invoice_id = any(invoice_ids)')
    const deleteInvoices = migration.indexOf('delete from invoices where id = any(invoice_ids)')
    expect(detach).toBeGreaterThan(-1)
    expect(deleteRuns).toBeGreaterThan(detach)
    expect(deleteInvoices).toBeGreaterThan(deleteRuns)
  })

  it('detaches every run pointing into the set, including ones it is not deleting', () => {
    // Scoped by parent_run_id rather than by invoice, which is the difference
    // between this working and failing on the resubmission case.
    expect(migration).toContain('where parent_run_id = any(target_runs)')
  })

  it('rolls the whole thing back rather than half-deleting, and names the step', () => {
    expect(migration).toContain('exception')
    expect(migration).toContain('Maintenance delete stopped while %')
    for (const step of ['detach', 'runs', 'invoices'] as const) {
      expect(migration, step).toContain(STEP_PHRASE[step])
    }
  })

  it('attributes a database error to the step that raised it', () => {
    expect(stepFromMessage(`Maintenance delete stopped while ${STEP_PHRASE.runs}: boom`)).toBe('runs')
    expect(stepFromMessage(`Maintenance delete stopped while ${STEP_PHRASE.invoices}: boom`)).toBe('invoices')
    // Nothing was deleted either way, so an unplaceable failure claims the least.
    expect(stepFromMessage('connection reset')).toBe('detach')
  })
})

// ---------------------------------------------------------------------------
// The rest of the screen
// ---------------------------------------------------------------------------

describe('failed uploads', () => {
  const decided = uploaded('decided', 'INV-OK')
  const failed = uploaded('failed', 'INV-BAD')
  const neverRan = uploaded('never-ran', 'INV-NEW')
  const reread = uploaded('reread', 'INV-RETRY')

  const runs = [
    run({ id: 'r-decided', invoice_id: decided.id }),
    run({ id: 'r-failed', invoice_id: failed.id, status: 'failed', verdict: null }),
    // Read once and failed, read again after onboarding and decided. That document
    // was decided, so it is not clutter.
    run({ id: 'r-reread-2', invoice_id: reread.id, started_at: '2026-09-21T10:00:00Z' }),
    run({ id: 'r-reread-1', invoice_id: reread.id, status: 'failed', verdict: null }),
  ]

  const rows = buildInventory({
    invoices: [decided, failed, neverRan, reread],
    runs,
    stageLogCounts: new Map(),
  })

  it('is everything uploaded that never reached a verdict', () => {
    expect(failedUploadIds(rows).sort()).toEqual(['failed', 'never-ran'])
  })

  it('counts a document nothing ever ran on, because nothing happened to it', () => {
    expect(rows.find((row) => row.invoice.id === 'never-ran')?.neverDecided).toBe(true)
  })

  it('spares a document that failed once and was decided on a later run', () => {
    expect(rows.find((row) => row.invoice.id === 'reread')?.neverDecided).toBe(false)
    expect(rows.find((row) => row.invoice.id === 'reread')?.outcome).toBe('AUTO_APPROVE')
  })

  it('takes every run of a document, not just the latest', () => {
    const impact = deletionImpact({
      rows,
      runs,
      stageLogCounts: new Map([['r-reread-1', 3], ['r-reread-2', 7]]),
      selected: new Set(['reread']),
    })
    expect(impact.runs).toBe(2)
    expect(impact.stageLogs).toBe(10)
  })
})

describe('the list sorts the way the other lists do', () => {
  const rows = buildInventory({
    invoices: [
      uploaded('b', 'INV-B'),
      uploaded('a', 'INV-A'),
      seeded('INV-C', 'INV-C.pdf'),
    ],
    runs: [],
    stageLogCounts: new Map(),
  })

  it('turns around when the same heading is read the other way', () => {
    const up = sortMaintenanceRows(rows, 'invoice', 'asc').map((row) => row.invoice.invoice_number)
    const down = sortMaintenanceRows(rows, 'invoice', 'desc').map((row) => row.invoice.invoice_number)
    expect(up).toEqual(['INV-A', 'INV-B', 'INV-C'])
    expect(down).toEqual([...up].reverse())
  })

  it('groups by origin when asked to', () => {
    expect(sortMaintenanceRows(rows, 'origin', 'asc').map((row) => row.origin)).toEqual([
      'seeded',
      'uploaded',
      'uploaded',
    ])
  })
})

// ---------------------------------------------------------------------------
// How the screen is reached, and how it is kept out of the way
// ---------------------------------------------------------------------------

describe('the maintenance screen is reachable only on purpose', () => {
  const app = readFileSync(join(repoRoot, 'src/App.tsx'), 'utf8')
  const shell = readFileSync(join(repoRoot, 'src/components/AppShell.tsx'), 'utf8')
  const palette = readFileSync(join(repoRoot, 'src/components/CommandPalette.tsx'), 'utf8')
  const page = readFileSync(join(repoRoot, 'src/pages/Maintenance.tsx'), 'utf8')

  it('is routed', () => {
    expect(app).toContain('path="/maintenance"')
  })

  it('is on neither the sidebar nor the command palette', () => {
    expect(shell.toLowerCase()).not.toContain('maintenance')
    expect(palette.toLowerCase()).not.toContain('maintenance')
  })

  it('renders nothing but a message when no key is set', () => {
    // The whole page is behind this, so an unset key cannot leave a delete button
    // on screen.
    expect(page).toContain('if (MAINTENANCE_KEY.length === 0)')
    expect(page).toContain('MAINTENANCE_DISABLED')
    const gateIndex = page.indexOf('if (!unlocked) return <Gate')
    const disabledIndex = page.indexOf('if (MAINTENANCE_KEY.length === 0)')
    expect(disabledIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(disabledIndex)
  })

  it('reads the key from the environment and compares against what was typed', () => {
    expect(page).toContain('import.meta.env.VITE_MAINTENANCE_KEY')
    expect(page).toContain('entered.trim() === MAINTENANCE_KEY')
  })

  it('says on the page that the key is not authentication', () => {
    const copy = readFileSync(join(repoRoot, 'src/lib/maintenanceCopy.ts'), 'utf8')
    expect(copy).toContain('It is not authentication.')
    expect(copy).toContain('no sign-in')
    // Rendered, not merely defined.
    expect(page).toContain('GATE_IS_NOT_AUTHENTICATION')
  })

  it('leaves the development harness alone', () => {
    expect(app).toContain('path="/harness"')
  })
})

describe('what a delete is actually asked to remove', () => {
  const seededRow = seeded('INV-C', 'INV-C.pdf')
  const uploadedRow = uploaded('u1', 'INV-U')
  const rows = buildInventory({
    invoices: [seededRow, uploadedRow],
    runs: [],
    stageLogCounts: new Map(),
  })

  it('sends only the uploaded ids, whatever was passed in', () => {
    expect(deletableIds(rows, new Set([seededRow.id, uploadedRow.id]))).toEqual([uploadedRow.id])
  })

  it('sends nothing when only seeded rows were passed', () => {
    expect(deletableIds(rows, new Set([seededRow.id]))).toEqual([])
  })

  it('offers the storage path of an upload and of nothing else', () => {
    expect(storagePathsFor(rows, new Set([seededRow.id, uploadedRow.id]))).toEqual([uploadedRow.storage_path])
  })
})
