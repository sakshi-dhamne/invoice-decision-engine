// Keeps public/invoices in sync with fixtures/pdfs — the browser fetches PDFs
// same-origin from public/invoices at runtime, so this must run before every build.
import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_DIR = path.join(ROOT, 'fixtures', 'pdfs')
const DEST_DIR = path.join(ROOT, 'public', 'invoices')

async function main() {
  await mkdir(DEST_DIR, { recursive: true })
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.pdf'))

  for (const file of files) {
    await cp(path.join(SOURCE_DIR, file), path.join(DEST_DIR, file))
  }

  console.log(`Copied ${files.length} PDFs from fixtures/pdfs to public/invoices`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
