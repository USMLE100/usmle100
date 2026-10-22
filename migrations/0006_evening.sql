-- Evening Questions: Mon/Wed/Fri evening class recordings, separate from the 90 lectures and behind their own access.
CREATE TABLE evening_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  zoom_url TEXT,
  bunny_video_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'live')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Access given by hand (e.g. the $160/month Evening Questions on its own), until a date.
CREATE TABLE evening_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE zoom_imports ADD COLUMN evening_session_id INTEGER REFERENCES evening_sessions(id) ON DELETE SET NULL;

INSERT OR IGNORE INTO settings (key, value) VALUES ('zoom_evening_meeting_ids', '84483124634');

-- The evening class ID was briefly suggested for lectures; it belongs to Evening Questions.
UPDATE settings SET value = '' WHERE key = 'zoom_meeting_ids' AND value = '84483124634';
