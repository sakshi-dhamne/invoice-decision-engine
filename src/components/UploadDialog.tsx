// Putting a document in.
//
// This has to work on an invoice the system has never seen: not a fixture, not a
// known vendor, not necessarily an order it can find. Whatever the rules then make
// of it is the right answer, including holding it as a company we do not know.

import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { fileSize } from '@/lib/format.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { rejectUpload, uploadInvoicePdf } from '@/lib/uploads.ts'
import { ErrorNote, Spinner } from './Primitives.tsx'

type Phase = 'idle' | 'saving' | 'starting'

export function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const busy = phase !== 'idle'

  const choose = useCallback((candidate: File | undefined) => {
    if (!candidate) return
    const rejection = rejectUpload(candidate)
    if (rejection) {
      setFile(null)
      setProblem(rejection.reason)
      return
    }
    setProblem(null)
    setFile(candidate)
  }, [])

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (busy) return
    const dropped = event.dataTransfer.files
    if (dropped.length > 1) {
      setProblem('Drop one invoice at a time, so each gets its own decision.')
      return
    }
    choose(dropped[0])
  }

  const reset = () => {
    setFile(null)
    setProblem(null)
    setPhase('idle')
    setDragging(false)
  }

  const send = async () => {
    if (!file) return
    setProblem(null)
    setPhase('saving')

    try {
      const { invoice } = await uploadInvoicePdf(file)
      setPhase('starting')

      // The run is started here and the person is sent to watch it. The promise
      // outlives this dialog on purpose: navigating within the app does not stop
      // it, and the live view follows the same run through Realtime.
      void runInvoice(invoice.id, {
        onRunCreated: (run) => {
          reset()
          onOpenChange(false)
          navigate(`/runs/${run.id}`)
        },
      }).catch(() => {
        // The run marks itself failed in the database, and the live view reports
        // it from there. Nothing more to do from the dialog, which has closed.
      })
    } catch (error) {
      setPhase('idle')
      setProblem(error instanceof Error ? error.message : 'The file could not be saved. Try again in a moment.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload an invoice</DialogTitle>
          <DialogDescription>
            One PDF at a time. We read it, check it against the orders and the vendor list, and show you the decision as
            it happens.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(event) => {
            event.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragging ? 'border-ink-soft bg-line-soft' : 'border-line',
          )}
        >
          {file ? (
            <div className="flex items-center justify-center gap-3">
              <FileText className="size-5 text-muted" aria-hidden="true" />
              <div className="text-left">
                <p className="text-sm font-medium text-ink">{file.name}</p>
                <p className="text-xs text-muted tnum">{fileSize(file.size)}</p>
              </div>
            </div>
          ) : (
            <>
              <Upload className="mx-auto size-6 text-faint" aria-hidden="true" />
              <p className="mt-3 text-sm text-ink-soft">Drop a PDF here</p>
              <p className="mt-1 text-xs text-muted">or choose one from your computer</p>
            </>
          )}

          <div className="mt-4">
            <label
              htmlFor="invoice-file"
              className={cn(
                'inline-flex cursor-pointer items-center rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink',
                busy && 'pointer-events-none opacity-50',
              )}
            >
              {file ? 'Choose a different file' : 'Choose a file'}
            </label>
            <input
              ref={inputRef}
              id="invoice-file"
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                choose(event.target.files?.[0])
                // Let the same file be picked again after a rejection.
                event.target.value = ''
              }}
            />
          </div>
        </div>

        {problem ? <ErrorNote title="That file cannot be used">{problem}</ErrorNote> : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={send} disabled={!file || busy} className="gap-2">
            {busy ? <Spinner className="border-t-primary-foreground" /> : null}
            {phase === 'saving' ? 'Saving the file' : phase === 'starting' ? 'Starting the checks' : 'Upload and check'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
