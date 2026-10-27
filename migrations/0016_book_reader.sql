-- Each Course Book reading session can fetch its chapter once.
ALTER TABLE book_view_sessions ADD COLUMN used_at INTEGER;
