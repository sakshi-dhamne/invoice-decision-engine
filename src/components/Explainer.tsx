// The first-visit explainer.
//
// Someone may open this link with nobody beside them to say what it is. Four
// sentences, then two ways in. It appears once and stays dismissed, and the nav
// keeps a way back to it.

import { Link } from 'react-router-dom'
import { X } from 'lucide-react'

const STEPS = [
  { heading: 'An invoice arrives.', body: 'By email, or dropped in here.' },
  { heading: 'We read it.', body: 'A model transcribes what is printed, and nothing more.' },
  { heading: 'Rules decide.', body: 'Twenty-three checks run in order. The first one that matches sets the outcome.' },
  { heading: 'You see only what needs you.', body: 'Most invoices clear on their own.' },
]

export function Explainer({ onDismiss, onUpload }: { onDismiss: () => void; onUpload: () => void }) {
  return (
    <section
      aria-labelledby="explainer-heading"
      className="relative rounded-lg border border-line bg-surface px-6 py-6"
    >
      <h2 id="explainer-heading" className="sr-only">
        How Clearline works
      </h2>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss this explanation"
        className="absolute right-4 top-4 rounded-md p-1.5 text-faint transition-colors hover:text-ink"
      >
        <X className="size-4" />
      </button>

      <ol className="grid gap-6 pr-10 md:grid-cols-4">
        {STEPS.map((step) => (
          <li key={step.heading}>
            <h3 className="text-sm font-semibold text-ink">{step.heading}</h3>
            <p className="mt-1 text-sm text-muted">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex items-center gap-5 border-t border-line-soft pt-4">
        <button
          type="button"
          onClick={onUpload}
          className="text-sm font-medium text-ink underline underline-offset-4"
        >
          Upload an invoice
        </button>
        <Link to="/process" className="text-sm font-medium text-ink underline underline-offset-4">
          See the rules
        </Link>
      </div>
    </section>
  )
}
