# invoice-decision-engine

An accounts-payable decision engine: a vendor invoice goes in, a reasoned verdict
comes out — `AUTO_APPROVE`, `REVIEW`, `HOLD`, `BLOCK` or `ROUTED_NOT_PAID` — with
the evidence behind it.

**The model extracts and phrases. Deterministic code decides.** A model reads the
PDF (stage 2) and, once a verdict is settled, turns it into a sentence (stage 7).
Everything in between is pure TypeScript over extracted data and database records.
No model output can change an outcome, and a failed phrasing call never fails a run.

## Pipeline

| Stage | Module | What it does |
|---|---|---|
| 1 ingest | `src/lib/pipeline.ts` | Locates the document, records its content hash |
| 2 extract | `src/lib/extraction.ts` | Reads through the extraction cache; a cached result is not a model call |
| 3 resolve vendor | `src/rules/vendor.ts` | Normalise, then fuzzy-match the printed name against the master and its aliases |
| 4 match PO | `src/rules/poMatch.ts` | Explicit reference short-circuits; otherwise amount, description and date signals, never guessing between close candidates |
| 5 validate | `src/rules/validate.ts` | Every check, each a pure function returning `{ passed, code?, evidence? }` |
| 6 decide | `src/rules/decide.ts` | The 23-row rules table, first match wins, all matching codes collected |
| 7 explain | `supabase/functions/explain-decision/` | One plain-English paragraph; presentational only |

Everything under `src/rules/` is pure — inputs in, result out, no I/O and no clock.
`src/lib/pipeline.ts` does all the fetching and writing, and writes a `stage_logs`
row per stage with input, output, reasoning and duration. That split is what lets
the engine be tested with no network.

## Generality

The 27 fixtures are test data, not inputs to the logic. Nothing in `src/rules/`,
`src/lib/pipeline.ts` or the edge functions branches on an invoice number, vendor,
purchase order or any other corpus-specific string, and `tests/generality.spec.ts`
enforces that by scanning the source with comments stripped. It also pushes an
invoice from a company that appears in no fixture through the same pipeline and
asserts it auto-approves, then flips to `BLOCK` on a mutated bank account.

Two places the logic is deliberately fitted to the domain, both documented in code:

- **Company-suffix expansion** (`src/rules/normalize.ts`) leans Indian — `pvt`,
  `ltd`, `llp` — alongside the common international forms. A general-purpose
  resolver would need a much larger table and a jurisdiction hint.
- **A purchase order's `total_amount` is read as the gross payable amount**, so
  invoice totals are compared to it gross-to-gross. `tax_treatment` drives the
  tax-basis normalisation of line items instead. The rate is derived from the
  invoice's own subtotal/total rather than assumed.

## Thresholds

Every operational number is a row in the `rules` table, read at runtime; a missing
one throws rather than defaulting. `002_seed.sql` seeds ten,
`005_rules_engine.sql` adds nine more (PO scoring weights and floor, line-match
threshold, arithmetic allowance, near-duplicate amount band, split-pattern
uniformity ceiling).

## Running it


```bash
npm install
npm run dev        # /harness runs extraction and the pipeline over all 27 fixtures
npm test           # the rules engine, offline — no network, no database
npm run build
npm run lint
```

Database setup: run `supabase/migrations/001…005` in order in the Supabase SQL
editor. The edge functions in `supabase/functions/` are deployed by hand and read
`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` from the function environment, so no key
ever reaches the browser.
