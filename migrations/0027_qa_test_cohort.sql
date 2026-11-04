-- Owner-approved production player test (4 Nov 2026): a private test cohort holding only the declined 5-minute Zoom test
-- recording. Only a student the owner gives a program in THIS cohort can see it; other students only see their own
-- cohort's lectures. Its Day 1 is before every real cohort, so new purchases (which join the latest or pinned cohort)
-- never land in it. Runs only on the production database and only if a declined recording exists. Nothing is deleted.
INSERT INTO cohorts (name, start_date)
SELECT 'QA test (owner only - not for students)', '2026-09-07'
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'db_environment' AND value = 'production')
  AND EXISTS (SELECT 1 FROM zoom_imports WHERE declined_at IS NOT NULL AND bunny_video_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM cohorts WHERE name = 'QA test (owner only - not for students)' OR start_date = '2026-09-07');
INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id)
SELECT c.id, 1, 'QA test lecture (owner test only)', 'live', (SELECT bunny_video_id FROM zoom_imports WHERE declined_at IS NOT NULL AND bunny_video_id IS NOT NULL ORDER BY id DESC LIMIT 1)
FROM cohorts c
WHERE c.name = 'QA test (owner only - not for students)'
  AND NOT EXISTS (SELECT 1 FROM lectures l WHERE l.cohort_id = c.id);
