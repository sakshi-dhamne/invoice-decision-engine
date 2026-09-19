-- Clearline — storage for uploaded invoices
-- Paste into the Supabase SQL editor and run top-to-bottom. Apply by hand; the
-- app never creates this bucket for itself.
--
-- Seeded fixture PDFs stay where they are, served from public/invoices. Anything a
-- person uploads through the product goes here instead, and the invoice row records
-- the object key in `storage_path`. src/lib/pipeline.ts resolves one or the other
-- from that column, so nothing downstream has to know which kind of document it is
-- looking at.
--
-- Public read is deliberate and is what the rest of the system already assumes: the
-- browser fetches the PDF to hash it, and the extract-invoice edge function fetches
-- it to read it. Neither presents a user's credentials. Treat a document in this
-- bucket as readable by anyone holding its URL, which is the same footing the
-- seeded fixtures are already on.
--
-- Idempotent: safe to re-run.

-- ============================================================================
-- The bucket
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', true)
on conflict (id) do update set public = true;

-- ============================================================================
-- Policies
-- ============================================================================
-- Anyone may read an object in this bucket. Without this the extraction cannot
-- fetch the document it has been asked to read.
drop policy if exists "invoices are publicly readable" on storage.objects;
create policy "invoices are publicly readable"
  on storage.objects for select
  to public
  using (bucket_id = 'invoices');

-- The product runs on the anon key, so uploading has to be permitted to anon.
-- This is the same trust boundary the tables are already on (001_schema.sql grants
-- anon full access to every one of them). A deployment with sign-in should replace
-- both with policies that name an authenticated role.
drop policy if exists "anon may upload an invoice" on storage.objects;
create policy "anon may upload an invoice"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'invoices');

-- Re-uploading the same key replaces the object rather than failing. The app
-- generates a fresh key per upload, so this only matters when a retry reuses one.
drop policy if exists "anon may replace an uploaded invoice" on storage.objects;
create policy "anon may replace an uploaded invoice"
  on storage.objects for update
  to anon
  using (bucket_id = 'invoices')
  with check (bucket_id = 'invoices');
