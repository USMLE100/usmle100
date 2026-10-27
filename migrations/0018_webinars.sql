-- Live webinars. Anyone can see what's coming up; registering needs a USMLE100 account with the owner's
-- required details, and only registered students see the join link. Registrations are the attendee list.
CREATE TABLE webinars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,             -- ISO time, UTC
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  join_url TEXT,                       -- e.g. the Zoom link; shown only to registered students
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE webinar_registrations (
  webinar_id INTEGER NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (webinar_id, user_id)
);
