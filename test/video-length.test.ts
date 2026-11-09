import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ensureMigrated } from '../src/lib/migrate';

// 9 Nov 2026: Day 1 kept a 6-second length after its video was swapped for the real class.
describe('a lecture length follows its video', () => {
  it('changing the video clears the stored length; other edits keep it', async () => {
    const db = env.DB;
    await ensureMigrated(db);
    const c = await db.prepare("SELECT id FROM cohorts LIMIT 1").first<{ id: number }>();
    const cohortId = c?.id ?? Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('T', '2026-11-09')").run()).meta.last_row_id);
    const r = await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, bunny_video_id, duration_seconds, status) VALUES (?, 77, 'X', 'clip', 6, 'live')").bind(cohortId).run();
    const id = Number(r.meta.last_row_id);
    await db.prepare("UPDATE lectures SET title = 'Y', status = 'processing' WHERE id = ?").bind(id).run();
    expect((await db.prepare('SELECT duration_seconds d FROM lectures WHERE id = ?').bind(id).first<any>()).d).toBe(6);
    await db.prepare("UPDATE lectures SET bunny_video_id = 'real' WHERE id = ?").bind(id).run();
    expect((await db.prepare('SELECT duration_seconds d FROM lectures WHERE id = ?').bind(id).first<any>()).d).toBe(null);
    await db.prepare('UPDATE lectures SET duration_seconds = 16020 WHERE id = ?').bind(id).run();
    await db.prepare("UPDATE lectures SET bunny_video_id = 'real' WHERE id = ?").bind(id).run();
    expect((await db.prepare('SELECT duration_seconds d FROM lectures WHERE id = ?').bind(id).first<any>()).d).toBe(16020);
    await db.prepare('UPDATE lectures SET bunny_video_id = NULL WHERE id = ?').bind(id).run();
    expect((await db.prepare('SELECT duration_seconds d FROM lectures WHERE id = ?').bind(id).first<any>()).d).toBe(null);
    await db.prepare('DELETE FROM lectures WHERE id = ?').bind(id).run();
  });
  it('same for evening classes', async () => {
    const db = env.DB;
    await ensureMigrated(db);
    const r = await db.prepare("INSERT INTO evening_sessions (session_date, title, bunny_video_id, duration_seconds, status) VALUES ('2030-01-07', 'E', 'clip', 6, 'live')").run();
    const id = Number(r.meta.last_row_id);
    await db.prepare("UPDATE evening_sessions SET bunny_video_id = 'real' WHERE id = ?").bind(id).run();
    expect((await db.prepare('SELECT duration_seconds d FROM evening_sessions WHERE id = ?').bind(id).first<any>()).d).toBe(null);
    await db.prepare('DELETE FROM evening_sessions WHERE id = ?').bind(id).run();
  });
});
