-- Invoice Decision Engine — rules engine thresholds
-- Paste into the Supabase SQL editor after 004_fields_not_printed.sql.
--
-- Stages 3-7 read every threshold from the `rules` table at runtime; nothing in
-- src/rules/ carries a hardcoded operational number. 002_seed.sql seeds the ten
-- keys the brief names; the nine below are the remaining tunables the rules
-- engine needs, added here rather than edited into the seed so an already-seeded
-- project can adopt them without a full re-seed.
--
-- Idempotent: safe to re-run. Existing values are left alone, so an operator who
-- has already tuned a threshold does not get it reset by re-running this file.

insert into rules (key, value, unit, description)
values
  -- Stage 4 — PO matching
  ('po_weight_amount', 0.5, 'weight',
   'Weight of amount proximity when scoring an invoice against a candidate PO'),
  ('po_weight_description', 0.3, 'weight',
   'Weight of line-item description overlap when scoring an invoice against a candidate PO'),
  ('po_weight_date', 0.2, 'weight',
   'Weight of the invoice-date-after-PO-issue-date signal when scoring a candidate PO'),
  ('po_candidate_floor', 0.5, 'score',
   'Below this combined score a PO is not a credible candidate and is discarded before the ambiguity test'),
  ('po_date_window_days', 365, 'days',
   'Age at which the date signal decays to zero; an invoice this long after the PO issue date scores 0 on that signal'),

  -- Stage 5 — line items, arithmetic, duplicates, split detection
  ('line_match_threshold', 0.6, 'score',
   'Description similarity at which an invoice line is considered to map to a PO line'),
  ('arithmetic_tolerance', 1, 'INR',
   'Rounding allowance when checking subtotal + tax = total'),
  ('near_duplicate_amount_pct', 0.01, 'percent',
   'Total must be within this of a prior invoice from the same vendor to count as a near-duplicate'),
  ('split_pattern_cv_max', 0.05, 'ratio',
   'Coefficient of variation below which invoice amounts count as near-uniform for threshold-split detection')
on conflict (key) do nothing;

-- ============================================================================
-- assumptions recorded while building the rules engine
-- ============================================================================
insert into assumptions (text, category)
select v.text, v.category
from (values
  ('A purchase order''s total_amount is the amount AP is authorised to pay out, so invoice totals are compared to it gross-to-gross. tax_treatment describes whether the PO''s line prices already include tax, and drives the tax-basis normalisation of line items rather than the total comparison.',
   'tax'),
  ('An invoice that never cites a PO reference is held rather than reviewed: the PO is what authorises payment, and a PO inferred from amount and description is a suggestion for a human, not a match. Inference still runs, so the hold carries the candidate it found.',
   'matching'),
  ('Line-level reallocation inside a single PO is legitimate, so unit-price variance is tested on the net over-billing across all mapped lines rather than line by line. Under-billing a PO line (partial delivery) is never a price variance.',
   'matching'),
  ('An invoice line that maps to no PO line by description is acceptable when it is covered by PO value not already billed on this invoice — that is a roll-up or consolidation. It is flagged only when it bills beyond what the PO leaves unaccounted for.',
   'matching'),
  ('Near-duplicate detection looks only at invoices received on or before the one being decided. Looking forward would retroactively flag a clean invoice the moment a later copy arrived.',
   'matching'),
  ('A resubmission is classified on commercially material fields — amounts, currency, line items, bank account, payee, vendor, invoice number, document type. The document date, free-text notes and the file itself are expected to change on a resubmission; every field is still diffed and stored in runs.changed_fields for the audit trail.',
   'matching'),
  ('Vendor name normalisation expands Indian company-suffix forms (pvt, ltd, llp) alongside the common international ones. This is a deliberate domain fit, not a general-purpose company-name resolver.',
   'vendor'),
  ('Stage 7 phrasing is presentational. If the model call fails the run still completes with a deterministic reason-code summary, because no model output may change a verdict.',
   'explainability')
) as v(text, category)
where not exists (select 1 from assumptions a where a.text = v.text);
