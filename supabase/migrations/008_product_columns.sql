-- Clearline — the three columns the product screens need
-- Paste into the Supabase SQL editor after 007_storage.sql.
--
-- Numbered after the storage migration rather than before it because the working
-- copy of this repository holds migrations 001 to 005, and whatever 006 contains
-- lives only in the deployed project. Taking 008 leaves that alone.
--
-- Idempotent: safe to re-run, and safe to run against a project where some of
-- these already exist.

-- Where an uploaded PDF lives in the invoices bucket. Null for the seeded corpus,
-- which is served from public/invoices. pdfUrlFor() in src/lib/pipeline.ts reads
-- this column to decide which of the two to fetch.
alter table invoices add column if not exists storage_path text;

-- Who overrode a verdict, on the runs where somebody did. `touched_by_human`
-- already records that it happened; this records who, so the override is a name in
-- the trail rather than an anonymous flag.
alter table runs add column if not exists touched_by text;

-- Who confirmed a new vendor's bank details, and how they confirmed them.
--
-- Collected on the onboarding form beside the account number and the IFSC, and
-- required alongside them. The account number on file is the reference the
-- bank-detail check compares every future invoice against, so how it got there is
-- part of the record: an account nobody can say they verified is an account nobody
-- verified.
alter table vendors add column if not exists bank_confirmed_by text;
