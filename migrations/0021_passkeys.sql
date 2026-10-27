-- Phishing-resistant sign-in for staff (R021, additional Q1): passkeys / FIDO2 security keys,
-- plus one-time recovery codes for when the passkey's device is lost.
CREATE TABLE passkeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,  -- base64url
  public_key TEXT NOT NULL,            -- base64url COSE key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

-- One pending WebAuthn challenge per sign-in session and purpose, valid 5 minutes.
CREATE TABLE webauthn_challenges (
  session_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_hash, purpose)
);

ALTER TABLE sessions ADD COLUMN passkey_id INTEGER;
INSERT OR IGNORE INTO settings (key, value) VALUES ('staff_passkeys', '1');
