-- Evening Questions access is sold by the month: each month is its own 32-day window, and a student
-- sees only the recordings made inside their current window. Replaces the single "until" date.
CREATE TABLE evening_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX evening_periods_user ON evening_periods(user_id, start_date);

INSERT INTO evening_periods (user_id, start_date, end_date, note)
  SELECT user_id, date(until_date, '-31 days'), until_date, note FROM evening_access;

DROP TABLE evening_access;
