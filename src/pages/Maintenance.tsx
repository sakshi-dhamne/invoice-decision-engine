// Clearing uploaded test data out, deliberately.
//
// Not on the sidebar and not in the command palette. This is a screen somebody goes
// to on purpose, once, when a demo database has filled up with documents that were
// only ever there to see whether the reading worked.
//
// Two things are load bearing. The seeded corpus cannot be selected, because the
// suite asserts 27 of 27 against it and the demo needs every case. And the
// confirmation panel counts what is about to go before it goes, including the one
// case that is not obvious: an invoice that is staying whose run points at a run
// that is not. That link is what failed on a foreign key when this was attempted by
// hand in SQL, and a person should see it before confirming rather than after.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ChevronUp, Lock } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import {
  EmptyState,
  ErrorNote,
  Loading,
  OutcomeChip,
  PageBody,
  Panel,
  PanelHeading,
  Spinner,
} from '@/components/Primitives.tsx'
import { Button } from '@/components/ui/button'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { count, dateAndTime } from '@/lib/format.ts'
import { VERDICT_LABEL } from '@/lib/reasonCopy.ts'
import {
  buildInventory,
  deletableIds,
  deletionImpact,
  failedUploadIds,
  filePathOf,
  matchesMaintenanceSearch,
  matchesOrigin,
  matchesOutcome,
  sortMaintenanceRows,
  storagePathsFor,
  vendorAsPrinted,
  type DeletionImpact,
  type MaintenanceOriginFilter,
  type MaintenanceOutcomeFilter,
  type MaintenanceRow,
  type MaintenanceSortKey,
} from '@/lib/maintenance.ts'
import {
  CANCEL_BUTTON,
  CONFIRM_BUSY,
  countedThing,
  detachedLine,
  thingWord,
  type CountedThing,
  CONFIRM_BUTTON,
  CONFIRM_NOTHING,
  CONFIRM_TITLE,
  DELETED_TITLE,
  DISCARD_FAILED_BUTTON,
  discardFailedDescription,
  filesFailed,
  GATE_IS_NOT_AUTHENTICATION,
  listSentence,
  LOCKED_EXPLANATION,
  LOCKED_LABEL,
  MAINTENANCE_DISABLED,
  MAINTENANCE_DISABLED_TITLE,
  MAINTENANCE_PURPOSE,
  MAINTENANCE_TITLE,
  MISSING_FUNCTION,
  NO_ROWS_MATCH,
  NOTHING_UPLOADED,
  ORIGIN_LABEL,
  ORPHAN_WARNING_TITLE,
  orphanWarning,
  PASSPHRASE_PROMPT,
  PASSPHRASE_WRONG,
  SEEDED_NOT_SELECTABLE,
  SELECT_ALL_VISIBLE,
  stepFailed,
  UNDECIDED_LABEL,
} from '@/lib/maintenanceCopy.ts'
import {
  deleteInvoicesAndFiles,
  getMaintenanceInventory,
  type DeletionReport,
  type MaintenanceInventory,
} from '@/lib/queries.ts'

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The key this deployment was built with, if it was built with one.
 *
 * Read at module scope because it is compiled in: Vite substitutes the literal at
 * build time, so there is nothing to re-read and no point pretending otherwise.
 */
const MAINTENANCE_KEY = import.meta.env.VITE_MAINTENANCE_KEY?.trim() ?? ''

export default function Maintenance() {
  const [unlocked, setUnlocked] = useState(false)

  if (MAINTENANCE_KEY.length === 0) {
    return (
      <AppShell>
        <PageBody>
          <div className="max-w-2xl space-y-4">
            <h1 className="text-2xl font-semibold text-ink">{MAINTENANCE_TITLE}</h1>
            <Panel className="px-5 py-4">
              <p className="text-sm font-medium text-ink">{MAINTENANCE_DISABLED_TITLE}</p>
              <p className="mt-1 text-sm text-muted">{MAINTENANCE_DISABLED}</p>
            </Panel>
          </div>
        </PageBody>
      </AppShell>
    )
  }

  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />

  return <Inventory />
}

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [entered, setEntered] = useState('')
  const [wrong, setWrong] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (entered.trim() === MAINTENANCE_KEY) onUnlock()
    else setWrong(true)
  }

  return (
    <AppShell>
      <PageBody>
        <div className="max-w-2xl space-y-4">
          <h1 className="text-2xl font-semibold text-ink">{MAINTENANCE_TITLE}</h1>
          <p className="text-sm text-muted">{MAINTENANCE_PURPOSE}</p>

          <Panel className="px-5 py-5">
            <form onSubmit={submit}>
              <label htmlFor="maintenance-key" className="block text-xs text-muted">
                {PASSPHRASE_PROMPT}
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="maintenance-key"
                  type="password"
                  value={entered}
                  onChange={(event) => {
                    setEntered(event.target.value)
                    setWrong(false)
                  }}
                  autoComplete="off"
                  className="h-9 w-72 rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
                />
                <Button type="submit" disabled={entered.trim().length === 0}>
                  Unlock
                </Button>
              </div>
              {wrong ? <p className={cn('mt-2 text-sm', tone('block').text)}>{PASSPHRASE_WRONG}</p> : null}
            </form>
          </Panel>

          <GateNote />
        </div>
      </PageBody>
    </AppShell>
  )
}

/** Said on the gate and again above the list, because it is the point. */
function GateNote() {
  return (
    <Panel className="px-5 py-4">
      <p className="text-sm text-muted">{GATE_IS_NOT_AUTHENTICATION}</p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const ORIGIN_FILTERS: { value: MaintenanceOriginFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'uploaded', label: ORIGIN_LABEL.uploaded },
  { value: 'seeded', label: ORIGIN_LABEL.seeded },
]

const OUTCOME_FILTERS: { value: MaintenanceOutcomeFilter; label: string }[] = [
  { value: 'all', label: 'Any outcome' },
  { value: 'AUTO_APPROVE', label: VERDICT_LABEL.AUTO_APPROVE },
  { value: 'REVIEW', label: VERDICT_LABEL.REVIEW },
  { value: 'HOLD', label: VERDICT_LABEL.HOLD },
  { value: 'BLOCK', label: VERDICT_LABEL.BLOCK },
  { value: 'ROUTED_NOT_PAID', label: VERDICT_LABEL.ROUTED_NOT_PAID },
  { value: 'undecided', label: UNDECIDED_LABEL },
]

const COLUMNS: [MaintenanceSortKey, string][] = [
  ['invoice', 'Invoice'],
  ['vendor', 'Vendor as printed'],
  ['file', 'File'],
  ['origin', 'Origin'],
  ['outcome', 'Outcome'],
  ['received', 'Received'],
]

const GRID = 'grid-cols-[2rem_9rem_minmax(0,1fr)_minmax(0,1fr)_6rem_7rem_11rem]'

function Inventory() {
  const [inventory, setInventory] = useState<MaintenanceInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState<MaintenanceOriginFilter>('all')
  const [outcome, setOutcome] = useState<MaintenanceOutcomeFilter>('all')
  const [sort, setSort] = useState<{ key: MaintenanceSortKey; direction: 'asc' | 'desc' }>({
    key: 'received',
    direction: 'desc',
  })
  const [deleting, setDeleting] = useState(false)
  const [report, setReport] = useState<DeletionReport | null>(null)

  const load = useCallback(async () => {
    try {
      const loaded = await getMaintenanceInventory()
      setInventory(loaded)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The documents could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => (inventory ? buildInventory(inventory) : []), [inventory])

  const visible = useMemo(() => {
    const matched = rows.filter(
      (row) =>
        matchesMaintenanceSearch(row, search) && matchesOrigin(row, origin) && matchesOutcome(row, outcome),
    )
    return sortMaintenanceRows(matched, sort.key, sort.direction)
  }, [rows, search, origin, outcome, sort])

  const selectableVisible = useMemo(() => visible.filter((row) => !row.locked), [visible])
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((row) => selected.has(row.invoice.id))

  const impact = useMemo(
    () =>
      inventory
        ? deletionImpact({ rows, runs: inventory.runs, stageLogCounts: inventory.stageLogCounts, selected })
        : null,
    [inventory, rows, selected],
  )

  const failedIds = useMemo(() => failedUploadIds(rows), [rows])
  const uploadedCount = rows.filter((row) => !row.locked).length

  const toggleSort = (key: MaintenanceSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'received' ? 'desc' : 'asc' },
    )

  const toggleRow = (row: MaintenanceRow) => {
    if (row.locked) return
    setReport(null)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(row.invoice.id)) next.delete(row.invoice.id)
      else next.add(row.invoice.id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setReport(null)
    setSelected((current) => {
      const next = new Set(current)
      for (const row of selectableVisible) {
        if (allVisibleSelected) next.delete(row.invoice.id)
        else next.add(row.invoice.id)
      }
      return next
    })
  }

  const runDeletion = async (requested: readonly string[]) => {
    // Filtered again here so the request matches what the panel counted, whatever
    // the caller passed.
    const chosen = new Set(requested)
    const ids = deletableIds(rows, chosen)
    if (ids.length === 0) return
    setDeleting(true)
    setError(null)
    setReport(null)
    try {
      const outcomeOfDeletion = await deleteInvoicesAndFiles(ids, storagePathsFor(rows, chosen))
      if (!outcomeOfDeletion.ok) {
        setError(
          outcomeOfDeletion.missingFunction
            ? MISSING_FUNCTION
            : stepFailed(outcomeOfDeletion.step, outcomeOfDeletion.detail),
        )
        return
      }
      setReport(outcomeOfDeletion.report)
      setSelected(new Set())
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Nothing was deleted. Try again in a moment.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-ink">{MAINTENANCE_TITLE}</h1>
              <p className="mt-1 text-sm text-muted">{MAINTENANCE_PURPOSE}</p>
            </div>
            <div>
              <label htmlFor="maintenance-search" className="sr-only">
                Search invoices, vendors and files
              </label>
              <input
                id="maintenance-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search invoices, vendors and files"
                className="h-9 w-72 rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
              />
            </div>
          </div>

          <GateNote />

          {error ? <ErrorNote title="This did not go through">{error}</ErrorNote> : null}

          {report ? <Report report={report} /> : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
            <Panel>
              <PanelHeading right={<span className="text-xs text-muted">{count(visible.length)} shown</span>}>
                Documents
              </PanelHeading>

              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-2.5">
                <label htmlFor="maintenance-origin" className="text-xs text-muted">
                  Origin
                </label>
                <select
                  id="maintenance-origin"
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value as MaintenanceOriginFilter)}
                  className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {ORIGIN_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <label htmlFor="maintenance-outcome" className="ml-2 text-xs text-muted">
                  Outcome
                </label>
                <select
                  id="maintenance-outcome"
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value as MaintenanceOutcomeFilter)}
                  className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {OUTCOME_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <span className="ml-auto text-xs text-muted">{SEEDED_NOT_SELECTABLE}</span>
              </div>

              {inventory === null ? (
                <Loading>Loading the documents</Loading>
              ) : visible.length === 0 ? (
                <EmptyState>{uploadedCount === 0 ? NOTHING_UPLOADED : NO_ROWS_MATCH}</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <div className="min-w-[960px]">
                    <div className={cn('grid gap-4 border-b border-line-soft px-5 py-1.5', GRID)}>
                      <span className="flex items-center">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          disabled={selectableVisible.length === 0}
                          onChange={toggleAllVisible}
                          aria-label={SELECT_ALL_VISIBLE}
                          title={SELECT_ALL_VISIBLE}
                          className="size-3.5 accent-ink"
                        />
                      </span>
                      {COLUMNS.map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggleSort(key)}
                          aria-sort={
                            sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                          }
                          className={cn(
                            'flex items-center gap-1 text-[11px] tracking-wide transition-colors hover:text-ink',
                            sort.key === key ? 'text-ink' : 'text-faint',
                          )}
                        >
                          {label}
                          {sort.key === key ? (
                            <ChevronUp
                              className={cn('size-3', sort.direction === 'desc' && 'rotate-180')}
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      ))}
                    </div>

                    <ul>
                      {visible.map((row) => (
                        <li key={row.invoice.id} className="border-b border-line-soft last:border-0">
                          <div className={cn('grid items-center gap-4 px-5 py-3', GRID)}>
                            <span className="flex items-center">
                              {row.locked ? (
                                // The tooltip says why, because a control a person
                                // cannot use has to explain itself. It sits on the
                                // span: an icon takes no title of its own.
                                <span title={LOCKED_EXPLANATION} aria-label={LOCKED_LABEL} role="img">
                                  <Lock className="size-3.5 text-faint" aria-hidden="true" />
                                </span>
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={selected.has(row.invoice.id)}
                                  onChange={() => toggleRow(row)}
                                  aria-label={`Select ${row.invoice.invoice_number}`}
                                  className="size-3.5 accent-ink"
                                />
                              )}
                            </span>
                            <span className="identifier truncate text-sm text-ink" title={row.invoice.invoice_number}>
                              {row.invoice.invoice_number}
                            </span>
                            <span className="truncate text-sm text-ink-soft" title={vendorAsPrinted(row)}>
                              {vendorAsPrinted(row)}
                            </span>
                            <span className="identifier truncate text-xs text-muted" title={filePathOf(row)}>
                              {filePathOf(row)}
                            </span>
                            <span className="text-sm text-muted">{ORIGIN_LABEL[row.origin]}</span>
                            <span>
                              {row.latestRun ? (
                                <OutcomeChip run={row.latestRun} size="sm" />
                              ) : (
                                <span className="text-xs text-muted">{UNDECIDED_LABEL}</span>
                              )}
                            </span>
                            <span className="text-sm text-muted tnum">{dateAndTime(row.invoice.created_at)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </Panel>

            <div className="space-y-6">
              <Confirmation
                impact={impact}
                busy={deleting}
                onConfirm={() => void runDeletion([...selected])}
                onCancel={() => {
                  setSelected(new Set())
                  setReport(null)
                }}
              />

              <Panel>
                <PanelHeading>{DISCARD_FAILED_BUTTON}</PanelHeading>
                <div className="space-y-3 px-5 py-4">
                  <p className="text-sm text-muted">{discardFailedDescription(failedIds.length)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={failedIds.length === 0 || deleting}
                    onClick={() => void runDeletion(failedIds)}
                    className="w-full gap-2"
                  >
                    {deleting ? <Spinner /> : null}
                    {DISCARD_FAILED_BUTTON}
                  </Button>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </PageBody>
    </AppShell>
  )
}

// ---------------------------------------------------------------------------
// Exactly what will go
// ---------------------------------------------------------------------------

function Confirmation({
  impact,
  busy,
  onConfirm,
  onCancel,
}: {
  impact: DeletionImpact | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const classes = tone('block')
  const nothing = !impact || impact.invoices === 0

  return (
    <Panel>
      <PanelHeading>{CONFIRM_TITLE}</PanelHeading>
      {nothing ? (
        <EmptyState>{CONFIRM_NOTHING}</EmptyState>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <dl className="space-y-2">
            <Counted thing="invoice" total={impact.invoices} />
            <Counted thing="run" total={impact.runs} />
            <Counted thing="stageLog" total={impact.stageLogs} />
          </dl>

          {impact.orphaned.length > 0 ? (
            <div className={cn('rounded-lg border px-4 py-3', classes.panel)}>
              <p className={cn('text-sm font-medium', classes.text)}>{ORPHAN_WARNING_TITLE}</p>
              <p className={cn('mt-1 text-sm', classes.text)}>
                {orphanWarning(impact.orphaned.map((entry) => entry.invoiceNumber))}
              </p>
            </div>
          ) : null}

          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              {CANCEL_BUTTON}
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy} className="gap-2">
              {busy ? <Spinner /> : null}
              {busy ? CONFIRM_BUSY : CONFIRM_BUTTON}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  )
}

function Counted({ thing, total }: { thing: CountedThing; total: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-ink-soft">{thingWord(total, thing)}</dt>
      <dd className="text-sm font-medium text-ink tnum">{count(total)}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// What actually went
// ---------------------------------------------------------------------------

function Report({ report }: { report: DeletionReport }) {
  // Every type that went, each with its own count, so "deleted" is never a number
  // a reader has to interpret.
  const lines = [
    countedThing(report.invoices, 'invoice'),
    countedThing(report.runs, 'run'),
    countedThing(report.stageLogs, 'stageLog'),
    countedThing(report.extractions, 'reading'),
    countedThing(report.files, 'file'),
  ]

  return (
    <Panel className="px-5 py-4">
      <p className="text-sm font-medium text-ink">{DELETED_TITLE}</p>
      <p className="mt-1 text-sm text-muted">{listSentence(lines)}.</p>
      {report.detachedLinks > 0 ? (
        <p className="mt-1 text-sm text-muted">{detachedLine(report.detachedLinks)}</p>
      ) : null}
      {report.filesError ? (
        <p className={cn('mt-2 text-sm', tone('block').text)}>{filesFailed(report.filesError)}</p>
      ) : null}
    </Panel>
  )
}
