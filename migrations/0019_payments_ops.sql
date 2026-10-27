-- Why a program was given or changed by hand (owner grants are logged with a reason).
ALTER TABLE enrollments ADD COLUMN note TEXT;
-- A chargeback suspends the purchase it disputes until it is resolved (owner decision on refunds and chargebacks).
ALTER TABLE enrollments ADD COLUMN suspended_at TEXT;
ALTER TABLE enrollments ADD COLUMN suspended_reason TEXT;

CREATE TABLE stripe_disputes (
  id TEXT PRIMARY KEY,                 -- Stripe dispute id (dp_…); each is handled once
  charge_id TEXT,
  payment_intent TEXT,
  amount INTEGER,
  reason TEXT,
  status TEXT,
  user_id INTEGER,
  enrollment_id INTEGER,
  book_purchase_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  outcome TEXT
);
