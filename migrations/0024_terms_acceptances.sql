-- Evidence of agreement at sign-up (owner, 3 Nov 2026): which exact version of the Terms, Privacy Policy and Refund
-- Policy was in force, the wording of the box that was ticked, when, and from where. Kept separately from the
-- 24-month security log so it is not pruned. Additive only.
CREATE TABLE terms_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  context TEXT NOT NULL,
  checkbox_text TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  privacy_hash TEXT NOT NULL,
  refund_hash TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_terms_acceptances_user ON terms_acceptances(user_id);
-- Full text of every version that anyone accepted, so a hash above can always be matched to the words shown.
CREATE TABLE policy_versions (
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  first_accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, hash)
);
