// How an invoice gets from an inbox to a decision.
//
// Somebody may open this having been handed a link and no explanation. The seven
// stages, the one thing worth understanding about how they are arranged, and what
// each of the four outcomes means.

import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { PageBody, Panel, PanelHeading, VerdictChip } from '@/components/Primitives.tsx'
import { tone } from '@/components/tone.ts'
import { cn } from '@/lib/utils'
import { PIPELINE_STAGES } from '@/lib/pipeline.ts'
import { stageLabel, VERDICT_EXPLANATION, verdictTone } from '@/lib/reasonCopy.ts'
import type { Verdict } from '@/lib/database.types.ts'

const WHAT_EACH_STAGE_DOES: Readonly<Record<string, string>> = {
  ingest: 'We take the document in and fingerprint it, so a second copy is recognised without reading it again.',
  extract: 'A model transcribes what is printed on the page. It copies figures out; it does not work any out.',
  resolve_vendor: 'We match the printed company name against the approved vendor list.',
  match_po: 'We find the purchase order the invoice is billing against.',
  validate: 'Twenty-three checks run over the figures, the vendor and the order.',
  decide: 'The checks are read in a fixed order. The first one that objects sets the outcome.',
  explain: 'The settled outcome is written up in a sentence or two.',
}

const OUTCOMES: Verdict[] = ['AUTO_APPROVE', 'REVIEW', 'HOLD', 'BLOCK']

export default function Process() {
  return (
    <AppShell>
      <PageBody>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-ink">Process</h1>
            <p className="mt-1 max-w-[72ch] text-sm text-muted">
              What happens to an invoice between arriving and being paid, and what each outcome means.
            </p>
          </div>

          {/* The principle. It is the thing worth reading on this page. */}
          <Panel className="px-6 py-5">
            <p className="prose-serif max-w-[68ch] text-[17px] text-ink-soft">
              A model reads the document. Code decides what happens to it. The model transcribes what is printed and
              nothing more, and no answer it gives can change an outcome: every verdict comes from the checks on the
              Controls page, in the order shown there.
            </p>
          </Panel>

          <Panel>
            <PanelHeading right={<span className="text-xs text-muted tnum">{PIPELINE_STAGES.length} stages</span>}>
              The seven stages, in order
            </PanelHeading>

            <ol className="divide-y divide-line-soft">
              {PIPELINE_STAGES.map((stage, index) => (
                <li key={stage} className="flex items-start gap-4 px-5 py-3.5">
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-xs text-muted tnum">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-ink">{stageLabel(stage)}</h3>
                    <p className="mt-0.5 text-sm text-muted">{WHAT_EACH_STAGE_DOES[stage]}</p>
                  </div>
                  {index < PIPELINE_STAGES.length - 1 ? (
                    <ArrowRight className="mt-1 size-4 shrink-0 text-line" aria-hidden="true" />
                  ) : null}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel>
            <PanelHeading>What each outcome means</PanelHeading>
            <ul className="divide-y divide-line-soft">
              {OUTCOMES.map((verdict) => (
                <li key={verdict} className="flex items-start gap-4 px-5 py-3.5">
                  <span className="w-24 shrink-0">
                    <VerdictChip verdict={verdict} size="sm" />
                  </span>
                  <p className={cn('text-sm', tone(verdictTone(verdict)).text)}>{VERDICT_EXPLANATION[verdict]}</p>
                </li>
              ))}
            </ul>
            <p className="border-t border-line-soft px-5 py-3 text-sm text-muted">
              A credit note is recorded rather than paid, which is the fifth thing that can happen to a document and
              not an exception.
            </p>
          </Panel>

          <p className="text-sm text-muted">
            The thresholds these checks measure against, and the order they run in, are on the{' '}
            <Link to="/controls" className="text-ink underline underline-offset-4">
              Controls
            </Link>{' '}
            page.
          </p>
        </div>
      </PageBody>
    </AppShell>
  )
}
