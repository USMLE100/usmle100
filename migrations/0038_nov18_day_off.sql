-- Owner, 23 Nov 2026: no class on Wed 18 Nov 2026 (weather). Mark it a day off for the November cohort and move the
-- lectures recorded after it back one day number (Day 9 → 8, 10 → 9, 11 → 10), so every lecture keeps its real date.
-- Runs only if 18 Nov isn't a day off yet, Day 8 has no lecture and Day 9 does. Nothing is deleted.
UPDATE lectures SET day_number = -(day_number - 1)
 WHERE day_number >= 9
   AND cohort_id IN (
     SELECT c.id FROM cohorts c WHERE c.start_date = '2026-11-09'
       AND NOT EXISTS (SELECT 1 FROM cohort_days_off o WHERE o.cohort_id = c.id AND o.date = '2026-11-18')
       AND NOT EXISTS (SELECT 1 FROM lectures l WHERE l.cohort_id = c.id AND l.day_number = 8)
       AND EXISTS (SELECT 1 FROM lectures l WHERE l.cohort_id = c.id AND l.day_number = 9));
UPDATE lectures SET day_number = -day_number WHERE day_number < 0;
INSERT INTO cohort_days_off (cohort_id, date, label)
SELECT c.id, '2026-11-18', 'No class (weather)' FROM cohorts c WHERE c.start_date = '2026-11-09'
ON CONFLICT (cohort_id, date) DO NOTHING;
