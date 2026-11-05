-- Owner, 5 Nov 2026: the 100-Day Course and Evening Questions are granted and removed separately.
-- Columns only; nobody's current access changes.
-- Optional last day of Evening Questions for a student (NULL = no end date beyond their months).
ALTER TABLE users ADD COLUMN evening_until TEXT;
-- Set when the owner removes Evening Questions from a student whose program included months of it.
ALTER TABLE enrollments ADD COLUMN evening_removed_at TEXT;
