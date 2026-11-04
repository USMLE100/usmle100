-- Recordings the owner declined before 4 Nov 2026 stayed attached to their (hidden) day, which blocked that day's real
-- recording from importing. Detach them. Only days that are not live and hold a declined recording; Bunny keeps the video.
UPDATE lectures SET bunny_video_id = NULL WHERE status <> 'live' AND bunny_video_id IS NOT NULL AND bunny_video_id IN (SELECT bunny_video_id FROM zoom_imports WHERE declined_at IS NOT NULL AND bunny_video_id IS NOT NULL);
UPDATE evening_sessions SET bunny_video_id = NULL WHERE status <> 'live' AND bunny_video_id IS NOT NULL AND bunny_video_id IN (SELECT bunny_video_id FROM zoom_imports WHERE declined_at IS NOT NULL AND bunny_video_id IS NOT NULL);
