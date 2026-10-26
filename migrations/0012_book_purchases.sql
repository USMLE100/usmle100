-- $199 Course Book bought on its own through Stripe Checkout.
-- A purchase gives access only when Stripe confirms payment (status 'pending' -> 'paid', exactly once).
CREATE TABLE book_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX book_purchases_user ON book_purchases(user_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('refund_text', '');
