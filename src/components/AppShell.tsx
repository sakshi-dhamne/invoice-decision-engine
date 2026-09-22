// The frame every product screen sits in.
//
// A fixed rail on the left, and everything else given to the work. No centred
// column and no maximum width: on a wide screen the queue should be using the
// screen, not floating in the middle of it.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Building2, GitBranch, LayoutList, Moon, ScrollText, Sliders, Sun, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { count } from '@/lib/format.ts'
import { applyTheme, readTheme, storeTheme, type Theme } from '@/lib/localSettings.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { useUpload } from './uploadContext.ts'
import { Spinner } from './Primitives.tsx'

const NAV = [
  { to: '/', label: 'Exceptions', icon: LayoutList },
  { to: '/invoices', label: 'Invoices', icon: ScrollText },
  { to: '/vendors', label: 'Vendors', icon: Building2 },
  { to: '/controls', label: 'Controls', icon: Sliders },
  { to: '/process', label: 'Process', icon: GitBranch },
]

export function AppShell({
  children,
  openExceptions,
}: {
  children: ReactNode
  // Shown as a badge beside Exceptions when the page that knows the count says so.
  openExceptions?: number
}) {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { openUpload, progress } = useUpload()
  const location = useLocation()

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark'
      storeTheme(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-ground">
        <nav
          aria-label="Main"
          className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface"
        >
          <Link to="/" className="block px-5 py-5 text-lg font-bold tracking-tight text-ink">
            Clearline
          </Link>

          <ul className="flex-1 space-y-0.5 px-2.5">
            {NAV.map((item) => {
              const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
              const Icon = item.icon
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                      active ? 'bg-line-soft font-medium text-ink' : 'text-muted hover:text-ink',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{item.label}</span>
                    {item.to === '/' && openExceptions != null && openExceptions > 0 ? (
                      <span className="rounded-full bg-line-soft px-1.5 py-0.5 text-xs text-ink-soft tnum">
                        {count(openExceptions)}
                      </span>
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>

          {progress ? (
            <div className="mx-2.5 mb-2 rounded-md border border-line px-2.5 py-2">
              <p className="flex items-center gap-2 text-xs text-ink-soft">
                {progress.done < progress.total ? <Spinner className="size-3" /> : null}
                <span className="tnum">
                  {count(progress.done)} of {count(progress.total)} read
                </span>
              </p>
              {progress.failed > 0 ? (
                <p className="mt-0.5 text-xs text-muted tnum">{count(progress.failed)} could not be read</p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2 border-t border-line p-2.5">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex w-full items-center justify-between rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-ink"
            >
              <span>Search and jump</span>
              <kbd className="identifier rounded border border-line px-1 py-0.5 text-xs">Ctrl K</kbd>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted transition-colors hover:text-ink"
            >
              {theme === 'dark' ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
              {theme === 'dark' ? 'Light colours' : 'Dark colours'}
            </button>

            <Button type="button" onClick={openUpload} className="w-full gap-2">
              <Upload className="size-4" aria-hidden="true" />
              Upload
            </Button>
          </div>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onToggleTheme={toggleTheme}
        onUpload={openUpload}
      />
    </div>
  )
}
