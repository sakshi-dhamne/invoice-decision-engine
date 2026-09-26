// What the logs say when a provider rejects a request.
//
// Every PDF extraction was answered with a 400 that named nothing about the
// document, and the logs could not settle the one question that mattered: were
// the bytes a PDF? The context line that would have answered it existed, but only
// on the lines that report a whole call. A 4xx returns from inside the attempt
// loop, so the two lines a failing extraction actually wrote carried the model and
// the status and nothing else.
//
// These fix the shape of the evidence rather than the behaviour: the context
// precedes every attempt and sits on every failure line, and the adapter can be
// asked, behind a flag, to say what it is about to send.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { base64ByteLength } from '../src/lib/extractionSchema.ts'
import {
  DEBUG_ENV_VAR,
  PAYLOAD_PREFIX_CHARS,
  debugEnabled,
  logDebug,
  payloadPrefix,
} from '../supabase/functions/_shared/debug.ts'
import { runProviderChain } from '../supabase/functions/_shared/providerChain.ts'
import { ProviderError } from '../supabase/functions/extract-invoice/providers/types.ts'
import { createGeminiProvider } from '../supabase/functions/extract-invoice/providers/gemini.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures/pdfs')
const pdfName = readdirSync(fixtureDir).filter((name) => name.endsWith('.pdf')).sort()[0]
const pdfBytes = new Uint8Array(readFileSync(join(fixtureDir, pdfName)))
const pdfBase64 = Buffer.from(pdfBytes).toString('base64')

// A PNG header, which is all the sniffer and these lines ever look at.
const pngBase64 = Buffer.from(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
).toString('base64')

// What the app serves in place of a document it cannot find.
const htmlBase64 = Buffer.from('<!DOCTYPE html><html lang="en"><head>').toString('base64')

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return { lines, restore: () => spy.mockRestore() }
}

function withDebug(value: string | undefined): void {
  vi.stubGlobal('Deno', { env: { get: (name: string) => (name === DEBUG_ENV_VAR ? value : undefined) } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The size in the line
// ---------------------------------------------------------------------------

describe('how big the payload is', () => {
  it('reports the document exactly, not approximately', () => {
    expect(base64ByteLength(pdfBase64)).toBe(pdfBytes.byteLength)
  })

  it('accounts for padding, which the old arithmetic did not', () => {
    // "A" is one byte, "AB" two, "ABC" three: one, two and no padding characters.
    expect(base64ByteLength(Buffer.from('A').toString('base64'))).toBe(1)
    expect(base64ByteLength(Buffer.from('AB').toString('base64'))).toBe(2)
    expect(base64ByteLength(Buffer.from('ABC').toString('base64'))).toBe(3)
    expect(base64ByteLength('')).toBe(0)
  })

  it('is unbothered by line breaks in the encoding', () => {
    const wrapped = pdfBase64.replace(/(.{76})/g, '$1\n')
    expect(base64ByteLength(wrapped)).toBe(pdfBytes.byteLength)
  })
})

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

describe('the diagnostic flag', () => {
  it('is off where there is no environment to read', () => {
    expect(debugEnabled()).toBe(false)
  })

  it('is off unless something turns it on', () => {
    for (const value of [undefined, '', '  ', '0', 'false', 'FALSE']) {
      withDebug(value)
      expect(debugEnabled()).toBe(false)
    }
  })

  it('is on when it is set', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) {
      withDebug(value)
      expect(debugEnabled()).toBe(true)
    }
  })

  it('writes nothing at all while it is off', () => {
    withDebug('0')
    const { lines, restore } = captureLogs()
    logDebug('something')
    restore()
    expect(lines).toEqual([])
  })

  it('survives an environment that refuses to be read', () => {
    vi.stubGlobal('Deno', {
      env: {
        get: () => {
          throw new Error('not permitted')
        },
      },
    })
    expect(() => debugEnabled()).not.toThrow()
    expect(debugEnabled()).toBe(false)
  })
})

describe('the payload prefix', () => {
  it('quotes enough to recognise the format and no more', () => {
    expect(payloadPrefix(pdfBase64)).toHaveLength(PAYLOAD_PREFIX_CHARS)
    expect(payloadPrefix(pdfBase64).startsWith('JVBERi0')).toBe(true)
  })

  it('tells a document from a web page', () => {
    // Which is the question the whole failure turned on.
    expect(payloadPrefix(pngBase64).startsWith('iVBORw0KGgo')).toBe(true)
    expect(payloadPrefix(htmlBase64).startsWith('JVBERi0')).toBe(false)
    expect(payloadPrefix(htmlBase64).startsWith('PCFET0NUWVBF')).toBe(true)
  })

  it('does not fall over on a payload shorter than the prefix', () => {
    expect(payloadPrefix('QQ==')).toBe('QQ==')
  })
})

// ---------------------------------------------------------------------------
// What the adapter says before it sends
// ---------------------------------------------------------------------------

function stubGeminiFetch(status = 400): void {
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status,
    text: async () => 'INVALID_ARGUMENT: Unable to process input image.',
  }))
}

async function attemptExtraction(base64: string, mimeType: string): Promise<void> {
  const provider = createGeminiProvider('a-model', 'a-key')
  await expect(provider.extract(base64, 'a prompt', mimeType)).rejects.toThrow(/400/)
}

describe('what the adapter reports before it sends', () => {
  it('names the model, the type, the size and the head of the payload', async () => {
    withDebug('1')
    stubGeminiFetch()
    const { lines, restore } = captureLogs()
    await attemptExtraction(pdfBase64, 'application/pdf')
    restore()

    const line = lines.find((entry) => entry.includes('gemini-request'))
    expect(line).toBeDefined()
    expect(line).toContain('model=a-model')
    expect(line).toContain('mime_type=application/pdf')
    expect(line).toContain(`bytes=${pdfBytes.byteLength}`)
    expect(line).toContain('base64_head=JVBERi0')
  })

  it('writes the line before the request, so a rejection has it to be read against', async () => {
    withDebug('1')
    const order: string[] = []
    vi.stubGlobal('fetch', async () => {
      order.push('fetch')
      return { ok: false, status: 400, text: async () => 'INVALID_ARGUMENT' }
    })
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('gemini-request')) order.push('log')
    })
    const provider = createGeminiProvider('a-model', 'a-key')
    await expect(provider.extract(pdfBase64, 'application/pdf', 'application/pdf')).rejects.toThrow()
    spy.mockRestore()

    expect(order).toEqual(['log', 'fetch'])
  })

  it('shows an image as an image, through the identical path', async () => {
    withDebug('1')
    stubGeminiFetch()
    const { lines, restore } = captureLogs()
    await attemptExtraction(pngBase64, 'image/png')
    restore()

    const line = lines.find((entry) => entry.includes('gemini-request')) ?? ''
    expect(line).toContain('mime_type=image/png')
    expect(line).toContain('base64_head=iVBORw0KGgo')
  })

  it('says nothing while the flag is off, which is how it ships', async () => {
    withDebug(undefined)
    stubGeminiFetch()
    const { lines, restore } = captureLogs()
    await attemptExtraction(pdfBase64, 'application/pdf')
    restore()

    expect(lines.filter((entry) => entry.includes('gemini-request'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// What the chain says about every attempt
// ---------------------------------------------------------------------------

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
