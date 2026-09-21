// How anything in the app reaches the upload dialog, and sees how a batch that is
// already running is getting on.

import { createContext, useContext } from 'react'

import type { UploadProgress } from './UploadDialog.tsx'

export interface UploadControls {
  openUpload: () => void
  progress: UploadProgress | null
  // Changes each time a batch finishes, so a screen can reload on it.
  finishedAt: number
}

export const UploadContext = createContext<UploadControls>({
  openUpload: () => undefined,
  progress: null,
  finishedAt: 0,
})

export function useUpload(): UploadControls {
  return useContext(UploadContext)
}
