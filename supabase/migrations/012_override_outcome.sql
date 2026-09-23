-- Clearline — an override is an outcome, and it happened at a time
-- Paste into the Supabase SQL editor after 011_override_names.sql. Apply by hand.
--
-- Approving an invoice the rules stopped recorded who did it and then changed
-- nothing else: the invoice went on reading Held and went on sitting in the
-- exceptions queue. An approval that leaves the thing it approved in the queue is
-- not an approval, it is a note.
--
-- What the rules decided is still what the rules decided, so `verdict` and
-- `reason_codes` are left exactly as they were. That record is what the whole
-- system is for, and rewriting it would mean nobody could ever see what was caught
-- and overruled. The outcome a person sees is derived from the two together:
-- src/lib/feed.ts computes the effective verdict, which is approved once a person
-- has approved it, and the screens say who did rather than implying the rules did.
--
-- This adds the missing half of the record: when.
--
-- Idempotent: safe to re-run.

alter table runs add column if not exists approved_at timestamptz;

-- Deliberately not backfilled. Rows overridden before this column existed have no
-- recorded time and inventing one, from `finished_at` or anything else, would put a
-- timestamp on the record that nobody can stand behind. The screens read a missing
-- time as missing and say so.

-- The Invoices page filters on this to list every human approval in one place.
create index if not exists idx_runs_approved_at on runs (approved_at);
