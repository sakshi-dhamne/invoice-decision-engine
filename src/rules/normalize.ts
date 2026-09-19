// Pure string, number and date normalisation shared by every rule.
//
// Nothing here reads the clock, the network or the database: every function is a
// function of its arguments alone. That is what lets the whole rules engine be
// tested offline.

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Company-suffix and abbreviation expansions applied before any name scoring.
// Normalisation is cheap and deterministic and resolves most apparent mismatches
// before fuzzy scoring gets a say.
//
// The list leans Indian ("pvt", "ltd", "llp") alongside the common international
// forms. That is a deliberate, documented domain fit — a general-purpose company
// resolver would need a far larger table and a jurisdiction hint.
const TOKEN_EXPANSIONS: Readonly<Record<string, string>> = {
  pvt: 'private',
  pte: 'private',
  ltd: 'limited',
  limtd: 'limited',
  inc: 'incorporated',
  corp: 'corporation',
  co: 'company',
  intl: 'international',
  mfg: 'manufacturing',
  svcs: 'services',
  tech: 'tech',
}

// Legal-form and connective words carry almost no identifying information: two
// unrelated companies both ending "Private Limited" must not score as similar on
// the strength of the suffix. They still count for something, so a genuine
// "Pvt Ltd" vs "Private Limited" difference is not free.
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'private',
  'limited',
  'llp',
  'llc',
  'incorporated',
  'corporation',
  'company',
  'plc',
  'gmbh',
  'bv',
  'nv',
  'sa',
  'ag',
  'ab',
  'oy',
  'fze',
  'fzc',
  'fzco',
  'pjsc',
  'and',
  'the',
])

// Properties of the similarity function itself rather than operational
// thresholds — an AP controller tunes `vendor_match_threshold` in the rules
// table, never these. They are named and documented rather than inlined.
export const GENERIC_TOKEN_WEIGHT = 0.25
export const PREFIX_ABBREVIATION_SCORE = 0.92
export const MIN_ABBREVIATION_LENGTH = 3

export function normalizeText(value: string | null | undefined): string {
  if (value == null) return ''
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function tokenize(value: string | null | undefined): string[] {
  const normalized = normalizeText(value)
  return normalized.length === 0 ? [] : normalized.split(' ')
}

// Runs of single characters are a punctuated acronym that stripping punctuation
// has scattered — "L.L.P." becomes "l l p", "U.S.A." becomes "u s a". Rejoining
// them restores the word the document actually printed.
function joinScatteredAcronyms(tokens: string[]): string[] {
  const joined: string[] = []
  let run: string[] = []

  const flush = (): void => {
    if (run.length === 0) return
    joined.push(run.length > 1 ? run.join('') : run[0])
    run = []
  }

  for (const token of tokens) {
    if (token.length === 1) run.push(token)
    else {
      flush()
      joined.push(token)
    }
  }
  flush()
  return joined
}

// lowercase, trim, collapse whitespace, strip punctuation, expand suffixes.
export function normalizeCompanyName(value: string | null | undefined): string {
  return joinScatteredAcronyms(tokenize(value))
    .map((token) => TOKEN_EXPANSIONS[token] ?? token)
    .join(' ')
}

// Bank account numbers are compared exactly, after stripping the spacing that
// varies between printed layouts. A changed digit must never normalise away.
export function normalizeAccountNumber(value: string | null | undefined): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, '')
}

export function normalizeIdentifier(value: string | null | undefined): string {
  if (value == null) return ''
  return String(value).trim().toUpperCase().replace(/\s+/g, '')
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function bigrams(value: string): string[] {
  const result: string[] = []
  for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2))
  return result
}

// Sørensen–Dice over character bigrams, multiset semantics so repeated bigrams
// count once each rather than collapsing.
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1
  if (a.length < 2 || b.length < 2) return 0

  const counts = new Map<string, number>()
  for (const gram of bigrams(a)) counts.set(gram, (counts.get(gram) ?? 0) + 1)

  let shared = 0
  const bGrams = bigrams(b)
  for (const gram of bGrams) {
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      counts.set(gram, remaining - 1)
      shared++
    }
  }

  return (2 * shared) / (a.length - 1 + bGrams.length)
}

// Similarity of two single words. Truncation is how company names are abbreviated
// in practice ("Tech" for "Technologies", "Intl" for "International"), and raw
// bigram overlap scores that pairing far lower than it deserves, so a prefix
// relationship is recognised explicitly.
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length >= MIN_ABBREVIATION_LENGTH && longer.startsWith(shorter)) {
    return PREFIX_ABBREVIATION_SCORE
  }
  return diceCoefficient(a, b)
}

function alignmentScore(tokensA: string[], tokensB: string[], weightOf: (token: string) => number): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0

  const directional = (from: string[], to: string[]): { sum: number; total: number } => {
    let sum = 0
    let total = 0
    for (const token of from) {
      const weight = weightOf(token)
      total += weight
      let best = 0
      for (const other of to) {
        const score = tokenSimilarity(token, other)
        if (score > best) best = score
      }
      sum += weight * best
    }
    return { sum, total }
  }

  // Symmetric: scoring only one direction would let a two-word name hide inside a
  // ten-word one and still score 1.0.
  const forward = directional(tokensA, tokensB)
  const backward = directional(tokensB, tokensA)
  const denominator = forward.total + backward.total
  return denominator === 0 ? 0 : (forward.sum + backward.sum) / denominator
}

// Token-aware similarity of two company names, run over already-normalised text.
// Distinctive words dominate; legal-form words are down-weighted.
export function companyNameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const tokensA = normalizeCompanyName(a).split(' ').filter(Boolean)
  const tokensB = normalizeCompanyName(b).split(' ').filter(Boolean)
  return alignmentScore(tokensA, tokensB, (token) => (GENERIC_TOKENS.has(token) ? GENERIC_TOKEN_WEIGHT : 1))
}

// Token-aware similarity of two free-text descriptions. No legal-form weighting —
// every word of a line-item description carries meaning.
export function descriptionSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return alignmentScore(tokenize(a), tokenize(b), () => 1)
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function relativeDifference(actual: number, expected: number): number {
  const base = Math.abs(expected)
  if (base === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(actual - expected) / base
}

// Tolerance has both a percentage and an absolute floor: 2% of a small invoice is
// tighter than any real AP team enforces.
export function toleranceFor(expected: number, pct: number, floor: number): number {
  return Math.max(Math.abs(expected) * pct, floor)
}

export function withinTolerance(actual: number, expected: number, pct: number, floor: number): boolean {
  return Math.abs(actual - expected) <= toleranceFor(expected, pct, floor)
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

// Population coefficient of variation — the dispersion measure the threshold-split
// rule uses to decide whether a set of amounts is suspiciously uniform.
export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = sum(values) / values.length
  if (mean === 0) return 0
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length
  return Math.sqrt(variance) / Math.abs(mean)
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

// Parsed as a UTC calendar date so the same invoice decides the same way in every
// timezone the app is opened in.
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (value == null) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim())
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const fallback = new Date(String(value))
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

// Whole days from `from` to `to`; negative when `to` is earlier.
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY)
}

export function toIsoDate(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Tax basis
// ---------------------------------------------------------------------------

/**
 * Factor that lifts an invoice's line amounts onto the same basis as its stated
 * total.
 *
 * A purchase order's `total_amount` is the amount AP is authorised to pay out, and
 * its line amounts sum to it — so the PO is wholly on a gross basis. An invoice
 * that presents tax separately states its lines net of that tax. Multiplying the
 * invoice's lines by total / (net basis) puts both documents in the same money
 * before any tolerance comparison, and the rate comes from the invoice itself
 * rather than being assumed.
 *
 * The net basis is the figure the lines were actually printed against, which is
 * not always the subtotal. A layout that carries a per-line tax column prints the
 * tax-inclusive figure alongside the taxable one, and a line read from that column
 * is already on the total's basis — scaling it by total / subtotal would charge the
 * tax a second time. So the basis is chosen by where the lines sit: the printed
 * subtotal when they sum nearer to it, their own sum when they sum nearer to the
 * total. A tie goes to the subtotal, and a document that prints no subtotal falls
 * back to the line sum as before. When neither is usable the factor is 1 and the
 * lines are already gross.
 *
 * Choosing by proximity rather than trusting the subtotal outright keeps the
 * property that made the subtotal the default: lines that fall short of the
 * subtotal because one of them was never read stay on the subtotal's basis, so the
 * shortfall surfaces as an unaccounted order line instead of being scaled away.
 */
export function grossFactor(
  total: number | null | undefined,
  subtotal: number | null | undefined,
  lineAmounts: readonly number[],
): number {
  if (!isFiniteNumber(total) || total === 0) return 1

  const lineSum = sum(lineAmounts.filter(isFiniteNumber))
  const subtotalUsable = isFiniteNumber(subtotal) && subtotal !== 0
  const linesAreGross = subtotalUsable && Math.abs(lineSum - total) < Math.abs(lineSum - subtotal)

  const netBasis = subtotalUsable && !linesAreGross ? subtotal : lineSum

  if (!isFiniteNumber(netBasis) || netBasis === 0) return 1

  const factor = total / netBasis
  // A factor below 1 would mean the stated total is less than the parts, which is
  // an arithmetic problem for its own check to report, not something to scale away.
  return factor > 0 ? factor : 1
}
