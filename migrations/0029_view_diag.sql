-- What the page heard from Bunny's player during a viewing (flags and counts only, no personal data), kept on the
-- viewing itself so a failed progress count can be diagnosed in production. Saved in the same write as each
-- check-in, so it costs no extra database writes.
ALTER TABLE view_sessions ADD COLUMN diag TEXT;
