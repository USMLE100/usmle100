-- Failed sign-in counters: one row per email ("email:...") and per network address ("ip:...").
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,   -- unix seconds of the first failure in the current 15-minute window
  locked_until INTEGER             -- unix seconds; sign-in refused until then
);

-- One-time password reset links made by an admin. Only a SHA-256 hash of the link's secret is stored.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,     -- unix seconds
  used_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX password_resets_user ON password_resets(user_id);
