// The frame every product screen sits in: the name, the four places you can go,
// search, the colour-scheme toggle, and the button that puts a document in.

import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Moon, Search, Sun, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { applyTheme, readTheme, restoreExplainer, storeTheme, type Theme } from '@/lib/localSettings.ts'
import { UploadContext } from './uploadContext.ts'
import { UploadDialog } from './UploadDialog.tsx'

const NAV = [
  { to: '/', label: 'Needs you' },
  { to: '/dashboard', label: 'All runs' },
  { to: '/rules', label: 'Rules' },
]

export function AppShell({
  children,
  search,
  onSearchChange,
}: {
  children: ReactNode
  search?: string
  onSearchChange?: (value: string) => void
}) {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [uploadOpen, setUploadOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // The class on <html> is the external system here; the state above is the
  // source of truth for it.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
    storeTheme(next)
  }

  // Reopening the explainer clears the stored flag and sends the reader to the
  // page that shows it.
  const showHowItWorks = () => {
    restoreExplainer()
    if (location.pathname === '/') window.location.reload()
    else navigate('/')
  }

  return (
    <UploadContext.Provider value={{ openUpload: () => setUploadOpen(true) }}>
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-6">
          <Link to="/" className="shrink-0 text-lg font-bold tracking-tight text-ink">
            Clearline
          </Link>

          <nav aria-label="Main" className="flex shrink-0 items-center gap-1">
            {NAV.map((item) => {
              const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    active ? 'bg-line-soft font-medium text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
            <button
              type="button"
              onClick={showHowItWorks}
              className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink"
            >
              How it works
            </button>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {onSearchChange ? (
              <div className="relative hidden lg:block">
                <label htmlFor="shell-search" className="sr-only">
                  Search invoices and vendors
                </label>
                <Search aria-hidden="true" className="absolute left-2.5 top-2.5 size-4 text-faint" />
                <input
                  id="shell-search"
                  type="search"
                  value={search ?? ''}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Search invoices and vendors"
                  className="h-9 w-64 rounded-md border border-line bg-surface pl-8 pr-3 text-sm text-ink placeholder:text-muted"
                />
              </div>
            ) : null}

            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to the light colour scheme' : 'Switch to the dark colour scheme'}
              className="rounded-md border border-line p-2 text-muted transition-colors hover:text-ink"
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            <Button type="button" onClick={() => setUploadOpen(true)} className="gap-2">
              <Upload className="size-4" aria-hidden="true" />
              Upload an invoice
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
    </UploadContext.Provider>
  )
}
