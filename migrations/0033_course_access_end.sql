-- Owner, 5 Nov 2026: paid course access (lectures, Qbank, materials) ends together on Day 160
-- (60 days after Day 100) or the date the owner set. Programs whose date had already passed when this rule
-- started keep working exactly as before and are listed for the owner to review (set once by the site itself).
ALTER TABLE enrollments ADD COLUMN expiry_exempt INTEGER NOT NULL DEFAULT 0;
