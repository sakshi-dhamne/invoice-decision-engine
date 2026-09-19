// Presentation helpers. Nothing here decides anything.

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const INR_PRECISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function money(value: number | null | undefined, currency = 'INR'): string {
  if (value == null || !Number.isFinite(value)) return 'Not read'
  if (currency !== 'INR') {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
  }
  return Number.isInteger(value) ? INR.format(value) : INR_PRECISE.format(value)
}

export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('en-IN').format(value)
}

export function percent(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return 'Not known'
  return `${(value * 100).toFixed(decimals)}%`
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return 'Not read'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function dateAndTime(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString(
    'en-IN',
    { hour: '2-digit', minute: '2-digit' },
  )}`
}

// Durations a person reads at a glance, not a stopwatch reading.
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)} min`
}

// How long something has been waiting. The compact form is for a column in a list
// a person scans; the long form is for a sentence.
export function waitingSince(since: string | null | undefined, now: number = Date.now()): string {
  if (!since) return 'now'
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return 'now'
  const minutes = Math.max(0, Math.round((now - start) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function waitingFor(since: string | null | undefined, now: number = Date.now()): string {
  if (!since) return 'Just now'
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return 'Just now'
  const minutes = Math.max(0, Math.round((now - start) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.round(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * References the system keeps for itself.
 *
 * A file hash, a row id and a storage key are how this software finds things
 * again. None of them is a fact about the invoice, and none belongs in front of a
 * person working a queue. They are shown in one place, the audit block on the
 * History tab, where someone chasing a support question can copy them.
 */
export const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'file_hash',
  'pdf_url',
  'storage_path',
  'run_id',
  'invoice_id',
  'submission_id',
  'parent_run_id',
  'id',
  'vendor_id',
  'prior_run_id',
])

export function isInternalKey(key: string): boolean {
  return INTERNAL_KEYS.has(key)
}

// Evidence keys arrive as snake_case from the rules engine. A person should not
// have to read them that way.
export function humanKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// Evidence values are arbitrary JSON. Render something readable rather than
// dumping a blob at a finance manager.
export function evidenceValue(value: unknown): string {
  if (value == null) return 'None'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return Number.isInteger(value) ? count(value) : String(Number(value.toFixed(4)))
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None'
    return value.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : String(entry))).join(', ')
  }
  return JSON.stringify(value)
}
