// The thresholds, and the order the checks run in.
//
// Everything on the left is read from and written to the rules table, which is
// what the engine reads at run time. Nothing on this page is a copy of a number
// that lives somewhere else, so moving a control here really does change what the
// next invoice is measured against.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { AppShell } from '@/components/AppShell.tsx'
import { ErrorNote, Loading, Panel, PanelHeading, Spinner, VerdictChip } from '@/components/Primitives.tsx'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { loadFeed, needsAPerson } from '@/lib/feed.ts'
import { reasonSentence, ruleCopy } from '@/lib/reasonCopy.ts'
import { runInvoice } from '@/lib/pipeline.ts'
import { getRules, updateRule } from '@/lib/queries.ts'
import { DECISION_RULES } from '@/rules/decide.ts'
import type { RuleRow, Verdict } from '@/lib/database.types.ts'

// The table holds twenty-two rows. The twenty-third outcome is what happens when
// none of them match, which the engine reaches by falling through rather than by
// testing for it, so it is added here to show the whole order of checks.
const CHECKS: { rule: number; code: string; verdict: Verdict | null }[] = [
  ...DECISION_RULES.map((row) => ({ rule: row.rule, code: row.code as string, verdict: row.verdict })),
  { rule: 23, code: 'CLEAN_MATCH', verdict: 'AUTO_APPROVE' },
]

// How a threshold is written down depends on what it measures. A percentage is not
// read the same way as a count of days.
function unitNote(unit: string | null): string {
  switch (unit) {
    case 'percent':
      return 'A share, written as a decimal. 0.02 means two percent.'
    case 'INR':
      return 'Rupees.'
    case 'days':
      return 'Days.'
    case 'count':
      return 'A number of invoices.'
    case 'score':
    case 'weight':
    case 'ratio':
      return 'A score between zero and one.'
    default:
      return ''
  }
}

export default function Rules() {
  const [rules, setRules] = useState<Record<string, RuleRow> | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const fresh = await getRules()
      setRules(fresh)
      setEdits(Object.fromEntries(Object.entries(fresh).map(([key, row]) => [key, String(row.value ?? '')])))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The thresholds could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const changed = useMemo(() => {
    if (!rules) return []
    return Object.entries(edits)
      .filter(([key, value]) => {
        const parsed = Number(value)
        return value.trim().length > 0 && Number.isFinite(parsed) && parsed !== rules[key]?.value
      })
      .map(([key, value]) => ({ key, value: Number(value) }))
  }, [edits, rules])

  // Saving and re-running belong together: a threshold that has moved has not
  // really been applied until the invoices it affects have been measured again.
  const saveAndRerun = async () => {
    setError(null)
    setSaved(false)
    setSaving('Saving the thresholds')

    try {
      for (const change of changed) {
        await updateRule(change.key, change.value)
      }

      setSaving('Finding invoices to check again')
      const feed = await loadFeed()
      const waiting = feed.rows.filter(
        (row) => needsAPerson(row.run) && row.run.verdict !== 'BLOCK' && row.invoice !== null,
      )

      for (const [index, row] of waiting.entries()) {
        setSaving(`Checking invoice ${index + 1} of ${waiting.length} again`)
        if (row.invoice) await runInvoice(row.invoice.id).catch(() => undefined)
      }

      await load()
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The thresholds could not be saved.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Rules</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-muted">
            The checks run in the order below, and the first one that matches sets the outcome. The thresholds on the
            left are what those checks measure against.
          </p>
        </div>

        {error ? (
          <ErrorNote title="The thresholds could not be saved">
            {error} Nothing was changed. Try again, or reload the page to start over.
          </ErrorNote>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeading
              right={
                <span className="text-xs text-muted">
                  {changed.length > 0 ? `${changed.length} changed` : saved ? 'Saved' : 'No changes'}
                </span>
              }
            >
              Thresholds
            </PanelHeading>

            {rules === null ? (
              <Loading>Loading the thresholds</Loading>
            ) : (
              <>
                <ul className="divide-y divide-line-soft">
                  {Object.keys(rules)
                    .sort()
                    .map((key) => {
                      const copy = ruleCopy(key)
                      const row = rules[key]
                      const dirty = changed.some((change) => change.key === key)
                      return (
                        <li key={key} className="flex items-start gap-4 px-5 py-3.5">
                          <div className="min-w-0 flex-1">
                            <label htmlFor={`rule-${key}`} className="text-sm font-medium text-ink">
                              {copy.label}
                            </label>
                            <p className="mt-0.5 text-sm text-muted">{copy.note}</p>
                            <p className="mt-0.5 text-xs text-muted">{unitNote(row.unit)}</p>
                          </div>
                          <input
                            id={`rule-${key}`}
                            type="number"
                            step="any"
                            inputMode="decimal"
                            value={edits[key] ?? ''}
                            onChange={(event) => setEdits((current) => ({ ...current, [key]: event.target.value }))}
                            className={cn(
                              'h-9 w-32 shrink-0 rounded-md border bg-surface px-3 text-right text-sm text-ink tnum',
                              dirty ? 'border-ink-soft' : 'border-line',
                            )}
                          />
                        </li>
                      )
                    })}
                </ul>

                <div className="flex items-center gap-3 border-t border-line-soft px-5 py-4">
                  <Button type="button" onClick={saveAndRerun} disabled={saving !== null} className="gap-2">
                    {saving ? <Spinner className="border-t-primary-foreground" /> : null}
                    {saving ?? 'Save and re-run held invoices'}
                  </Button>
                  <p className="text-sm text-muted">
                    Blocked invoices are left alone. A block is about who is being paid, not about a threshold.
                  </p>
                </div>
              </>
            )}
          </Panel>

          <Panel>
            <PanelHeading right={<span className="text-xs text-muted">{CHECKS.length} checks</span>}>
              The order of checks
            </PanelHeading>
            <ol className="divide-y divide-line-soft">
              {CHECKS.map((row) => (
                <li key={row.rule} className="flex items-start gap-4 px-5 py-3">
                  <span className="mt-0.5 w-6 shrink-0 text-right text-sm text-muted tnum">{row.rule}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink-soft">{reasonSentence(row.code)}</p>
                    <p className="identifier mt-1 text-xs text-muted">{row.code}</p>
                  </div>
                  <span className="shrink-0">
                    {row.verdict ? (
                      <VerdictChip verdict={row.verdict} size="sm" />
                    ) : (
                      <span className="text-xs text-muted">Checks again from the top</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </AppShell>
  )
}
