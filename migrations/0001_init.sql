-- USMLE100 core schema

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'faculty', 'admin')),
  exam_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A cohort is one 100-day run: 90 days of lectures, then a 10-day exam window.
CREATE TABLE cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,            -- YYYY-MM-DD, Day 1
  lecture_days INTEGER NOT NULL DEFAULT 90,
  total_days INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,                 -- 'refresher', 'companion', 'complete', 'max'
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  one_on_one_sessions INTEGER NOT NULL DEFAULT 0,
  evening_q_months INTEGER NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES packages(id),
  cohort_id INTEGER REFERENCES cohorts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'refunded', 'cancelled')),
  stripe_session_id TEXT UNIQUE,
  amount_cents INTEGER,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX enrollments_user ON enrollments(user_id);

-- Taxonomy (Dr. Khan's review, 13 Oct 2026). Builder filters use subjects + systems;
-- the performance page reports by perf_systems + disciplines.
CREATE TABLE subjects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL);
CREATE TABLE systems (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL,
  suggested_perf_system_id INTEGER);
CREATE TABLE perf_systems (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL);
CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL);
-- Suggested discipline for a subject. Suggestions only: a person approves every question's tags.
CREATE TABLE subject_discipline_suggestions (
  subject_id INTEGER PRIMARY KEY REFERENCES subjects(id),
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id)
);

CREATE TABLE lectures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  day_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  zoom_url TEXT,
  bunny_video_id TEXT,
  subject_id INTEGER REFERENCES subjects(id),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'live')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cohort_id, day_number)
);

CREATE TABLE lecture_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lecture_id)
);

-- Questions are faculty-written. Only 'approved' questions reach students.
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stem TEXT NOT NULL,
  choices_json TEXT NOT NULL,          -- ["choice A", "choice B", ...]
  correct_index INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  wrong_explanations_json TEXT,        -- {"0": "...", "2": "..."}
  bottom_line TEXT,
  image_url TEXT,
  subject_id INTEGER REFERENCES subjects(id),
  system_id INTEGER REFERENCES systems(id),
  perf_system_id INTEGER REFERENCES perf_systems(id),
  discipline_id INTEGER REFERENCES disciplines(id),
  lecture_id INTEGER REFERENCES lectures(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  author_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX questions_status ON questions(status);

CREATE TABLE tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('tutor', 'timed', 'untimed', 'warmup')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE test_items (
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  chosen_index INTEGER,                -- NULL = omitted
  is_correct INTEGER,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT,
  PRIMARY KEY (test_id, position)
);
CREATE INDEX test_items_question ON test_items(question_id);
