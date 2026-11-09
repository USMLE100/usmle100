-- 9 Nov 2026: a lecture's stored length must follow its video. Day 1 kept the 6-second length of an accidental clip
-- after the real 4.5-hour class replaced it, so the 65% view rule and the "keep watching" window used 6 seconds.
-- From now on, changing a lecture's or evening class's video clears its stored length; the site then reads the real
-- length from Bunny again (and, until then, uses the length the player reports).
CREATE TRIGGER IF NOT EXISTS lectures_video_changed AFTER UPDATE OF bunny_video_id ON lectures WHEN OLD.bunny_video_id IS NOT NEW.bunny_video_id BEGIN UPDATE lectures SET duration_seconds = NULL WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS evening_video_changed AFTER UPDATE OF bunny_video_id ON evening_sessions WHEN OLD.bunny_video_id IS NOT NEW.bunny_video_id BEGIN UPDATE evening_sessions SET duration_seconds = NULL WHERE id = NEW.id; END;
-- One-time: re-read every stored length from Bunny, so any length saved for an earlier video is replaced.
UPDATE lectures SET duration_seconds = NULL WHERE duration_seconds IS NOT NULL;
UPDATE evening_sessions SET duration_seconds = NULL WHERE duration_seconds IS NOT NULL;
-- Viewings already open kept the wrong length too; clear lengths under 2 minutes so they use the real one.
UPDATE view_sessions SET duration = NULL WHERE duration IS NOT NULL AND duration < 120;
