// One decision, on its own page.
//
// The queue is where this is normally read, in the pane beside the list. This
// route exists so a decision can be linked to, and shows the identical thing.

import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '@/components/AppShell.tsx'
import { DecisionDetail } from '@/components/DecisionDetail.tsx'

export default function Decision() {
  const { id = '' } = useParams()

  return (
    <AppShell>
      <div className="shrink-0 border-b border-line bg-surface px-6 py-2.5">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to the queue
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <DecisionDetail runId={id} />
      </div>
    </AppShell>
  )
}
