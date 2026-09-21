// Approving something the checks stopped.
//
// The rules stopped this invoice for a reason, and someone is now overruling them.
// That is a legitimate thing to do and a thing the record has to carry a name for,
// so the name is required rather than filled in with a placeholder.

import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorNote, Spinner } from './Primitives.tsx'

export function OverrideDialog({
  open,
  onOpenChange,
  invoiceNumber,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceNumber: string | null
  onConfirm: (who: string) => Promise<void>
}) {
  const [who, setWho] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setWho('')
      setError(null)
    }
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (who.trim().length === 0) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(who.trim())
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The approval could not be saved. Try again in a moment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Approve this anyway</DialogTitle>
            <DialogDescription>
              {invoiceNumber
                ? `The checks stopped ${invoiceNumber}. Approving it here overrules them, and the record keeps your name against that.`
                : 'The checks stopped this invoice. Approving it here overrules them, and the record keeps your name against that.'}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <label htmlFor="approver" className="block text-xs text-muted">
              Who is approving this (required)
            </label>
            <input
              id="approver"
              value={who}
              onChange={(event) => setWho(event.target.value)}
              placeholder="Your name"
              autoComplete="name"
              required
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
            />
          </div>

          {error ? <ErrorNote title="This could not be saved">{error}</ErrorNote> : null}

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={who.trim().length === 0 || saving} className="gap-2">
              {saving ? <Spinner className="border-t-primary-foreground" /> : null}
              Approve and record my name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
