// One bar, segmented by verdict at true scale, with a count under it.
//
// True scale is the point: a reviewer should see at a glance that the red sliver
// really is a sliver. Segments are not given a minimum width, because widening a
// small one would misstate the thing the bar exists to show.

import { VERDICT_LABEL, VERDICT_TONE } from '@/lib/reasonCopy.ts'
import { count } from '@/lib/format.ts'
import type { Verdict } from '@/lib/database.types.ts'
import { tone } from './tone.ts'

const ORDER: Verdict[] = ['AUTO_APPROVE', 'REVIEW', 'HOLD', 'BLOCK', 'ROUTED_NOT_PAID']

export function ProportionBar({ counts }: { counts: Partial<Record<Verdict, number>> }) {
  const present = ORDER.filter((verdict) => (counts[verdict] ?? 0) > 0)
  const total = present.reduce((sum, verdict) => sum + (counts[verdict] ?? 0), 0)

  if (total === 0) {
    return (
      <div>
        <div className="h-3 w-full rounded-full bg-line-soft" />
        <p className="mt-3 text-sm text-muted">No invoices have been decided yet.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-line-soft" role="img" aria-label={
        present.map((verdict) => `${VERDICT_LABEL[verdict]}, ${counts[verdict] ?? 0}`).join('. ')
      }>
        {present.map((verdict) => (
          <div
            key={verdict}
            className={tone(VERDICT_TONE[verdict]).fill}
            style={{ width: `${((counts[verdict] ?? 0) / total) * 100}%` }}
          />
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        {present.map((verdict) => (
          <li key={verdict} className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${tone(VERDICT_TONE[verdict]).fill}`} aria-hidden="true" />
            <span className="text-sm text-ink-soft">{VERDICT_LABEL[verdict]}</span>
            <span className="text-sm font-medium text-ink tnum">{count(counts[verdict] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
