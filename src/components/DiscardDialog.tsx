// Filing a duplicate away.
//
// The rules blocked it and that stays on the record. This says a person has seen
// it and dealt with it, which is what takes it off the list. The name is required
// for the same reason it is required on an override: an action nobody will own is
// an action nobody took.

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

export function DiscardDialog({
  open,
  onOpenChange,
  duplicateOf,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  duplicateOf: string | null
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
      setError(caught instanceof Error ? caught.message : 'This could not be saved. Try again in a moment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Discard duplicate</DialogTitle>
            <DialogDescription>
              {duplicateOf
                ? `This takes the copy off the list. ${duplicateOf} stays exactly as it is, and the record keeps your name against the copy.`
                : 'This takes the copy off the list. The invoice it repeats stays exactly as it is, and the record keeps your name against the copy.'}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <label htmlFor="discarder" className="block text-xs text-muted">
              Who is discarding this (required)
            </label>
            <input
              id="discarder"
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
              Discard and record my name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
