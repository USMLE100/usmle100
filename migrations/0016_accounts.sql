-- Registration details, marketing consent, contact-change approvals, sign-in details and registered devices.
-- Name and email already exist; `exam` (onboarding) holds the exam the student is preparing for.
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN grad_year INTEGER;
ALTER TABLE users ADD COLUMN signup_source TEXT;
-- Optional marketing consent, never pre-ticked. The exact wording agreed to is kept with the time.
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN marketing_consent_at TEXT;
ALTER TABLE users ADD COLUMN marketing_consent_text TEXT;
-- Set once one-time-code verification is switched on (needs an email/SMS provider).
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;

-- What each sign-in was, for the student's login history and for spotting shared accounts.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN country TEXT;
ALTER TABLE sessions ADD COLUMN device_id TEXT;

-- Changing a verified email or phone needs an administrator (R016).
CREATE TABLE contact_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('email', 'phone')),
  new_value TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id)
);

-- Up to 2 registered devices per student (R001). A device is a long-lived random cookie in one browser.
-- A third device waits for an administrator to approve it as a replacement (R017).
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'removed', 'declined')),
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_country TEXT,
  replaces_id INTEGER,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  UNIQUE (user_id, device_hash)
);
CREATE INDEX devices_user ON devices(user_id, status);

-- Suspected sharing: the first one warns the student and alerts the owner; a repeat locks the account (R003/R004).
CREATE TABLE security_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  outcome TEXT
);
CREATE INDEX security_flags_user ON security_flags(user_id);

-- Messages to students, kept in the portal even when email/SMS can't be sent (notification history).
CREATE TABLE notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  email_status TEXT,
  sms_status TEXT
);
CREATE INDEX notices_user ON notices(user_id, created_at);

-- Alerts for the owner and admins (sharing, chargebacks, failures), shown on the admin Security page.
CREATE TABLE staff_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
  kind TEXT NOT NULL,
  user_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER
);

-- Data export and account deletion requests: reviewed by an administrator, decided by the owner (R: privacy).
CREATE TABLE privacy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'deletion')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  outcome TEXT
);
