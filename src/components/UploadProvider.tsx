// The upload dialog, owned above the routes.
//
// It lives here rather than inside the shell because things outside the shell's
// own markup ask to open it: the explainer's link, the command palette, an empty
// queue. A provider rendered by the shell cannot be read by the page that renders
// the shell, which is how the explainer's button came to do nothing.

import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { UploadContext } from './uploadContext.ts'
import { UploadDialog, type UploadProgress } from './UploadDialog.tsx'

export function UploadProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  // Bumped whenever a batch finishes, so any screen watching it can reload.
  const [finishedAt, setFinishedAt] = useState(0)

  const openUpload = useCallback(() => setOpen(true), [])

  const value = useMemo(
    () => ({ openUpload, progress, finishedAt }),
    [openUpload, progress, finishedAt],
  )

  return (
    <UploadContext.Provider value={value}>
      {children}
      <UploadDialog
        open={open}
        onOpenChange={setOpen}
        onProgress={setProgress}
        onFinished={() => setFinishedAt(Date.now())}
      />
    </UploadContext.Provider>
  )
}
