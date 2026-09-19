// The upload dialog lives in the shell, but the landing page and its explainer
// also offer a way in. This is how they reach it without each owning a copy.

import { createContext, useContext } from 'react'

export interface UploadControls {
  openUpload: () => void
}

export const UploadContext = createContext<UploadControls>({ openUpload: () => undefined })

export function useUpload(): UploadControls {
  return useContext(UploadContext)
}
