-- Invoice Decision Engine — fields the source document never printed
-- Paste into the Supabase SQL editor after 003_extractions.sql.
--
-- Layout "b" invoices state a single tax-inclusive total with no separate
-- subtotal/tax line ("All applicable taxes are included in the amounts shown
-- above" — see templates/layout-b.html). The extraction prompt forbids deriving
-- subtotal/tax from the total, so a correct extraction returns null for both.
-- The invoices table still carries the accounting-truth subtotal/tax (for the
-- rules engine and for display), but the harness must not score that correct
-- null as a mismatch against a value the document never printed.
--
-- fields_not_printed names, per invoice, which extracted fields have no
-- print source on the document — the harness scores a null there as a correct
-- abstention, and a non-null value there as a mismatch (the model derived
-- something it was told not to).
--
-- Idempotent: safe to re-run. scripts/generate-seed.ts also emits this column
-- (derived from each fixture's `template`) so a regenerated 002_seed.sql keeps
-- it populated without depending on this migration having run first.

alter table invoices add column if not exists fields_not_printed text[];

update invoices
set fields_not_printed = array['subtotal', 'tax']::text[]
where invoice_number in (
  'INV-NCS-2150',
  'INV-HSL-8890',
  'INV-NCS-2201',
  'INV-NCS-2218',
  'INV-NCS-2237',
  'INV-ACM-5533'
)
and (fields_not_printed is null or fields_not_printed <> array['subtotal', 'tax']::text[]);
