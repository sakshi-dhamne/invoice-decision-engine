-- Clearline — discarding a duplicate
-- Paste into the Supabase SQL editor after 008_product_columns.sql.
--
-- A duplicate is the one exception a person cannot usefully act on. Asking the
-- vendor about it makes no sense, and approving it would pay the same invoice
-- twice, which is the thing the check exists to prevent. The only move is to take
-- it off the queue, and that has to be recorded rather than just hidden.
--
-- The run keeps its verdict and its reason code exactly as the rules left them.
-- Discarding is an additional fact about the run, not a rewrite of what was
-- decided: the trail still shows that we blocked a duplicate, and now also shows
-- who filed it away and when.
--
-- Idempotent: safe to re-run.

alter table runs add column if not exists discarded_at timestamptz;
alter table runs add column if not exists discarded_by text;

-- The queue reads this constantly, and a discarded run is the common case to
-- exclude once a mailbox has been forwarded twice.
create index if not exists idx_runs_discarded_at on runs (discarded_at);
