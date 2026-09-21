// Drafting the question to put to the vendor.
//
// Nothing is sent. This writes the message from what the checks actually found,
// so the person copying it does not have to translate a reason code into a
// sentence themselves. The reasons come from reasonCopy.ts like everywhere else.

import { useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { money } from '@/lib/format.ts'
import { reasonSentence } from '@/lib/reasonCopy.ts'
import type { DecisionData } from '@/lib/decisionData.ts'

// Codes that describe the state of our own records rather than anything the vendor
// could answer. Asking a supplier about our approval limit would be strange.
const NOT_THE_VENDORS_TO_ANSWER = new Set([
  'CLEAN_MATCH',
  'ABOVE_AUTO_APPROVE_LIMIT',
  'RESUBMISSION',
  'LOW_CONFIDENCE_VENDOR_MATCH',
  'THRESHOLD_SPLIT_SUSPECTED',
])

function draft(data: DecisionData): string {
  const vendor = data.vendor?.legal_name ?? data.invoice?.vendor_name_as_printed ?? 'there'
  const number = data.invoice?.invoice_number ?? 'the invoice you sent'
  const amount = data.invoice?.total != null ? ` for ${money(data.invoice.total, data.invoice.currency ?? 'INR')}` : ''

  const problems = data.codes
    .filter((code) => !NOT_THE_VENDORS_TO_ANSWER.has(code))
    .map((code) => `- ${reasonSentence(code)}`)

  const body =
    problems.length > 0
      ? ['We cannot pay it yet for this reason:', '', ...problems].join('\n')
      : 'We have a question about it before we can pay it.'

  return [
    `Hello ${vendor},`,
    '',
    `We have received invoice ${number}${amount}.`,
    '',
    body,
    '',
    'Could you confirm the details above, or send a corrected invoice?',
    '',
    'Thank you.',
  ].join('\n')
}

export function AskVendorDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: DecisionData
}) {
  const initial = useMemo(() => draft(data), [data])
  const [message, setMessage] = useState(initial)
  const [copied, setCopied] = useState(false)

  // A fresh draft each time the dialog opens, so edits to one invoice's message do
  // not follow the reader to the next.
  useEffect(() => {
    if (open) {
      setMessage(initial)
      setCopied(false)
    }
  }, [open, initial])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ask the vendor</DialogTitle>
          <DialogDescription>
            A draft written from what the checks found. Edit it, copy it, and send it however you normally would.
            Nothing is sent from here.
          </DialogDescription>
        </DialogHeader>

        <label htmlFor="vendor-message" className="sr-only">
          The message to send
        </label>
        <textarea
          id="vendor-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={14}
          className="w-full rounded-md border border-line bg-surface p-3 text-sm text-ink"
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={copy} className="gap-2">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? 'Copied' : 'Copy the message'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
