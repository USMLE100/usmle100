-- Zoom cloud recordings copied into Bunny Stream automatically.
CREATE TABLE zoom_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zoom_file_id TEXT NOT NULL UNIQUE,
  meeting_id TEXT,
  topic TEXT,
  start_time TEXT,
  share_url TEXT,
  lecture_id INTEGER REFERENCES lectures(id) ON DELETE SET NULL,
  bunny_video_id TEXT,
  auto_live INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'fetching' CHECK (status IN ('fetching', 'processing', 'ready', 'failed')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('zoom_meeting_ids', '');
