-- Clearline — clearing an override that names nobody
-- Paste into the Supabase SQL editor after 010_vendor_history.sql. Apply by hand.
--
-- The first version of the override button recorded the string "Approved at this
-- workstation" instead of asking who was approving. The History tab read that back
-- as "Approved by: Approved at this workstation", including on invoices that were
-- blocked and stayed blocked, because the flag was set even though nothing had
-- been approved and nobody had been named.
--
-- The button has since required a name, so no new row can look like this. These
-- are the rows already carrying it. A placeholder is not an approver: there is no
-- person these runs can be traced to and no approval that can be asked about, so
-- the honest record is that nobody overrode them.
--
-- The verdict, the reason codes and the stage logs are untouched. What the rules
-- decided about these invoices stays exactly as it was.
--
-- Idempotent: safe to re-run, and it matches only that one exact string.

update runs
set touched_by_human = false,
    touched_by = null
where touched_by = 'Approved at this workstation';
