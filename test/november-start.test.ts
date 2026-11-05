import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import sql from '../migrations/0034_november_start_and_hide_tests.sql';
import { statements } from '../src/lib/migrate';

// The November start move and test-recording hide, run against production-shaped data.
const db = (env as any).DB as D1Database;
describe('November cohort to 9 Nov; test recordings hidden', () => {
  it('moves only that cohort, keeps enrollments, hides only pre-start Zoom test entries, deletes nothing', async () => {
    await db.prepare("DELETE FROM cohorts WHERE start_date IN ('2026-11-02','2026-11-09')").run().catch(() => {});
    const qa = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('QA test (owner only - not for students)', '2026-09-08')").run()).meta.last_row_id);
    const nov = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Winter2026', '2026-11-02')").run()).meta.last_row_id);
    const other = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Other', '2026-11-03')").run()).meta.last_row_id);
    const u = Number((await db.prepare("INSERT INTO users (email, name, password_hash, password_salt, role) VALUES (?, 'N', 'x', 'x', 'student')").bind(`nov-${Date.now()}@example.com`).run()).meta.last_row_id);
    const e = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, cohort_id, amount_cents) VALUES (?, 'companion', 'active', ?, 138150)").bind(u, nov).run()).meta.last_row_id);
    const L = async (day: number, title: string) => Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status) VALUES (?, ?, ?, 'processing')").bind(nov, day, title).run()).meta.last_row_id);
    const t1 = await L(1, 'Zoom test 1'), t3 = await L(3, 'Zoom test 3'), planned = await L(5, 'Planned by owner'), later = await L(6, 'Real class');
    let f = 0;
    const imp = (lec: number, start: string) => db.prepare('INSERT INTO zoom_imports (zoom_file_id, lecture_id, start_time, status) VALUES (?, ?, ?, ?)').bind(`f${++f}-${Date.now()}`, lec, start, 'ready').run();
    await imp(t1, '2026-11-02T14:00:00Z'); await imp(t3, '2026-11-04T14:00:00Z'); await imp(later, '2026-11-16T14:00:00Z');
    const lecturesBefore = (await db.prepare('SELECT COUNT(*) AS n FROM lectures').first<any>()).n;
    await db.batch(statements(sql).map((s) => db.prepare(s)));
    const co = (id: number) => db.prepare('SELECT start_date FROM cohorts WHERE id = ?').bind(id).first<any>().then((r) => r.start_date);
    expect(await co(nov)).toBe('2026-11-09');
    expect(await co(other)).toBe('2026-11-03');
    expect(await co(qa)).toBe('2026-09-08');
    expect((await db.prepare('SELECT cohort_id, status FROM enrollments WHERE id = ?').bind(e).first<any>())).toEqual({ cohort_id: nov, status: 'active' });
    const where = (id: number) => db.prepare('SELECT cohort_id FROM lectures WHERE id = ?').bind(id).first<any>().then((r) => r.cohort_id);
    expect([await where(t1), await where(t3)]).toEqual([qa, qa]);
    expect([await where(planned), await where(later)]).toEqual([nov, nov]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM lectures').first<any>()).n).toBe(lecturesBefore);
  });
});
