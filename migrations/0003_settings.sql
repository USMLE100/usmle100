-- Editable site details (Admin -> Site settings).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
 ('student_count', '1,400+'),
 ('contact_email', 'info.usmle100@gmail.com'),
 ('calendly_url', ''),
 ('practice_test_when', ''),
 ('practice_test_link', '');
