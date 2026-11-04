-- Retire the private player-test cohort after the owner's test (nothing is deleted): its lecture is hidden and its
-- recording detached, test enrollments are cancelled, and the cohort is renamed so it is clearly retired.
UPDATE lectures SET status = 'processing', bunny_video_id = NULL WHERE cohort_id IN (SELECT id FROM cohorts WHERE name = 'QA test (owner only - not for students)');
UPDATE enrollments SET status = 'cancelled' WHERE status = 'active' AND cohort_id IN (SELECT id FROM cohorts WHERE name = 'QA test (owner only - not for students)');
DELETE FROM play_tabs WHERE item IN (SELECT 'L:' || l.id FROM lectures l JOIN cohorts c ON c.id = l.cohort_id WHERE c.name = 'QA test (owner only - not for students)');
UPDATE cohorts SET name = 'QA test (retired)' WHERE name = 'QA test (owner only - not for students)';
