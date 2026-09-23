-- Clearline — the vendor record's own history
-- Paste into the Supabase SQL editor after 009_discard.sql. Apply by hand.
--
-- A vendor's bank account is the reference every future invoice from that vendor
-- is checked against. Changing it is both routine and the single highest-risk
-- action in the system: a vendor really does move banks, and a redirected payment
-- looks exactly like a vendor moving banks. The difference between the two is
-- entirely in who said so, how they were reached, and when. None of that was
-- recorded anywhere, so this adds the places to record it.
--
-- Nothing here changes a rule. The bank-detail check still compares the printed
-- account against `vendors.bank_account` exactly as before; this is the trail
-- beside it.
--
-- Idempotent: safe to re-run.

-- ============================================================================
-- vendors: who put this record here, and who last touched it
-- ============================================================================

-- Who added the vendor. `created_at` already says when.
alter table vendors add column if not exists added_by text;

-- When the record was last changed, and by whom. Null on a vendor nobody has
-- edited since it was created, which is not the same as "changed by nobody".
alter table vendors add column if not exists updated_at timestamptz;
alter table vendors add column if not exists updated_by text;

-- When the bank details were last confirmed out of band. `bank_confirmed_by`
-- (008_product_columns.sql) already holds who did it and how they did it; without
-- a date that note cannot be aged, and the whole value of an out-of-band check is
-- that it happened recently enough to still mean something.
alter table vendors add column if not exists bank_confirmed_at timestamptz;

-- When the account or IFSC last changed. Read directly by the decision screens:
-- an invoice arriving against a vendor whose account moved in the last thirty days
-- is the classic business email compromise shape, and the reviewer has to see that
-- at the moment they decide rather than by going and looking.
alter table vendors add column if not exists bank_changed_at timestamptz;

-- Existing vendors were confirmed when they were created, as far as anything here
-- knows. Backfilling from created_at is honest about that: it is the earliest date
-- the confirmation can have happened, and leaving it null would make every seeded
-- vendor look unconfirmed rather than confirmed long ago.
update vendors set bank_confirmed_at = created_at where bank_confirmed_at is null;

-- ============================================================================
-- vendor_changes: every edit, one row each
-- ============================================================================
--
-- One row per field changed, rather than one per save, so a change to the account
-- and a change to the address on the same save can be told apart and counted
-- differently. `kind` is what separates them: 'payment' is where the money goes,
-- 'identity' is everything else, and only a payment change carries a verification
-- note.
create table if not exists vendor_changes (
  id uuid primary key default gen_random_uuid(),
  vendor_id text not null references vendors (id) on delete cascade,
  kind text not null check (kind in ('created', 'identity', 'payment')),
  field text not null,
  old_value text,
  new_value text,
  changed_by text not null,
  -- Who confirmed the new account and how they were reached. Required by the
  -- application on a payment change; null on an identity edit, which needs no
  -- out-of-band confirmation.
  verification_note text,
  changed_at timestamptz not null default now()
);

create index if not exists idx_vendor_changes_vendor on vendor_changes (vendor_id, changed_at desc);

-- ============================================================================
-- Row-level security
--
-- Same permissive policy as every other table (see 001_schema.sql): this demo has
-- no authentication and the browser talks to Supabase with the anon key. A
-- deployment with sign-in would scope this per organisation.
-- ============================================================================
alter table vendor_changes enable row level security;

drop policy if exists "anon full access" on vendor_changes;
create policy "anon full access" on vendor_changes for all to anon using (true) with check (true);
