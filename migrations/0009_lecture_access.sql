-- Lecture recordings stay available until 60 days after the cohort's last day (Day 100).
-- An admin can move a single student's end date with lectures_until.
ALTER TABLE enrollments ADD COLUMN lectures_until TEXT;
