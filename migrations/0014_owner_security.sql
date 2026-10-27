-- Phase 1 security foundations: owner role, account status, short sessions, permanent lockouts,
-- a tamper-evident security log, the content-protection agreement and an emergency lockdown switch.

-- The owner is an admin with final authority (admin creation, prices, enrollment and access changes,
-- reinstatement, lockdown). The first admin account becomes the owner if none is set.
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin') AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1);

-- active | warned (shown a red warning until acknowledged) | suspended (blocked until the owner reinstates).
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN status_reason TEXT;
ALTER TABLE users ADD COLUMN status_at TEXT;
ALTER TABLE users ADD COLUMN warnings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN birth_date TEXT;

-- Sessions end after 30 minutes without activity and 24 hours after sign-in (epoch seconds).
ALTER TABLE sessions ADD COLUMN created_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
ALTER TABLE sessions ADD COLUMN ip TEXT;
UPDATE sessions SET created_at = CAST(strftime('%s', 'now') AS INTEGER), last_seen_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE created_at IS NULL;

-- After 5 failed passwords an account stays locked until an administrator unlocks it.
CREATE TABLE account_locks (
  email TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  unlocked_at TEXT,
  unlocked_by INTEGER REFERENCES users(id)
);

-- Security and administration log. Each row carries the hash of the one before it, so edits or
-- deletions in the middle are detectable. Kept 24 months.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  detail TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_log_target ON audit_log(target_user_id);
CREATE INDEX audit_log_action ON audit_log(action);

-- Content-protection agreement: versions published by the owner, signatures by students.
CREATE TABLE agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  material INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_by INTEGER REFERENCES users(id)
);
CREATE TABLE agreement_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agreement_id INTEGER NOT NULL REFERENCES agreements(id),
  legal_name TEXT NOT NULL,
  email TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT,
  UNIQUE (user_id, agreement_id)
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('lockdown', '0');
