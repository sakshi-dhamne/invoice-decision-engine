// The document itself.
//
// An invoice tool where you cannot see the invoice is a database viewer. This
// renders the page beside what was read off it, so a person can check one against
// the other with their own eyes.
//
// Three ways it can go, in order of preference: pdf.js draws the pages onto a
// canvas; failing that an <iframe> hands the file to the browser's own viewer; and
// an image is simply an image. There is no fourth outcome where the pane is blank.

import { useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Spinner } from './Primitives.tsx'

type Mode = 'loading' | 'canvas' | 'frame' | 'image'

// pdf.js ships its worker as a separate module. Vite needs the URL at build time,
// and the import is deferred so a page that never opens the document tab does not
// pay for the library.
async function loadPdfJs() {
  const [pdfjs, workerUrl] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url').then((module) => module.default),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  return pdfjs
}

export function DocumentViewer({
  url,
  isImage,
  className,
}: {
  url: string | null
  isImage: boolean
  className?: string
}) {
  const [mode, setMode] = useState<Mode>('loading')
  const [pageCount, setPageCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  // Guards against a slow render finishing after the viewer has moved to another
  // document and painting the wrong pages into the pane.
  const renderToken = useRef(0)

  const render = useCallback(async () => {
    if (!url) return
    const token = ++renderToken.current

    if (isImage) {
      setMode('image')
      return
    }

    setMode('loading')

    try {
      const pdfjs = await loadPdfJs()
      const document = await pdfjs.getDocument({ url }).promise
      if (token !== renderToken.current) return

      const container = containerRef.current
      if (!container) return
      container.replaceChildren()

      // Rendered at twice the layout width so the page is sharp on a retina
      // screen, then scaled down in CSS.
      const targetWidth = Math.max(320, container.clientWidth - 24)

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber)
        if (token !== renderToken.current) return

        const unscaled = page.getViewport({ scale: 1 })
        const scale = (targetWidth / unscaled.width) * (window.devicePixelRatio || 1)
        const viewport = page.getViewport({ scale })

        const canvas = window.document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
        canvas.style.display = 'block'
        canvas.className = 'rounded border border-line bg-surface'
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `Page ${pageNumber} of the invoice`)

        const context = canvas.getContext('2d')
        if (!context) continue

        const wrapper = window.document.createElement('div')
        wrapper.className = 'mb-3'
        wrapper.appendChild(canvas)
        container.appendChild(wrapper)

        await page.render({ canvasContext: context, viewport }).promise
        if (token !== renderToken.current) return
      }

      setPageCount(document.numPages)
      setMode('canvas')
    } catch {
      // Whatever went wrong, the browser may still be able to display the file.
      if (token === renderToken.current) setMode('frame')
    }
  }, [url, isImage])

  useEffect(() => {
    void render()
  }, [render])

  if (!url) {
    return (
      <div className={cn('flex items-center justify-center rounded-lg border border-line bg-ground p-8', className)}>
        <p className="text-sm text-muted">This invoice has no file attached to look at.</p>
      </div>
    )
  }

  return (
    <div className={cn('relative overflow-auto rounded-lg border border-line bg-ground p-3', className)}>
      {mode === 'loading' ? (
        <div className="flex h-full min-h-40 items-center justify-center gap-2.5 text-sm text-muted">
          <Spinner />
          <span>Opening the document</span>
        </div>
      ) : null}

      {/* pdf.js paints into this. It stays laid out while loading so its width can
          be measured, and is taken out only when another mode has the pane. */}
      <div ref={containerRef} className={mode === 'frame' || mode === 'image' ? 'hidden' : 'block'} />

      {mode === 'image' ? (
        <img src={url} alt="The invoice as it was submitted" className="w-full rounded border border-line bg-surface" />
      ) : null}

      {mode === 'frame' ? (
        <div className="flex h-full min-h-[32rem] flex-col gap-2">
          <p className="text-xs text-muted">
            This document is shown by the browser rather than drawn in the page.
          </p>
          <iframe src={url} title="The invoice as it was submitted" className="h-full w-full flex-1 rounded border border-line bg-surface" />
        </div>
      ) : null}

      {mode === 'canvas' && pageCount > 1 ? (
        <p className="pt-1 text-center text-xs text-muted tnum">{pageCount} pages</p>
      ) : null}
    </div>
  )
}
