-- Clearline — deleting uploaded test documents, in one transaction
-- Paste into the Supabase SQL editor after 012_override_outcome.sql. Apply by hand.
--
-- Clearing out uploaded test data by hand in the SQL editor failed on a foreign
-- key, and the reason is worth writing down because the order is the whole problem.
--
-- The migrations declare four references into what is being deleted:
--
--   stage_logs.run_id  -> runs (id)      on delete cascade
--   extractions.invoice_id -> invoices (id)  on delete cascade
--   runs.invoice_id    -> invoices (id)  no action
--   runs.parent_run_id -> runs (id)      no action
--
-- The two without a cascade are the ones that have to be handled in order. A run
-- has to go before the invoice it decided. And `parent_run_id` is the trap: a
-- resubmission's run points at the run of the invoice it corrects, and that earlier
-- invoice is very often not one the person selected. Deleting the selected runs
-- while a surviving run still points at one of them is the failure that was hit.
--
-- So the link is detached first, for every run pointing into the set, whether or not
-- that run is being deleted itself. Detaching is a real loss, which is why the
-- screen names the surviving invoices before anybody confirms rather than after.
--
-- All of it runs in one transaction. A plpgsql function body is a single
-- transaction, and the handler at the bottom re-raises, which rolls the whole thing
-- back and names the step it stopped on. A half-deleted set is the one outcome
-- worse than not deleting.
--
-- Storage is not in here. Objects in the `invoices` bucket are not part of a
-- Postgres transaction, so the app removes them after this returns, and says so
-- separately when that part fails.
--
-- Idempotent: safe to re-run.

create or replace function delete_invoices_cascade(invoice_ids uuid[])
returns jsonb
language plpgsql
as $$
declare
  target_runs uuid[];
  seeded_count int;
  detached int := 0;
  stage_log_count int := 0;
  extraction_count int := 0;
  run_count int := 0;
  invoice_count int := 0;
  current_step text := 'reading the selection';
begin
  if invoice_ids is null or array_length(invoice_ids, 1) is null then
    return jsonb_build_object(
      'invoices', 0, 'runs', 0, 'stage_logs', 0, 'extractions', 0, 'detached_links', 0
    );
  end if;

  -- The test corpus is refused here as well as in the interface. The 27 seeded
  -- invoices are what the suite asserts against and what the demo runs on, and a
  -- guard that only exists in a React component is a guard anyone can walk past by
  -- calling this function directly. `storage_path` is set by the upload flow and by
  -- nothing else, which is the same test src/lib/maintenance.ts makes.
  current_step := 'checking the selection';
  select count(*) into seeded_count
    from invoices
   where id = any(invoice_ids)
     and (storage_path is null or btrim(storage_path) = '');

  if seeded_count > 0 then
    raise exception
      'Refusing to delete % seeded invoice(s). Only uploaded documents can be deleted.', seeded_count;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into target_runs
    from runs
   where invoice_id = any(invoice_ids);

  -- Counted before anything is removed, so the report says what actually went
  -- rather than what is left.
  select count(*) into stage_log_count from stage_logs where run_id = any(target_runs);
  select count(*) into extraction_count from extractions where invoice_id = any(invoice_ids);

  -- Step 1. Every run pointing at a run that is about to go, including the runs of
  -- invoices nobody selected. This is what stops the delete below failing.
  current_step := 'detaching the links to earlier attempts';
  update runs
     set parent_run_id = null
   where parent_run_id = any(target_runs);
  get diagnostics detached = row_count;

  -- Step 2. The runs. Stage logs cascade.
  current_step := 'deleting the runs';
  delete from runs where invoice_id = any(invoice_ids);
  get diagnostics run_count = row_count;

  -- Step 3. The invoices. Extractions cascade.
  current_step := 'deleting the invoices';
  delete from invoices where id = any(invoice_ids);
  get diagnostics invoice_count = row_count;

  return jsonb_build_object(
    'invoices', invoice_count,
    'runs', run_count,
    'stage_logs', stage_log_count,
    'extractions', extraction_count,
    'detached_links', detached
  );

exception
  when others then
    -- Re-raising from the handler rolls back every statement above, so the set is
    -- either entirely gone or entirely untouched. The step is in the message
    -- because "it failed" is not something a person can act on.
    raise exception 'Maintenance delete stopped while %: %', current_step, sqlerrm;
end;
$$;

-- The product runs on the anon key, which is the trust boundary every table in
-- 001_schema.sql is already on. A deployment with sign-in should grant this to an
-- authenticated role and revoke it here.
grant execute on function delete_invoices_cascade(uuid[]) to anon;
