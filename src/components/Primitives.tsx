// The small pieces every screen shares: verdict chips, reason codes, label/value
// grids, empty states, loading and error states.
//
// None of these hold a sentence of their own about a verdict or a reason code.
// They take what reasonCopy.ts says and lay it out.

import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { UserCheck } from 'lucide-react'

import { cn } from '@/lib/utils'
import { evidenceValue, humanKey, isInternalKey } from '@/lib/format.ts'
import { approvedByPerson } from '@/lib/feed.ts'
import {
  APPROVED_BY_PERSON_LABEL,
  FAILED_RUN_LABEL,
  reasonSentence,
  VERDICT_LABEL,
  verdictLabel,
  verdictTone,
} from '@/lib/reasonCopy.ts'
import type { RunRow, Verdict } from '@/lib/database.types.ts'
import { tone } from './tone.ts'

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export function VerdictChip({
  verdict,
  size = 'md',
  className,
}: {
  verdict: Verdict | null | undefined
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const classes = tone(verdictTone(verdict))
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full font-medium',
        size === 'sm' && 'px-1.5 py-0 text-xs',
        size === 'md' && 'px-2.5 py-1 text-sm',
        size === 'lg' && 'px-3.5 py-1.5 text-base',
        classes.chip,
        className,
      )}
    >
      {verdictLabel(verdict)}
    </span>
  )
}

/**
 * The chip for a run, rather than for a verdict.
 *
 * A run that failed never reached a verdict, so `verdictLabel` had nothing to
 * render and fell back to "Not decided", which tells a person nothing. A failure
 * is its own outcome and reads as one.
 */
export function OutcomeChip({
  run,
  size = 'md',
  className,
}: {
  run: Pick<RunRow, 'status' | 'verdict' | 'touched_by_human' | 'touched_by'>
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  // An invoice a person approved reads as approved, in the approval colour, but
  // says who cleared it. Showing the rules' verdict here instead was the override
  // doing nothing: the invoice went on reading Held after it had been approved.
  if (approvedByPerson(run)) {
    return (
      <span
        title={APPROVED_BY_PERSON_LABEL}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full font-medium',
          size === 'sm' && 'px-1.5 py-0 text-xs',
          size === 'md' && 'px-2.5 py-1 text-sm',
          size === 'lg' && 'px-3.5 py-1.5 text-base',
          tone('approve').chip,
          className,
        )}
      >
        <UserCheck className={cn(size === 'sm' ? 'size-3' : 'size-3.5')} aria-hidden="true" />
        {VERDICT_LABEL.AUTO_APPROVE}
      </span>
    )
  }

  if (run.status === 'failed') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full font-medium',
          size === 'sm' && 'px-1.5 py-0 text-xs',
          size === 'md' && 'px-2.5 py-1 text-sm',
          size === 'lg' && 'px-3.5 py-1.5 text-base',
          tone('block').chip,
          className,
        )}
      >
        {FAILED_RUN_LABEL}
      </span>
    )
  }
  return <VerdictChip verdict={run.verdict} size={size} className={className} />
}

// ---------------------------------------------------------------------------
// A field the browser must not fill in
// ---------------------------------------------------------------------------

/**
 * A controlled text input that stays empty until a person types in it.
 *
 * Two fields in this product are deliberately blank and are the whole reason a
 * control works: the bank details on the vendor form, and the value on a purchase
 * order. Both are compared against what an invoice claims, so a value copied from
 * the invoice makes the comparison compare the document with itself.
 *
 * Both were reported as arriving pre-populated anyway, with the exact figure off
 * the invoice, and neither has any code path that sets them. What does set them is
 * the browser. Autofill and session restore write straight into the DOM node, and
 * a controlled React input does not notice: React writes `value` on render, the
 * browser overwrites it afterwards, and React has no reason to render again
 * because its own state has not changed. The field then shows a number the
 * component does not know about, and the person reading the panel above it is told
 * the figure was not taken from the invoice while looking at the figure from the
 * invoice.
 *
 * So this asks the browser not to (which it may ignore) and then checks, after
 * paint, that the DOM agrees with the state (which it cannot ignore).
 */
export function UnfilledInput({
  value,
  onValueChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const field = ref.current
    if (field && field.value !== value) field.value = value
  })

  return (
    <input
      {...rest}
      ref={ref}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      autoComplete="off"
      // The attributes the common password managers read. None of them is load
      // bearing on its own; the effect above is what actually holds.
      data-lpignore="true"
      data-1p-ignore="true"
      data-form-type="other"
    />
  )
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/** The audit-trail identifier. Always accompanied by its sentence, never alone. */
export function ReasonCodeChip({ code }: { code: string }) {
  return (
    <span className="identifier inline-flex items-center rounded border border-line bg-line-soft px-1.5 py-0.5 text-xs text-ink-soft">
      {code}
    </span>
  )
}

/** Every code's sentence, then the codes themselves underneath. */
export function ReasonCodes({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {codes.map((code) => (
          <li key={code} className="text-sm text-ink-soft">
            {reasonSentence(code)}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        {codes.map((code) => (
          <ReasonCodeChip key={code} code={code} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A scrolling, padded page body. The shell gives its children the whole area and
 *  lets each one decide how to fill it; this is the ordinary answer. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-auto p-6', className)}>{children}</div>
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('rounded-lg border border-line bg-surface', className)}>{children}</section>
}

export function PanelHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft px-5 py-3.5">
      <h2 className="text-sm font-semibold text-ink">{children}</h2>
      {right}
    </div>
  )
}

export interface Field {
  label: string
  value: ReactNode
  /** Renders the value in the verdict colour, for a field a check objected to. */
  flagged?: boolean
  mono?: boolean
}

export function LabelValueGrid({
  fields,
  columns = 2,
  flagTone = 'block',
}: {
  fields: Field[]
  columns?: 1 | 2
  flagTone?: 'approve' | 'review' | 'hold' | 'block'
}) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3.5', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
      {fields.map((field) => (
        <div key={field.label} className="min-w-0">
          <dt className="text-xs text-muted">{field.label}</dt>
          <dd
            className={cn(
              'mt-0.5 truncate text-sm text-ink tnum',
              field.mono && 'identifier',
              field.flagged && cn('font-medium', tone(flagTone).text),
            )}
            title={typeof field.value === 'string' ? field.value : undefined}
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Rules-engine evidence, laid out rather than dumped as JSON.
 *
 * Internal references are dropped here rather than at each call site, so a new
 * screen cannot leak a hash onto the page by forgetting to.
 */
export function EvidenceGrid({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(
    ([key, value]) => value !== undefined && !isInternalKey(key),
  )
  if (entries.length === 0) return null
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs text-muted">{humanKey(key)}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink-soft tnum">{evidenceValue(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** Empty states read as an instruction, not an apology. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm text-muted">{children}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink-soft',
        className,
      )}
      role={label ? 'status' : undefined}
      aria-label={label}
    />
  )
}

/**
 * A placeholder the shape of the thing that is coming.
 *
 * Used where a pane already has a header and a layout, and only the contents are
 * still being fetched. Showing the outgoing invoice's decision under the incoming
 * invoice's name, which is what reusing the pane did, is worse than showing
 * nothing: the reader has no way to tell that the figures belong to something else.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded bg-line-soft', className)} />
}

/** The decision pane's contents, while the decision is being fetched. */
export function DecisionSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading the decision">
      <Panel className="border-l-4 border-line px-5 py-4">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-2 h-4 w-3/5" />
        <div className="mt-4 flex gap-1.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-20" />
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeading>Why this outcome</PanelHeading>
          <div className="space-y-2 px-5 py-4">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-8/12" />
          </div>
        </Panel>
        <Panel>
          <PanelHeading>The order</PanelHeading>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-5 py-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </Panel>
      </div>
    </div>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2.5 px-5 py-14 text-sm text-muted">
      <Spinner />
      <span>{children}</span>
    </div>
  )
}

/** Errors say what happened and what to do about it. */
export function ErrorNote({ title, children }: { title: string; children?: ReactNode }) {
  const classes = tone('block')
  return (
    <div className={cn('rounded-lg border px-4 py-3', classes.panel)}>
      <p className={cn('text-sm font-medium', classes.text)}>{title}</p>
      {children ? <p className={cn('mt-1 text-sm', classes.text)}>{children}</p> : null}
    </div>
  )
}

/** A figure with its caption, used across the landing page and the dashboard. */
export function Statistic({
  label,
  value,
  note,
  className,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink tnum">{value}</p>
      {note ? <p className="mt-0.5 text-xs text-muted">{note}</p> : null}
    </div>
  )
}
