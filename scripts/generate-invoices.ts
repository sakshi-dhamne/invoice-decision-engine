import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import { render } from './template-engine.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURES_DIR = path.join(ROOT, 'fixtures')
const TEMPLATES_DIR = path.join(ROOT, 'templates')
const PDFS_DIR = path.join(FIXTURES_DIR, 'pdfs')

// Pinned pre-installed Chromium — the installed @playwright/test version expects a
// newer revision than what ships in this sandbox, so we point at the known-good binary
// instead of letting Playwright try (and fail) to download one.
const CHROMIUM_EXECUTABLE = '/opt/pw-browsers/chromium'

interface Vendor {
  id: string
  legal_name: string
  aliases: string[]
  bank_account: string
  ifsc: string
  gstin: string
  email_domain: string
  status: 'active' | 'inactive'
  address: { line1: string; city: string; state: string; pincode: string }
}

interface LineItem {
  description: string
  quantity: number
  unit_price: number
  amount: number
}

interface InvoiceRecord {
  invoice_number: string
  vendor_name_as_printed: string
  vendor_id: string | null
  po_reference: string | null
  invoice_date: string
  currency: string
  line_items: LineItem[]
  subtotal: number
  tax: number
  total: number
  bank_account_printed: string
  remit_to_name: string
  document_type: 'invoice' | 'credit_note'
  template: 'a' | 'b' | 'c' | 'd' | 'e'
  notes_field: string | null
  parent_invoice_number: string | null
  expected_verdict: string
  case_description: string
  pdf_filename: string
  scanned?: boolean
  vendor_email_override?: string
  vendor_address_override?: { line1: string; city: string; state: string; pincode: string }
  vendor_gstin_override?: string
}

const BUYER = {
  name: 'Orion Manufacturing Private Limited',
  address_line1: 'Plot 7, SIPCOT Industrial Growth Centre, Oragadam',
  city_state_pin: 'Chennai, Tamil Nadu 602105',
  gstin: '33AAOCM4321F1Z6',
}

function formatINR(amount: number): string {
  const isNegative = amount < 0
  const abs = Math.abs(Math.round(amount))
  const str = String(abs)
  const lastThree = str.slice(-3)
  const other = str.slice(0, -3)
  const groupedOther = other.replace(/\B(?=(\d{2})+(?!\d)$)/g, ',')
  const grouped = other ? `${groupedOther},${lastThree}` : lastThree
  return `${isNegative ? '-' : ''}₹${grouped}`
}

function formatDate(iso: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = iso.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`
}

function distributeProportional(weights: number[], target: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (sum === 0) return weights.map(() => 0)
  const raw = weights.map((w) => (w / sum) * target)
  const rounded = raw.map((v) => Math.round(v))
  const diff = target - rounded.reduce((s, v) => s + v, 0)
  rounded[rounded.length - 1] += diff
  return rounded
}

function hsnFor(description: string): string {
  const d = description.toLowerCase()
  if (d.includes('server') || d.includes('switch') || d.includes('hardware') || d.includes('tool')) return '8471'
  if (d.includes('furniture') || d.includes('chair') || d.includes('desk')) return '9403'
  if (d.includes('stationery') || d.includes('printer') || d.includes('toner')) return '4820'
  if (d.includes('freight') || d.includes('logistics') || d.includes('warehousing') || d.includes('handling')) return '996791'
  if (d.includes('software') || d.includes('cloud') || d.includes('development') || d.includes('migration') || d.includes('pipeline') || d.includes('training') || d.includes('handover')) return '998314'
  if (d.includes('consulting') || d.includes('advisory') || d.includes('support')) return '998231'
  if (d.includes('facilities')) return '998531'
  return '998719'
}

function vendorInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase()
}

function buildViewModel(record: InvoiceRecord, vendorsById: Map<string, Vendor>) {
  const master = record.vendor_id ? vendorsById.get(record.vendor_id) : undefined

  const address = record.vendor_address_override ?? master?.address
  const cityStatePin = address ? `${address.city}, ${address.state} ${address.pincode}` : ''

  const vendor = {
    name: record.vendor_name_as_printed,
    initial: vendorInitial(record.vendor_name_as_printed),
    address_line1: address?.line1 ?? '',
    city_state_pin: cityStatePin,
    gstin: record.vendor_gstin_override ?? master?.gstin ?? '',
    email: record.vendor_email_override ?? (master ? `billing@${master.email_domain}` : ''),
  }

  const showTaxRow = record.template !== 'b'

  let displayAmounts = record.line_items.map((li) => li.amount)
  if (!showTaxRow) {
    displayAmounts = distributeProportional(
      record.line_items.map((li) => li.amount),
      record.total,
    )
  }

  const gstAmounts = distributeProportional(
    record.line_items.map((li) => li.amount),
    record.tax,
  )

  const lineItems = record.line_items.map((li, i) => {
    const displayAmount = displayAmounts[i]
    const gstAmount = gstAmounts[i]
    return {
      index: i + 1,
      description: li.description,
      quantity: li.quantity,
      hsn_code: hsnFor(li.description),
      unit_price_formatted: formatINR(displayAmount / li.quantity),
      amount_formatted: formatINR(displayAmount),
      gst_rate_formatted: record.subtotal > 0 ? `${Math.round((record.tax / record.subtotal) * 100)}%` : '0%',
      gst_amount_formatted: formatINR(gstAmount),
      line_total_formatted: formatINR(li.amount + gstAmount),
    }
  })

  return {
    doc_title: record.document_type === 'credit_note' ? 'CREDIT NOTE' : 'TAX INVOICE',
    invoice_number: record.invoice_number,
    invoice_date_formatted: formatDate(record.invoice_date),
    currency: record.currency,
    vendor,
    buyer: BUYER,
    has_po: record.po_reference !== null,
    po_reference: record.po_reference ?? '',
    has_notes: Boolean(record.notes_field),
    notes_field: record.notes_field ?? '',
    line_items: lineItems,
    package_count: lineItems.length,
    subtotal_formatted: formatINR(record.subtotal),
    tax_formatted: formatINR(record.tax),
    total_formatted: formatINR(record.total),
    show_tax_row: showTaxRow,
    bank_account_printed: record.bank_account_printed,
    ifsc_printed: master?.ifsc ?? '',
    remit_to_name: record.remit_to_name,
  }
}

// Builds an RGBA noise patch: random per-pixel colour at a fixed alpha, so compositing it
// with the default 'over' blend genuinely perturbs every pixel (unlike 'overlay' blend,
// which barely affects near-white/near-black regions and left the earlier attempt at this
// too clean to pass as a phone photo).
function randomNoisePatch(width: number, height: number, alpha: number): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buffer[i * 4] = Math.floor(Math.random() * 256)
    buffer[i * 4 + 1] = Math.floor(Math.random() * 256)
    buffer[i * 4 + 2] = Math.floor(Math.random() * 256)
    buffer[i * 4 + 3] = alpha
  }
  return buffer
}

async function obscureRegion(pngBuffer: Buffer, region: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const padding = 14
  const left = Math.max(0, Math.round(region.x) - padding)
  const top = Math.max(0, Math.round(region.y) - padding)
  const width = Math.round(region.width) + padding * 2
  const height = Math.round(region.height) + padding * 2

  const degradedPatch = await sharp(pngBuffer)
    .extract({ left, top, width, height })
    .blur(1.6)
    .linear(0.75, 55) // wash the patch toward grey without flattening it completely
    .composite([
      { input: randomNoisePatch(width, height, 75), raw: { width, height, channels: 4 }, blend: 'over' },
    ])
    .png()
    .toBuffer()

  return sharp(pngBuffer)
    .composite([{ input: degradedPatch, left, top }])
    .png()
    .toBuffer()
}

async function applyScanEffect(pngBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(pngBuffer).metadata()
  const width = metadata.width ?? 1240
  const height = metadata.height ?? 1754

  // Mild full-page sensor noise, low alpha so it reads as photo grain rather than static.
  const pageNoise = randomNoisePatch(width, height, 22)

  const downW = Math.round(width * 0.6)
  const downH = Math.round(height * 0.6)

  const scanned = await sharp(pngBuffer)
    .composite([{ input: pageNoise, raw: { width, height, channels: 4 }, blend: 'over' }])
    .rotate(1.5, { background: '#ffffff' })
    .resize(downW, downH) // downscale/upscale softens fine detail like a low-res phone camera
    .blur(0.5)
    .linear(0.72, 28) // contrast reduction: compress the dynamic range toward mid-grey
    .resize(width, height)
    .jpeg({ quality: 18, chromaSubsampling: '4:2:0' })
    .toBuffer()

  return scanned
}

async function wrapJpegInPdf(jpegBuffer: Buffer): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create()
  const jpgImage = await pdfDoc.embedJpg(jpegBuffer)
  const A4_WIDTH = 595.28
  const A4_HEIGHT = 841.89
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT])

  const scale = Math.min(A4_WIDTH / jpgImage.width, A4_HEIGHT / jpgImage.height)
  const drawWidth = jpgImage.width * scale
  const drawHeight = jpgImage.height * scale

  page.drawImage(jpgImage, {
    x: (A4_WIDTH - drawWidth) / 2,
    y: (A4_HEIGHT - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  })

  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}

async function main() {
  const [vendors, invoices] = await Promise.all([
    readFile(path.join(FIXTURES_DIR, 'vendors.json'), 'utf-8').then((t) => JSON.parse(t) as Vendor[]),
    readFile(path.join(FIXTURES_DIR, 'invoices.json'), 'utf-8').then((t) => JSON.parse(t) as InvoiceRecord[]),
  ])
  const vendorsById = new Map(vendors.map((v) => [v.id, v]))

  const templateSources = new Map<string, string>()
  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    templateSources.set(letter, await readFile(path.join(TEMPLATES_DIR, `layout-${letter}.html`), 'utf-8'))
  }

  await mkdir(PDFS_DIR, { recursive: true })

  const browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE })
  const summary: { invoice_number: string; template: string; expected_verdict: string; output_path: string }[] = []

  try {
    for (const record of invoices) {
      const viewModel = buildViewModel(record, vendorsById)
      const html = render(templateSources.get(record.template)!, viewModel)

      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle' })

      const outputPath = path.join(PDFS_DIR, record.pdf_filename)

      if (record.scanned) {
        await page.setViewportSize({ width: 1240, height: 1754 })
        const totalBox = await page.locator('#total-value').boundingBox()
        const rawPng = await page.screenshot({ type: 'png', fullPage: true })
        const withObscuredTotal = totalBox ? await obscureRegion(rawPng, totalBox) : rawPng
        const scannedJpeg = await applyScanEffect(withObscuredTotal)
        const pdfBytes = await wrapJpegInPdf(scannedJpeg)
        await writeFile(outputPath, pdfBytes)
      } else {
        await page.pdf({
          path: outputPath,
          format: 'A4',
          landscape: record.template === 'd',
          printBackground: true,
        })
      }

      await page.close()

      summary.push({
        invoice_number: record.invoice_number,
        template: record.template,
        expected_verdict: record.expected_verdict,
        output_path: path.relative(ROOT, outputPath),
      })
    }
  } finally {
    await browser.close()
  }

  console.log('\nGenerated fixtures summary:\n')
  const numberWidth = Math.max(...summary.map((s) => s.invoice_number.length), 'Invoice #'.length)
  const verdictWidth = Math.max(...summary.map((s) => s.expected_verdict.length), 'Verdict'.length)
  const pathWidth = Math.max(...summary.map((s) => s.output_path.length), 'Output Path'.length)

  const header = `${'Invoice #'.padEnd(numberWidth)}  ${'Tpl'.padEnd(3)}  ${'Verdict'.padEnd(verdictWidth)}  ${'Output Path'.padEnd(pathWidth)}`
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of summary) {
    console.log(
      `${row.invoice_number.padEnd(numberWidth)}  ${row.template.padEnd(3)}  ${row.expected_verdict.padEnd(verdictWidth)}  ${row.output_path.padEnd(pathWidth)}`,
    )
  }
  console.log(`\n${summary.length} PDFs written to ${path.relative(ROOT, PDFS_DIR)}/`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
