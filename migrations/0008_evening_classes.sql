-- Evening Questions months are counted in classes, not days: one month = the next 12 evening classes
-- from the start date, watchable until 2 days after the 12th recording goes live.
ALTER TABLE evening_sessions ADD COLUMN live_at TEXT;
UPDATE evening_sessions SET live_at = datetime('now') WHERE status = 'live';

CREATE TABLE evening_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX evening_subscriptions_user ON evening_subscriptions(user_id);

INSERT INTO evening_subscriptions (user_id, start_date, months, note)
  SELECT user_id, MIN(start_date), COUNT(*), MAX(note) FROM evening_periods GROUP BY user_id;

DROP TABLE evening_periods;
