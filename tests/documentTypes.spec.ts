// What gets posted to the model, and what it is called.
//
// Every PDF extraction failed with a 400 from the model that named nothing about
// the document, while every image was fine. The cause was one line: an
// unrecognised content type was answered with "call it a PDF". The seeded
// invoices are static files served from the app's own origin, and the app
// rewrites an unmatched path to index.html, so a PDF missing from the deployment
// came back as an HTML page with status 200. That page was then posted to the
// model labelled as a document.
//
// So the bytes decide what a document is, on both sides of the call, and a
// payload that is neither a PDF nor an image we read is refused where it can
// still be explained. These drive a real fixture PDF and an image through the
// same path, which is the pairing that would have caught it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  DOCUMENT_HEAD_BYTES,
  headFromBase64,
  sniffDocumentType,
  type AcceptedDocumentType,
} from '../src/lib/extractionSchema.ts'
import { documentFromBytes } from '../src/lib/extraction.ts'
import { createGeminiProvider } from '../supabase/functions/extract-invoice/providers/gemini.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures/pdfs')

// A real invoice from the corpus, as bytes.
const pdfName = readdirSync(fixtureDir).filter((name) => name.endsWith('.pdf')).sort()[0]
const pdfBytes = new Uint8Array(readFileSync(join(fixtureDir, pdfName)))

function bytesOf(...parts: (number[] | string)[]): Uint8Array {
  const flat: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') flat.push(...[...part].map((character) => character.charCodeAt(0)))
    else flat.push(...part)
  }
  return new Uint8Array(flat)
}

// Header bytes only. The sniffer reads the first sixteen and nothing else, so a
// decodable image is not what is being tested here.
const pngBytes = bytesOf([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR')
const jpegBytes = bytesOf([0xff, 0xd8, 0xff, 0xe0], [0, 0x10], 'JFIF')
const webpBytes = bytesOf('RIFF', [0x24, 0x10, 0, 0], 'WEBP', 'VP8 ')
const heicBytes = bytesOf([0, 0, 0, 0x18], 'ftyp', 'heic', [0, 0, 0, 0])
// What the app's own rewrite serves in place of a document it cannot find.
const htmlBytes = bytesOf('<!doctype html><html lang="en">')

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Reading the type off the bytes
// ---------------------------------------------------------------------------

describe('what a document is', () => {
  it('reads a real invoice from the corpus as a PDF', () => {
    expect(sniffDocumentType(pdfBytes.subarray(0, DOCUMENT_HEAD_BYTES))).toBe('application/pdf')
  })

  it.each([
    ['image/png', pngBytes],
    ['image/jpeg', jpegBytes],
    ['image/webp', webpBytes],
    ['image/heic', heicBytes],
  ] as [AcceptedDocumentType, Uint8Array][])('reads %s off its signature', (expected, bytes) => {
    expect(sniffDocumentType(bytes)).toBe(expected)
  })

  it('reads a web page as nothing at all', () => {
    expect(sniffDocumentType(htmlBytes)).toBeNull()
  })

  it('reads the signature off a base64 payload without decoding the whole thing', () => {
    const base64 = toBase64(pdfBytes)
    const head = headFromBase64(base64)
    expect(head.length).toBeGreaterThanOrEqual(DOCUMENT_HEAD_BYTES)
    expect(sniffDocumentType(head)).toBe('application/pdf')
    // A prefix, not the document.
    expect(head.length).toBeLessThan(pdfBytes.length)
  })

  it('survives a payload too short to hold a signature', () => {
    expect(headFromBase64('')).toEqual(new Uint8Array())
    expect(sniffDocumentType(headFromBase64('AA'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Packaging it for the call
// ---------------------------------------------------------------------------

describe('packaging a document for the model', () => {
  it('sends a PDF as a PDF', () => {
    const packaged = documentFromBytes(bufferOf(pdfBytes), 'application/pdf')
    expect(packaged.mimeType).toBe('application/pdf')
    expect(packaged.base64).toBe(toBase64(pdfBytes))
  })

  it('sends an image as that image', () => {
    expect(documentFromBytes(bufferOf(pngBytes), 'image/png').mimeType).toBe('image/png')
  })

  it('believes the bytes over the header', () => {
    // A server that serves a PNG as text/html, or a PDF as application/octet-stream,
    // has said nothing useful. The signature has.
    expect(documentFromBytes(bufferOf(pngBytes), 'text/html').mimeType).toBe('image/png')
    expect(documentFromBytes(bufferOf(pdfBytes), 'application/octet-stream').mimeType).toBe('application/pdf')
  })

  it('reads a type off the header when the format has no signature we know', () => {
    expect(documentFromBytes(bufferOf(bytesOf('not a format we recognise')), 'image/heic').mimeType).toBe('image/heic')
  })

  // The regression itself.
  it('refuses a web page instead of calling it a PDF', () => {
    expect(() => documentFromBytes(bufferOf(htmlBytes), 'text/html')).toThrow(/not a PDF or an image/)
  })

  it('refuses it even when something insists it is a PDF', () => {
    expect(() => documentFromBytes(bufferOf(htmlBytes), 'application/pdf')).toThrow(/not a PDF or an image/)
  })

  it('says what arrived, so the failure explains itself', () => {
    expect(() => documentFromBytes(bufferOf(htmlBytes), 'text/html')).toThrow(/text\/html/)
  })
})

// ---------------------------------------------------------------------------
// What reaches the model
// ---------------------------------------------------------------------------

// The adapter's own request, with the network stubbed. A PDF and an image go
// through the identical path, which is the pairing that was missing.
async function requestBodyFor(bytes: Uint8Array, declaredType: string | null): Promise<Record<string, never>> {
  const packaged = documentFromBytes(bufferOf(bytes), declaredType)
  let sent: unknown = null

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body)
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    invoice_number: null,
                    invoice_date: null,
                    vendor_name: null,
                    po_reference: null,
                    currency: null,
                    line_items: [],
                    subtotal: null,
                    tax: null,
                    total: null,
                    bank_account: null,
                    bank_ifsc: null,
                    bank_name: null,
                    remit_to_name: null,
                    document_type: 'invoice',
                    notes: null,
                    confidence: {},
                    unreadable_fields: [],
                    extraction_notes: null,
                  }),
                },
              ],
            },
          },
        ],
      }),
    }
  })

  const provider = createGeminiProvider('a-model', 'a-key')
  await provider.extract(packaged.base64, 'a prompt', packaged.mimeType)
  vi.unstubAllGlobals()
  return sent as Record<string, never>
}

describe('the request the model receives', () => {
  it('declares a PDF as a PDF, with the document intact', async () => {
    const body = await requestBodyFor(pdfBytes, 'application/pdf')
    const part = (body as unknown as { contents: { parts: { inline_data?: { mime_type: string; data: string } }[] }[] })
      .contents[0].parts[0]
    expect(part.inline_data?.mime_type).toBe('application/pdf')
    expect(part.inline_data?.data).toBe(toBase64(pdfBytes))
  })

  it('declares an image as that image, through the same path', async () => {
    const body = await requestBodyFor(pngBytes, 'image/png')
    const part = (body as unknown as { contents: { parts: { inline_data?: { mime_type: string; data: string } }[] }[] })
      .contents[0].parts[0]
    expect(part.inline_data?.mime_type).toBe('image/png')
    expect(part.inline_data?.data).toBe(toBase64(pngBytes))
  })

  it('never posts a document under a type its bytes contradict', async () => {
    // Which is the whole defect: the model answers a mislabelled document with a
    // 400 that says nothing about the document.
    for (const [bytes, declared, expected] of [
      [pdfBytes, 'application/octet-stream', 'application/pdf'],
      [pngBytes, 'application/pdf', 'image/png'],
    ] as [Uint8Array, string, string][]) {
      const body = await requestBodyFor(bytes, declared)
      const part = (
        body as unknown as { contents: { parts: { inline_data?: { mime_type: string } }[] }[] }
      ).contents[0].parts[0]
      expect(part.inline_data?.mime_type).toBe(expected)
    }
  })
})
