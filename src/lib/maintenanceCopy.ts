// Every sentence the maintenance screen shows.
//
// Held to the same contract as reasonCopy.ts, and for the same reason: the words
// live in one place so they can be reviewed together and cannot drift. House style
// is identical. Sentence case, no em dashes, active voice, and the plain word for
// the thing. "Delete", not "purge". "Test corpus", not "fixtures".
//
// Separate from reasonCopy.ts because that module is the table the product is
// graded on, and none of this is about a verdict or a reason code.

import { count } from './format.ts'
import { STEP_PHRASE, type DeletionStep, type InvoiceOrigin } from './maintenance.ts'

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export const MAINTENANCE_TITLE = 'Maintenance'

export const MAINTENANCE_PURPOSE =
  'Delete uploaded test documents and everything recorded about them. Nothing here can be undone.'

export const MAINTENANCE_DISABLED_TITLE = 'Maintenance is turned off'

export const MAINTENANCE_DISABLED =
  'No maintenance key is set for this deployment, so this page does nothing. Set VITE_MAINTENANCE_KEY in the environment and rebuild to turn it on.'

export const PASSPHRASE_PROMPT = 'Enter the maintenance key'

export const PASSPHRASE_WRONG = 'That key does not match. Check it and try again.'

/**
 * What the gate is, said plainly.
 *
 * This app has no sign-in and the key is compiled into the bundle that every
 * visitor downloads, so anyone who wants it can read it. Saying so on the page is
 * the only honest option: a person who believed this was a login would treat the
 * page as safer than it is.
 */
export const GATE_IS_NOT_AUTHENTICATION =
  'This key only keeps the page out of the way. It is not authentication. There is no sign-in anywhere in this app, and the key is part of the code the browser downloads, so treat it as a speed bump and not a lock.'

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export const ORIGIN_LABEL: Readonly<Record<InvoiceOrigin, string>> = {
  seeded: 'Seeded',
  uploaded: 'Uploaded',
}

export const LOCKED_LABEL = 'Test corpus'

/** What the lock on a seeded row explains when somebody hovers it. */
export const LOCKED_EXPLANATION =
  'One of the 27 seeded invoices the test corpus is made of. It cannot be deleted. Removing one would break the 27 of 27 assertion the suite makes and leave the demo short a case.'

export const UNDECIDED_LABEL = 'No verdict'

export const NO_ROWS_MATCH = 'No document matches these filters. Widen them, or clear the search.'

export const NOTHING_UPLOADED =
  'Nothing has been uploaded yet, so there is nothing to clear out. Only uploaded documents can be deleted.'

export const SELECT_ALL_VISIBLE = 'Select every one shown'

export const SEEDED_NOT_SELECTABLE = 'Seeded invoices are not selectable.'

// ---------------------------------------------------------------------------
// The confirmation
// ---------------------------------------------------------------------------

export const CONFIRM_TITLE = 'What this deletes'

export const CONFIRM_NOTHING = 'Select an uploaded document to see what deleting it would remove.'

/**
 * The things this page counts, singular and plural.
 *
 * Here rather than at each call site so the confirmation panel and the report
 * afterwards cannot name the same thing two different ways, which is exactly what
 * happens when a component writes the word itself.
 *
 * "Saved reading" rather than "extraction": a reader is being told what is going,
 * and the row is the result of reading a page. "Stage log" stays as it is, because
 * that is what the trail is called everywhere else a person can see it.
 */
export type CountedThing = 'invoice' | 'run' | 'stageLog' | 'reading' | 'file' | 'link'

const THING_WORDS: Readonly<Record<CountedThing, readonly [string, string]>> = {
  invoice: ['invoice', 'invoices'],
  run: ['run', 'runs'],
  stageLog: ['stage log', 'stage logs'],
  reading: ['saved reading', 'saved readings'],
  file: ['stored file', 'stored files'],
  link: ['link to an earlier attempt', 'links to earlier attempts'],
}

export function thingWord(total: number, thing: CountedThing): string {
  return THING_WORDS[thing][total === 1 ? 0 : 1]
}

/** "1 invoice", "14 stage logs". The formatted count and its word, together. */
export function countedThing(total: number, thing: CountedThing): string {
  return `${count(total)} ${thingWord(total, thing)}`
}

/** What the report says about links it had to detach before it could delete. */
export function detachedLine(total: number): string {
  return `${countedThing(total, 'link')} ${total === 1 ? 'was' : 'were'} detached first.`
}

export const ORPHAN_WARNING_TITLE = 'Invoices that are staying will lose a link'

/**
 * The case that failed in SQL, put in front of the person before they confirm.
 *
 * A resubmission's run points at the run of the invoice it corrects. When the
 * earlier invoice is selected and the later one is not, the later one is left
 * pointing at nothing. Deleting the link first is what stops this failing on a
 * foreign key, and detaching it is a real loss, so it is said out loud rather than
 * discovered afterwards.
 */
export function orphanWarning(invoiceNumbers: readonly string[]): string {
  const list = listSentence(invoiceNumbers)
  const subject = invoiceNumbers.length === 1 ? `${list} is staying` : `${list} are staying`
  return `${subject}, and each one points back at an earlier attempt that is being deleted. That link goes with it, so the invoice will no longer show that it was submitted before. The invoice itself, its own runs and its decision are untouched.`
}

export const CONFIRM_BUTTON = 'Delete these documents'
export const CONFIRM_BUSY = 'Deleting'
export const CANCEL_BUTTON = 'Cancel'

export const DISCARD_FAILED_BUTTON = 'Discard all failed uploads'

export function discardFailedDescription(total: number): string {
  if (total === 0) return 'No uploaded document is waiting without a verdict.'
  const many = total !== 1
  return `${total} uploaded ${many ? 'documents' : 'document'} never reached a verdict. ${
    many ? 'They decided' : 'It decided'
  } nothing, so there is no record worth keeping.`
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

export function stepFailed(step: DeletionStep, detail: string): string {
  // The step names live in maintenance.ts, because the database raises the same
  // phrases and the two must not drift apart.
  return `Nothing was deleted. This stopped while ${STEP_PHRASE[step]}, and everything was left exactly as it was. ${detail}`
}

/**
 * A failure after the records have already gone.
 *
 * Storage is not part of the database transaction, so this one case cannot be made
 * atomic. The records are gone and some files are not, which is worth saying
 * precisely rather than reporting as a plain failure.
 */
export function filesFailed(detail: string): string {
  return `The records were deleted. The stored files were not, so they are still in the invoices bucket with nothing pointing at them. ${detail}`
}

export const DELETED_TITLE = 'Deleted'

export const MISSING_FUNCTION =
  'The maintenance function is not installed on this database, so nothing was deleted. Apply supabase/migrations/013_maintenance_delete.sql and try again.'

// ---------------------------------------------------------------------------
// Lists in a sentence
// ---------------------------------------------------------------------------

/** "A", "A and B", "A, B and C". Used wherever a sentence has to name rows. */
export function listSentence(items: readonly string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
