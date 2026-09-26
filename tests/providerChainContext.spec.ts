// What the logs say when a provider rejects a request.
//
// Every PDF extraction was answered with a 400 that named nothing about the
// document, and the logs could not settle the one question that mattered: were the
// bytes a PDF? The context line that would have answered it existed, but only on
// the lines that report a whole call. A 4xx returns from inside the attempt loop,
// so the two lines a failing extraction actually wrote carried the model and the
// status and nothing else.
//
// These fix the shape of the evidence rather than the behaviour: the context
// precedes every attempt and sits on every failure line.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runProviderChain } from '../supabase/functions/_shared/providerChain.ts'
import { ProviderError } from '../supabase/functions/extract-invoice/providers/types.ts'

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return { lines, restore: () => spy.mockRestore() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const CONTEXT = 'invoice_number=INV-1 document=application/pdf bytes=4096'

async function runChain(
  outcome: 'ok' | 'fail-fast' | 'exhaust',
  logContext: string | undefined = CONTEXT,
): Promise<string[]> {
  const { lines, restore } = captureLogs()
  await runProviderChain({
    chain: [{ provider: 'gemini', model: 'a-model' }],
    label: 'extract-invoice',
    logContext,
    build: () => async () => {
      if (outcome === 'ok') return 'done'
      throw new ProviderError('INVALID_ARGUMENT', outcome === 'fail-fast' ? 400 : 503)
    },
  })
  restore()
  return lines
}

describe('what the chain records about an attempt', () => {
  it('announces the attempt before making it', async () => {
    const lines = await runChain('ok')
    expect(lines[0]).toContain('extract-invoice attempt provider=gemini model=a-model')
    expect(lines[0]).toContain(CONTEXT)
  })

  it('puts the context on the failure lines, which is where it was missing', async () => {
    const lines = await runChain('fail-fast')
    const failed = lines.find((line) => line.includes('attempt-failed')) ?? ''
    const fast = lines.find((line) => line.includes('failed-fast')) ?? ''
    expect(failed).toContain(CONTEXT)
    expect(failed).toContain('status=400')
    expect(fast).toContain(CONTEXT)
  })

  it('leaves no line about a failing request without it', async () => {
    // The case that sent us looking: a 400 returns from inside the loop, so any
    // line that only reports a finished chain is one a failing PDF never reaches.
    for (const outcome of ['fail-fast', 'exhaust'] as const) {
      const lines = await runChain(outcome)
      expect(lines.length).toBeGreaterThan(1)
      for (const line of lines) expect(line).toContain(CONTEXT)
    }
  })

  it('still reports a success with it', async () => {
    const lines = await runChain('ok')
    expect(lines.find((line) => line.includes(' ok '))).toContain(CONTEXT)
  })

  it('reads cleanly when there is no context to add', async () => {
    const lines = await runChain('exhaust', undefined)
    for (const line of lines) expect(line).not.toMatch(/ {2}/)
  })
})
