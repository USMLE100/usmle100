-- Full refunds issued by the owner in the Stripe Dashboard remove the access that purchase gave.
-- The site never starts a refund; it only reacts to Stripe's charge.refunded notification.

-- Course Book purchases can now be marked refunded (SQLite can't change a CHECK, so the table is rebuilt).
CREATE TABLE book_purchases_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded')),
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT UNIQUE,
  payment_intent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  refunded_at TEXT
);
INSERT INTO book_purchases_new (id, user_id, status, amount_cents, stripe_session_id, created_at, paid_at)
  SELECT id, user_id, status, amount_cents, stripe_session_id, created_at, paid_at FROM book_purchases;
DROP TABLE book_purchases;
ALTER TABLE book_purchases_new RENAME TO book_purchases;
CREATE INDEX book_purchases_user ON book_purchases(user_id);
CREATE INDEX book_purchases_pi ON book_purchases(payment_intent);

ALTER TABLE enrollments ADD COLUMN payment_intent TEXT;
ALTER TABLE enrollments ADD COLUMN refunded_at TEXT;
CREATE INDEX enrollments_pi ON enrollments(payment_intent);

-- Each refunded charge is handled once, so repeated notifications (or a later access restore) are safe.
CREATE TABLE stripe_refunds (
  charge_id TEXT PRIMARY KEY,
  payment_intent TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
