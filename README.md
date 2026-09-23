# Clearline

An accounts-payable decision engine: a vendor invoice goes in, a reasoned verdict
comes out — `AUTO_APPROVE`, `REVIEW`, `HOLD`, `BLOCK` or `ROUTED_NOT_PAID` — with
the evidence behind it. The product is called Clearline; `invoice-decision-engine`
is only the repository name.

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

## Screens

| Route | What it is |
|---|---|
| `/` | Exceptions. The list on the left, the selected invoice on the right. Choosing a row changes the pane, not the route; the selection lives in `?invoice=…&run=…`, keyed on the run because invoice numbers repeat. `j` and `k` move, `Enter` opens the document, `a` acts, `Esc` clears |
| `/invoices` | Every invoice, filterable by outcome, vendor and date, with sortable columns |
| `/vendors` | The approved vendor list, with status and when each was added |
| `/controls` | The thresholds, and the order the checks run in |
| `/process` | The seven stages, the principle, and what each outcome means |
| `/runs/:id` | The seven stages lighting up as they execute, over Supabase Realtime |
| `/decisions/:id` | The same detail pane as a full page, for linking to |
| `/vendors/new?from=:runId` | Onboarding a vendor an invoice was held for |
| `/harness` | The development harness. Not part of the product, and unchanged |

`/rules` and `/dashboard` still resolve, so older links land somewhere.

The detail pane has three tabs. **Decision** is the verdict, the disputed figures
side by side, and why. **Document** renders the page itself with `pdfjs-dist`,
beside what was read off it; if that fails it falls back to an `<iframe>`, and an
uploaded photograph is shown as an image. **History** is the trail, and the only
place in the product where a file hash, a row id or a storage key appears.

The command palette opens on the usual shortcut and jumps to any invoice by number
or vendor.

Every sentence a user reads about a verdict or a reason code comes from
`src/lib/reasonCopy.ts`. Nothing else carries phrasing for them. Colour is defined
once in `src/index.css` and only ever means a verdict. `tests/ui.spec.ts` enforces
both, along with the onboarding split and the rule that internal references stay
out of the way.

## Running it


```bash
npm install
npm run dev        # the product at /, the extraction harness at /harness
npm test           # the rules engine, offline — no network, no database
npm run build
npm run lint
```

Database setup: run `supabase/migrations/001…005` in order in the Supabase SQL
editor, then `007_storage.sql` (the bucket uploaded documents go to, PDFs and
photographs alike), `008_product_columns.sql` (three columns the screens need),
`009_discard.sql` (two more, for filing a duplicate away),
`010_vendor_history.sql` (when a vendor's details were changed, by whom, and the
change log behind it) and `011_override_names.sql` (clears an early placeholder
that made blocked invoices read as approved). 010 is required before a vendor can
be added or edited: the onboarding form writes columns it creates. The edge functions in
`supabase/functions/` are deployed by hand and read `GEMINI_API_KEY` /
`ANTHROPIC_API_KEY` from the function environment, so no key ever reaches the
browser.
