-- Phase 2 of the V12 restoration: topics and sections, Path/Workbench, Course Book, flash cards, notes,
-- discussion, rewards, onboarding, home FAQ and study strategy, and question timing.

-- Lecture sections (V12 "High-Yield Topics"): a subject's lectures grouped under a heading.
CREATE TABLE sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER REFERENCES subjects(id),
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE lectures ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL;
-- Video length, filled from Bunny (or typed by an admin when Bunny has no length).
ALTER TABLE lectures ADD COLUMN duration_seconds INTEGER;
-- "By the end of this lecture you should be able to…", one objective per line.
ALTER TABLE lectures ADD COLUMN objectives TEXT;
ALTER TABLE evening_sessions ADD COLUMN duration_seconds INTEGER;

CREATE TABLE lecture_bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lecture_id)
);

-- Workbench: the student's own queue of lectures for a study session.
CREATE TABLE workbench_items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, lecture_id)
);

-- Evening Questions recordings a student has watched (Night Scholar and Question Warrior badges).
CREATE TABLE evening_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES evening_sessions(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, session_id)
);

-- Flash cards are written by faculty (not generated). Each can point to the lecture it comes from.
CREATE TABLE flashcards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  lecture_id INTEGER REFERENCES lectures(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'retired')),
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each student's schedule for each card (Leitner boxes).
CREATE TABLE flashcard_reviews (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  box INTEGER NOT NULL DEFAULT 0,
  due_on TEXT NOT NULL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX flashcard_reviews_due ON flashcard_reviews(user_id, due_on);
CREATE TABLE flashcard_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX flashcard_log_user ON flashcard_log(user_id);

-- Uploaded files (Course Book PDFs, notes), stored in the database in pieces under 2 MB.
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE file_chunks (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- USMLE100 Course Book.
CREATE TABLE book_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  description TEXT,
  summary TEXT,
  topics TEXT,
  author TEXT,
  pages INTEGER,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE book_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES book_chapters(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, chapter_id)
);
-- Course Book given by hand (the $199 Course Book on its own). Companion, Complete and MAX include it.
CREATE TABLE book_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Written notes. A student's notes are private. Notes written by faculty are shared with every student.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  subject_id INTEGER REFERENCES subjects(id),
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  is_faculty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX notes_user ON notes(user_id);

-- Ask the Room. Discussion threads are visible to the class; feedback goes only to staff.
CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'discussion' CHECK (kind IN ('discussion', 'feedback')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX replies_thread ON replies(thread_id);
CREATE TABLE thread_votes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, thread_id)
);

-- One-on-one sessions held, recorded by an admin (shown to the student and used for badges).
CREATE TABLE tutoring_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  held_on TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 60,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Missed days covered by a streak freeze.
CREATE TABLE streak_freezes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day)
);

-- Onboarding answers.
ALTER TABLE users ADD COLUMN exam TEXT;
ALTER TABLE users ADD COLUMN onboarded_at TEXT;
CREATE TABLE user_focus_subjects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (user_id, subject_id)
);

-- Home page: Study Strategy articles and FAQ, edited by an admin.
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kicker TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('draft', 'live'))
);
INSERT INTO faqs (question, answer, sort) VALUES
 ('What is USMLE100?', 'USMLE100 is live board review taught by doctors. Each program runs for 100 days: 90 weekday lecture days, then a 10-weekday exam window, with lecture recordings, a question bank and one-on-one tutoring in the larger packages.', 1),
 ('How does the 90-day study schedule work?', 'There is a live lecture every weekday, Monday to Friday, for 90 class days. Holidays are skipped and the schedule moves forward. Every lecture is recorded, so you can catch up on a day you miss. After Day 90 comes a 10-weekday exam window with a group practice test.', 2),
 ('Which preparation packages are available?', 'Refresher ($1,500), Companion ($1,999, adds 4 months of Evening Questions and the Course Book), Complete ($2,449, adds 10 one-on-one sessions) and MAX ($3,799, adds 40 one-on-one sessions). Every package is a one-time payment.', 3),
 ('How many 1-on-1 tutoring sessions are included?', 'Complete includes 10 and MAX includes 40 private sessions, each 60 minutes. Extra sessions are $50 each.', 4),
 ('What is included in Evening Questions?', 'Live, instructor-guided USMLE-style question sessions on Monday, Wednesday and Friday evenings. Each month covers the next 12 evening classes from your start date, and you can rewatch them until 2 days after the 12th recording goes up. Companion, Complete and MAX include 4 months. On its own it is $160 per month.', 5),
 ('How long can I watch the lecture recordings?', 'Until 60 days after the last day of your program (Day 100).', 6),
 ('How can I contact Dr. Haider Khan and the USMLE100 team?', 'Use Contact in the menu to email the team, or post your question in Ask the Room.', 7);

-- Time spent on each answer, in seconds (Performance: seconds per question).
ALTER TABLE test_items ADD COLUMN seconds INTEGER;

INSERT OR IGNORE INTO settings (key, value) VALUES ('terms_text', ''), ('privacy_text', ''), ('blog_url', '');
