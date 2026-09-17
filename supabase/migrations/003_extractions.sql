-- Invoice Decision Engine — extraction cache
-- Paste into the Supabase SQL editor after 001_schema.sql and 002_seed.sql.
--
-- Extraction is the expensive step (Gemini free tier: 5 RPM / 20 RPD), and an
-- invoice only needs extracting once. This table caches the result so the harness
-- doesn't burn the daily quota re-running extraction on every pass.
--
-- Kept as a separate table, not columns on `invoices`: `invoices` holds fixture
-- truth (including `expected_verdict`), while extraction output is runtime data —
-- an invoice can legitimately be re-extracted, and conflating the two would make
-- the harness's truth-vs-extraction comparison meaningless.
--
-- Re-extracting sets `is_current = false` on prior rows for that invoice and
-- inserts a new one, so history is preserved.

create table if not exists extractions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  extracted_data jsonb not null,
  model text not null,
  duration_ms int,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_extractions_invoice_current on extractions (invoice_id, is_current);

-- ============================================================================
-- Row-level security — same permissive anon policy as the rest of the schema
-- (see the note in 001_schema.sql: no auth in scope for this demo).
-- ============================================================================
alter table extractions enable row level security;

drop policy if exists "anon full access" on extractions;

create policy "anon full access" on extractions for all to anon using (true) with check (true);
