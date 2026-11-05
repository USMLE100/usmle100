-- Owner, 5 Nov 2026: the November cohort starts on Monday 9 November 2026 (was 2 November).
-- Enrollments stay linked to the same cohort; days off and lectures stay editable as before.
-- Recordings Zoom imported into that cohort before 9 November were tests: their lecture entries move to the owner-only
-- QA cohort (nothing deleted, videos kept), so students never see them in their schedule or lecture list.
-- Matches only that cohort's exact old date; anywhere else this changes nothing.
UPDATE lectures SET cohort_id = (SELECT id FROM cohorts WHERE name LIKE 'QA test%' ORDER BY id LIMIT 1), day_number = 1000 + id
  WHERE cohort_id IN (SELECT id FROM cohorts WHERE start_date = '2026-11-02' AND name NOT LIKE 'QA test%')
    AND id IN (SELECT lecture_id FROM zoom_imports WHERE lecture_id IS NOT NULL AND substr(start_time, 1, 10) < '2026-11-09')
    AND EXISTS (SELECT 1 FROM cohorts WHERE name LIKE 'QA test%');
UPDATE cohorts SET start_date = '2026-11-09' WHERE start_date = '2026-11-02' AND name NOT LIKE 'QA test%';
