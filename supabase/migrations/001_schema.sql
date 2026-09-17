-- Invoice Decision Engine — schema
-- Paste into the Supabase SQL editor and run top-to-bottom in a fresh project.

-- ============================================================================
-- vendors
-- ============================================================================
create table if not exists vendors (
  id text primary key,
  legal_name text not null,
  aliases text[],
  bank_account text,
  bank_ifsc text,
  gstin text,
  address text,
  email_domain text,
  status text not null check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- purchase_orders
-- ============================================================================
create table if not exists purchase_orders (
  po_number text primary key,
  vendor_id text references vendors (id),
  total_amount numeric(14, 2),
  currency text not null default 'INR',
  amount_billed_to_date numeric(14, 2) not null default 0,
  tax_treatment text check (tax_treatment in ('inclusive', 'exclusive')),
  status text check (status in ('open', 'closed', 'cancelled')),
  line_items jsonb,
  delivery_schedule jsonb,
  issued_date date,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- invoices
-- ============================================================================
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null,
  file_path text,
  file_hash text,
  vendor_name_as_printed text,
  vendor_id text references vendors (id),
  po_reference text,
  invoice_date date,
  currency text,
  subtotal numeric(14, 2),
  tax numeric(14, 2),
  total numeric(14, 2),
  bank_account_printed text,
  remit_to_name text,
  document_type text not null default 'invoice' check (document_type in ('invoice', 'credit_note')),
  line_items jsonb,
  extraction_confidence jsonb,
  parent_invoice_number text,
  notes_field text,
  expected_verdict text,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_invoice_number on invoices (invoice_number);
create index if not exists idx_invoices_file_hash on invoices (file_hash);
create index if not exists idx_invoices_vendor_total_date on invoices (vendor_id, total, invoice_date);

-- ============================================================================
-- runs
-- ============================================================================
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices (id),
  status text check (status in ('running', 'complete', 'failed')),
  verdict text check (verdict in ('AUTO_APPROVE', 'REVIEW', 'HOLD', 'BLOCK', 'ROUTED_NOT_PAID')),
  reason_codes text[],
  parent_run_id uuid references runs (id),
  changed_fields jsonb,
  matched_po text,
  explanation text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  touched_by_human boolean not null default false
);

create index if not exists idx_runs_verdict on runs (verdict);
create index if not exists idx_runs_started_at on runs (started_at desc);

-- ============================================================================
-- stage_logs
-- ============================================================================
create table if not exists stage_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  stage text not null,
  stage_order int not null,
  status text check (status in ('pending', 'running', 'passed', 'flagged', 'failed')),
  input jsonb,
  output jsonb,
  reasoning text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists idx_stage_logs_run_order on stage_logs (run_id, stage_order);

-- ============================================================================
-- rules
-- ============================================================================
create table if not exists rules (
  key text primary key,
  value numeric,
  unit text,
  description text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- assumptions
-- ============================================================================
create table if not exists assumptions (
  id serial primary key,
  text text,
  category text,
  made_on date not null default current_date
);

-- ============================================================================
-- Row-level security
--
-- This is a demo with no authentication — the app talks to Supabase directly
-- from the browser using the anon key, so every table gets a permissive
-- policy granting the anon role full read/write access. A production
-- deployment would add auth and scope these policies per organisation
-- instead of leaving them wide open.
-- ============================================================================
alter table vendors enable row level security;
alter table purchase_orders enable row level security;
alter table invoices enable row level security;
alter table runs enable row level security;
alter table stage_logs enable row level security;
alter table rules enable row level security;
alter table assumptions enable row level security;

drop policy if exists "anon full access" on vendors;
drop policy if exists "anon full access" on purchase_orders;
drop policy if exists "anon full access" on invoices;
drop policy if exists "anon full access" on runs;
drop policy if exists "anon full access" on stage_logs;
drop policy if exists "anon full access" on rules;
drop policy if exists "anon full access" on assumptions;

create policy "anon full access" on vendors for all to anon using (true) with check (true);
create policy "anon full access" on purchase_orders for all to anon using (true) with check (true);
create policy "anon full access" on invoices for all to anon using (true) with check (true);
create policy "anon full access" on runs for all to anon using (true) with check (true);
create policy "anon full access" on stage_logs for all to anon using (true) with check (true);
create policy "anon full access" on rules for all to anon using (true) with check (true);
create policy "anon full access" on assumptions for all to anon using (true) with check (true);

-- ============================================================================
-- Realtime — live run view subscribes to stage_logs and runs
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stage_logs'
  ) then
    alter publication supabase_realtime add table stage_logs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'runs'
  ) then
    alter publication supabase_realtime add table runs;
  end if;
end $$;

-- Replica identity full so realtime UPDATE/DELETE payloads include old row
-- values (not just the primary key), which the live run view needs to diff.
alter table stage_logs replica identity full;
alter table runs replica identity full;
