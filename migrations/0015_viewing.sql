-- Lecture viewing limits (R036-R071): free lectures, viewing sessions, one protected tab, extra views.
-- Videos are named by an item key: 'L:<lecture id>' (course lecture), 'E:<evening id>' (Evening Questions class),
-- 'F:<free_videos id>' (an entry in the owner's Free Lectures list).

-- The Free Lectures list. Each entry points at a course lecture, an Evening class, or another Bunny video.
-- Entries are never deleted: unpublishing removes free access at once and keeps everyone's view counts.
CREATE TABLE free_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,         -- 'L:12', 'E:5' or 'V:<bunny video id>'
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'educational' CHECK (category IN ('sample', 'evening', 'educational', 'info')),
  duration_seconds INTEGER,            -- only for 'V:' videos (others use their lecture's length)
  sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

-- One viewing session = at most one view. The 24-hour window starts when playback actually begins.
-- A view is used when 65% of the video's unique content is watched in the session, or when a started
-- session's 24 hours run out. kind: 'paid' (counted per enrollment: 5) or 'free' (2 per lecture, ever).
CREATE TABLE view_sessions (
  id TEXT PRIMARY KEY,                 -- random code, also shown in the watermark
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,                  -- 'L:12' for a paid lecture, 'F:3' for a free list entry
  kind TEXT NOT NULL CHECK (kind IN ('free', 'paid')),
  enrollment_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  expires_at INTEGER,
  last_beat_at INTEGER,
  duration REAL,
  watched_seconds INTEGER NOT NULL DEFAULT 0,
  seen TEXT NOT NULL DEFAULT '',       -- hex bitset: one bit per second of video watched in this session
  counted INTEGER NOT NULL DEFAULT 0,  -- 1 once this session has used a view
  counted_at INTEGER,
  counted_reason TEXT                  -- '65%' or 'expired'
);
CREATE INDEX view_sessions_user_item ON view_sessions(user_id, item, kind);

-- Where the student stopped, so playback resumes at the exact point (R065).
CREATE TABLE video_positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item)
);

-- One protected lecture tab per account (R060-R062). Released by End Lecture, closing the tab,
-- or two minutes without a signal from it.
CREATE TABLE play_tabs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tab TEXT NOT NULL,
  nonce TEXT NOT NULL,
  item TEXT NOT NULL,
  session_id TEXT,
  device_hash TEXT,
  ip TEXT,
  seen_at INTEGER NOT NULL
);

-- Extra views: only the owner grants them, with a reason (R044, R051).
CREATE TABLE view_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('free', 'paid')),
  enrollment_id INTEGER,
  extra INTEGER NOT NULL,
  reason TEXT NOT NULL,
  granted_by INTEGER REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Students ask for more views; admins review, the owner decides.
CREATE TABLE view_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER,
  outcome TEXT
);

-- Course Book reading sessions: the code is printed on every page of the reader (R007).
CREATE TABLE book_view_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT,
  used_at INTEGER
);
