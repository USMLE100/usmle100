-- Zoom recordings are copied to Bunny automatically but published only after the owner's one approval
-- ("Lecture 14, November 12, 6:02 PM — approve?").
ALTER TABLE zoom_imports ADD COLUMN approved_at TEXT;
ALTER TABLE zoom_imports ADD COLUMN approved_by INTEGER;
ALTER TABLE zoom_imports ADD COLUMN declined_at TEXT;
