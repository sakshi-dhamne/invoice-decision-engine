// Putting documents in.
//
// Several at a time, PDFs or photographs, and each one checked as soon as it has
// been read. Processing is sequential on purpose: the extraction is rate limited,
// and a burst of parallel calls would fail slower than a queue succeeds.
//
// Closing the dialog does not stop the queue. The work carries on and the rail
// reports where it has got to, because a person should not have to watch a
// progress bar to keep their own upload alive.

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, FileText, Upload, X } from 'lucide-react'

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
import { count, fileSize } from '@/lib/format.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { rejectUpload, uploadInvoiceDocument, UPLOAD_ACCEPT } from '@/lib/uploads.ts'
import { ErrorNote, Spinner } from './Primitives.tsx'
import { tone } from './tone.ts'

export interface UploadProgress {
  done: number
  total: number
  failed: number
}

type ItemState = 'waiting' | 'rejected' | 'saving' | 'reading' | 'decided' | 'failed'

interface QueuedFile {
  id: string
  file: File
  state: ItemState
  // The sentence shown beside the file, when there is one to show.
  note: string | null
  runId: string | null
}

const STATE_LABEL: Record<ItemState, string> = {
  waiting: 'Waiting',
  rejected: 'Cannot be read',
  saving: 'Saving',
  reading: 'Reading',
  decided: 'Decided',
  failed: 'Failed',
}

export function UploadDialog({
  open,
  onOpenChange,
  onProgress,
  onFinished,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProgress?: (progress: UploadProgress | null) => void
  onFinished?: () => void
}) {
  const [items, setItems] = useState<QueuedFile[]>([])
  const [running, setRunning] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const navigate = useNavigate()
  // The queue keeps going after the dialog closes, so the loop reads from a ref
  // rather than from state that may no longer be mounted.
  const cancelled = useRef(false)

  const add = useCallback((files: FileList | File[]) => {
    const incoming = [...files]
    if (incoming.length === 0) return
    setProblem(null)
    setItems((current) => [
      ...current,
      ...incoming.map((file, index): QueuedFile => {
        const rejection = rejectUpload(file)
        return {
          id: `${Date.now()}-${index}-${file.name}`,
          file,
          state: rejection ? 'rejected' : 'waiting',
          note: rejection?.reason ?? null,
          runId: null,
        }
      }),
    ])
  }, [])

  const patch = (id: string, change: Partial<QueuedFile>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (running) return
    add(event.dataTransfer.files)
  }

  const start = async () => {
    const queued = items.filter((item) => item.state === 'waiting')
    if (queued.length === 0) return

    cancelled.current = false
    setRunning(true)
    setProblem(null)

    let done = 0
    let failed = 0
    const total = queued.length
    onProgress?.({ done, total, failed })

    for (const item of queued) {
      if (cancelled.current) break

      try {
        patch(item.id, { state: 'saving', note: null })
        const { invoice } = await uploadInvoiceDocument(item.file)

        patch(item.id, { state: 'reading' })
        let runId: string | null = null
        await runInvoice(invoice.id, {
          onRunCreated: (run) => {
            runId = run.id
            patch(item.id, { runId: run.id })
          },
        })
        patch(item.id, { state: 'decided', runId })
      } catch (caught) {
        failed++
        patch(item.id, {
          state: 'failed',
          note: caught instanceof Error ? caught.message : 'This one could not be read.',
        })
      }

      done++
      onProgress?.({ done, total, failed })
    }

    setRunning(false)
    onFinished?.()

    // Leave the rail's summary up long enough to be read, then clear it.
    window.setTimeout(() => onProgress?.(null), 6000)
  }

  useEffect(() => {
    return () => {
      cancelled.current = true
    }
  }, [])

  const reset = () => {
    if (running) return
    setItems([])
    setProblem(null)
    setDragging(false)
  }

  const waiting = items.filter((item) => item.state === 'waiting').length
  const decided = items.filter((item) => item.state === 'decided').length
  // A file that failed on the way through is not waiting to be read and is not a
  // file we refused: it is one that could not be read. Counting it as ready is how
  // the footer came to say "1 ready, 0 cannot be read" beside a visible error.
  const unreadable = items.filter((item) => item.state === 'rejected' || item.state === 'failed').length
  const inFlight = items.filter((item) => item.state === 'saving' || item.state === 'reading').length
  const blockClasses = tone('block')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload invoices</DialogTitle>
          <DialogDescription>
            PDFs or photographs of the page. Add as many as you like. We read them one after another and check each
            one as it arrives.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(event) => {
            event.preventDefault()
            if (!running) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
            dragging ? 'border-ink-soft bg-line-soft' : 'border-line',
          )}
        >
          <Upload className="mx-auto size-6 text-faint" aria-hidden="true" />
          <p className="mt-3 text-sm text-ink-soft">Drop files here</p>
          <p className="mt-1 text-xs text-muted">A PDF, or a photo taken on a phone</p>

          <div className="mt-4">
            <label
              htmlFor="invoice-files"
              className={cn(
                'inline-flex cursor-pointer items-center rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink',
                running && 'pointer-events-none opacity-50',
              )}
            >
              Choose files
            </label>
            <input
              id="invoice-files"
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="sr-only"
              disabled={running}
              onChange={(event) => {
                if (event.target.files) add(event.target.files)
                event.target.value = ''
              }}
            />
          </div>
        </div>

        {items.length > 0 ? (
          <ul className="max-h-64 divide-y divide-line-soft overflow-auto rounded-md border border-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                {item.state === 'decided' ? (
                  <Check className="size-4 shrink-0 text-approve" aria-hidden="true" />
                ) : item.state === 'failed' || item.state === 'rejected' ? (
                  <AlertTriangle className={cn('size-4 shrink-0', blockClasses.text)} aria-hidden="true" />
                ) : item.state === 'saving' || item.state === 'reading' ? (
                  <Spinner className="shrink-0" />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{item.file.name}</p>
                  <p
                    className={cn(
                      'truncate text-xs',
                      item.state === 'failed' || item.state === 'rejected' ? blockClasses.text : 'text-muted',
                    )}
                  >
                    {item.note ?? `${STATE_LABEL[item.state]}, ${fileSize(item.file.size)}`}
                  </p>
                </div>

                {item.state === 'decided' && item.runId ? (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false)
                      navigate(`/decisions/${item.runId}`)
                    }}
                    className="shrink-0 text-xs text-ink underline underline-offset-4"
                  >
                    See it
                  </button>
                ) : null}

                {!running && item.state !== 'decided' ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.file.name} from the list`}
                    onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
                    className="shrink-0 rounded p-1 text-muted transition-colors hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {problem ? <ErrorNote title="These files could not be sent">{problem}</ErrorNote> : null}

        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted tnum">
            {running
              ? `${count(decided)} read, ${count(inFlight)} in progress, ${count(waiting)} waiting`
              : items.length > 0
                ? [
                    waiting > 0 ? `${count(waiting)} ready` : null,
                    decided > 0 ? `${count(decided)} read` : null,
                    unreadable > 0 ? `${count(unreadable)} could not be read` : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(', ')
                : ''}
          </p>
          <span className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {running ? 'Close and keep going' : 'Close'}
            </Button>
            <Button type="button" onClick={start} disabled={waiting === 0 || running} className="gap-2">
              {running ? <Spinner className="border-t-primary-foreground" /> : null}
              {running ? 'Reading' : `Upload and check ${count(waiting)}`}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
