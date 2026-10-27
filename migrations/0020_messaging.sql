-- One-time codes for email/phone verification, sign-in checks and password recovery (R015, R091, R093).
-- Only a hash of each code is stored; codes expire after 10 minutes and allow 5 tries.
CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  purpose TEXT NOT NULL,
  target TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX otp_codes_user ON otp_codes(user_id, purpose, channel);

-- Delivery tracking for messages to students (retries, escalation when they can't be reached).
ALTER TABLE notices ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notices ADD COLUMN sms_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notices ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0;

-- Owner/admin alert emails sent (so each alert is emailed once).
ALTER TABLE staff_alerts ADD COLUMN emailed_at TEXT;

-- A sign-in that must pass an extra email/phone check before protected content opens (risk-based checks).
ALTER TABLE sessions ADD COLUMN verify_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN verify_reason TEXT;

-- Marketing list sync state (Sender): only opted-in, verified students are sent.
ALTER TABLE users ADD COLUMN marketing_synced_at TEXT;
ALTER TABLE users ADD COLUMN marketing_sync_state TEXT;
