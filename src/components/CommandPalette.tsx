// Jump to anything without reaching for the mouse.
//
// Opened with Ctrl K or Cmd K. Invoices are loaded the first time it opens rather
// than on every page, because a palette nobody has opened should cost nothing.

import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'

import { loadFeed, vendorNameFor, type FeedRow } from '@/lib/feed.ts'
import { money } from '@/lib/format.ts'
import { verdictLabel } from '@/lib/reasonCopy.ts'

const ROUTES = [
  { label: 'Go to what needs you', to: '/' },
  { label: 'Go to all runs', to: '/dashboard' },
  { label: 'Go to the rules', to: '/rules' },
]

export function CommandPalette({
  open,
  onOpenChange,
  onToggleTheme,
  onUpload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggleTheme: () => void
  onUpload: () => void
}) {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open || rows !== null) return
    void loadFeed()
      .then((feed) => setRows(feed.rows))
      .catch(() => setRows([]))
  }, [open, rows])

  const run = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search and jump"
      className="fixed left-1/2 top-24 z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
    >
      <Command.Input
        placeholder="Search an invoice number or a vendor"
        className="w-full border-b border-line bg-surface px-4 py-3 text-sm text-ink outline-none placeholder:text-muted"
      />

      <Command.List className="max-h-80 overflow-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          Nothing matches that. Try an invoice number, or part of a vendor name.
        </Command.Empty>

        <Command.Group
          heading="Invoices"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted"
        >
          {(rows ?? []).slice(0, 200).map((row) => (
            <Command.Item
              key={row.run.id}
              value={`${row.invoice?.invoice_number ?? ''} ${vendorNameFor(row)} ${row.invoice?.po_reference ?? ''}`}
              onSelect={() =>
                run(() =>
                  navigate(
                    row.invoice?.invoice_number
                      ? `/?invoice=${encodeURIComponent(row.invoice.invoice_number)}`
                      : `/decisions/${row.run.id}`,
                  ),
                )
              }
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-ink-soft data-[selected=true]:bg-line-soft"
            >
              <span className="identifier w-40 shrink-0 truncate text-ink">
                {row.invoice?.invoice_number ?? 'Not read yet'}
              </span>
              <span className="min-w-0 flex-1 truncate">{vendorNameFor(row)}</span>
              <span className="shrink-0 tnum">{money(row.invoice?.total, row.invoice?.currency ?? 'INR')}</span>
              <span className="w-16 shrink-0 text-right text-xs text-muted">{verdictLabel(row.run.verdict)}</span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group
          heading="Go to"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted"
        >
          {ROUTES.map((route) => (
            <Command.Item
              key={route.to}
              value={route.label}
              onSelect={() => run(() => navigate(route.to))}
              className="cursor-pointer rounded-md px-2 py-2 text-sm text-ink-soft data-[selected=true]:bg-line-soft"
            >
              {route.label}
            </Command.Item>
          ))}
          <Command.Item
            value="Upload an invoice"
            onSelect={() => run(onUpload)}
            className="cursor-pointer rounded-md px-2 py-2 text-sm text-ink-soft data-[selected=true]:bg-line-soft"
          >
            Upload an invoice
          </Command.Item>
          <Command.Item
            value="Switch the colour scheme"
            onSelect={() => run(onToggleTheme)}
            className="cursor-pointer rounded-md px-2 py-2 text-sm text-ink-soft data-[selected=true]:bg-line-soft"
          >
            Switch the colour scheme
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}
