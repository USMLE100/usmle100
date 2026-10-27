-- Appeals of account restrictions and disputes of used lecture views (owner decisions on appeals,
-- view-credit disputes and compensation). An administrator reviews and recommends; the owner decides.
CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('appeal', 'view-dispute')),
  item TEXT,                         -- the video, for a view dispute
  statement TEXT NOT NULL,
  exam_date TEXT,                    -- for an expedited view dispute (exam within 48 hours)
  expedite_requested INTEGER NOT NULL DEFAULT 0,
  expedite_verified_at TEXT,
  new_evidence INTEGER NOT NULL DEFAULT 0,  -- a reopened appeal with material new evidence (3 business days)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'decided')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT NOT NULL,              -- decision target (view disputes) or next student update (appeals)
  last_update_at TEXT,
  escalated_at TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  recommendation TEXT CHECK (recommendation IN ('grant', 'deny')),
  review_note TEXT,
  reviewed_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  decision TEXT CHECK (decision IN ('granted', 'denied')),
  decision_reason TEXT,
  decided_at TEXT
);
CREATE INDEX cases_user ON cases(user_id);
CREATE INDEX cases_open ON cases(status, due_at);

CREATE TABLE case_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  to_student INTEGER NOT NULL DEFAULT 1,   -- 0 = internal staff note
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Exact compensation for a wrongful restriction: each enrollment is extended once per case.
CREATE TABLE compensations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL,
  restricted_seconds INTEGER NOT NULL,
  old_until TEXT,
  new_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (case_id, enrollment_id)
);

-- A view restored by a decided dispute is recorded against that case, so it can't be given twice.
ALTER TABLE view_grants ADD COLUMN case_id INTEGER;
CREATE UNIQUE INDEX view_grants_case ON view_grants(case_id) WHERE case_id IS NOT NULL;
