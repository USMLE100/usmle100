-- A viewing interrupted by a technical failure (player error or frozen playback) is closed without using a view
-- (owner, 2 Nov 2026). Additive only: existing rows keep failed_at NULL.
ALTER TABLE view_sessions ADD COLUMN failed_at INTEGER;
ALTER TABLE view_sessions ADD COLUMN failed_reason TEXT;
