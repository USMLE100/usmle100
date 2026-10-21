-- Holidays and other days with no class, per cohort. They are skipped like weekends.
CREATE TABLE cohort_days_off (
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                   -- YYYY-MM-DD
  label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (cohort_id, date)
);

-- Fall 2026 cohort (starts 2 Nov 2026): Thanksgiving, Christmas Eve, Christmas Day.
INSERT INTO cohort_days_off (cohort_id, date, label)
SELECT id, '2026-11-26', 'Thanksgiving' FROM cohorts WHERE start_date = '2026-11-02';
INSERT INTO cohort_days_off (cohort_id, date, label)
SELECT id, '2026-12-24', 'Christmas Eve' FROM cohorts WHERE start_date = '2026-11-02';
INSERT INTO cohort_days_off (cohort_id, date, label)
SELECT id, '2026-12-25', 'Christmas Day' FROM cohorts WHERE start_date = '2026-11-02';
