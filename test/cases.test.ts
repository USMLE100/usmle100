import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';
import { addBusinessDays, compensate, escalateCases, parseIso } from '../src/lib/cases';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;

async function req(path: string, opts: { cookie?: string; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) {
    init.method = 'POST';
    init.body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  return worker.fetch(new Request(BASE + path, init));
}
const loc = (r: Response) => r.headers.get('location') ?? '';
let n = 0;
async function account(role: 'student' | 'faculty' | 'admin' | 'owner' = 'student') {
  const email = `case${++n}-${Date.now()}@example.com`;
  const r = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  return { email, cookie: cookies(r), id };
}
const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const caseOf = (userId: number) => db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY id DESC').bind(userId).first<any>();

let cohort = 0;
beforeAll(async () => {
  await req('/');
  cohort = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Cases', ymd(-20)).run()).meta.last_row_id);
});

describe('business days', () => {
  it('skips weekends', () => {
    expect(addBusinessDays(new Date('2026-10-30T12:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-11-03'); // Fri + 2 = Tue
    expect(addBusinessDays(new Date('2026-10-27T12:00:00Z'), 5).toISOString().slice(0, 10)).toBe('2026-11-03');
  });
});

describe('view-credit disputes', () => {
  it('student disputes a used view; exam soon is expedited after verification; owner decides; one view restored once', async () => {
    const s = await account();
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(s.id, cohort).run();
    const lec = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'Disputed', 'live', 'v', 100)").bind(cohort).run()).meta.last_row_id);
    const item = `L:${lec}`;
    // Disputing a video whose view wasn't used is refused.
    expect(loc(await req('/account/appeals', { cookie: s.cookie, form: { kind: 'view-dispute', item, statement: 'My connection dropped and the view was used.' } }))).toContain('error=');
    await db.prepare("INSERT INTO view_sessions (id, user_id, item, kind, enrollment_id, created_at, counted, counted_reason) VALUES ('DISPUTE01', ?, ?, 'paid', (SELECT id FROM enrollments WHERE user_id = ?), 1, 1, 'expired')").bind(s.id, item, s.id).run();
    expect(loc(await req('/account/appeals', { cookie: s.cookie, form: { kind: 'view-dispute', item, statement: 'My connection dropped and the view was used.', exam_date: ymd(1) } }))).toBe('/account/appeals?ok=1');
    const k = await caseOf(s.id);
    expect(k).toMatchObject({ kind: 'view-dispute', item, expedite_requested: 1, status: 'open' });
    expect(parseIso(k.due_at).getTime() - Date.now()).toBeGreaterThan(36 * 3600e3); // 2 business days
    expect(await (await req('/account/appeals', { cookie: s.cookie })).text()).toContain(`View dispute #${k.id}`);

    const admin = await account('admin');
    const owner = await account('owner');
    const faculty = await account('faculty');
    expect((await req('/admin/cases', { cookie: faculty.cookie })).status).toBe(404);
    expect((await req('/admin/cases', { cookie: s.cookie })).status).toBe(404);
    expect((await req(`/admin/cases/${k.id}`, { cookie: admin.cookie })).status).toBe(200);
    await req(`/admin/cases/${k.id}/verify`, { cookie: admin.cookie, form: {} });
    expect(parseIso((await caseOf(s.id)).due_at).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600e3 + 5000);
    // The owner can't be the reviewer; an admin reviews.
    expect(loc(await req(`/admin/cases/${k.id}/review`, { cookie: owner.cookie, form: { recommendation: 'grant', note: 'Looks right to me.' } }))).toContain('error=');
    await req(`/admin/cases/${k.id}/review`, { cookie: admin.cookie, form: { recommendation: 'grant', note: 'Outage confirmed in the log.' } });
    // Only the owner decides; deciding against the review needs a justification.
    expect((await req(`/admin/cases/${k.id}/decide`, { cookie: admin.cookie, form: { decision: 'granted', reason: 'Restored.' } })).status).toBe(403);
    expect(loc(await req(`/admin/cases/${k.id}/decide`, { cookie: owner.cookie, form: { decision: 'denied', reason: 'The view was used normally.' } }))).toContain('error=');
    expect(loc(await req(`/admin/cases/${k.id}/decide`, { cookie: owner.cookie, form: { decision: 'granted', reason: 'We confirmed the outage and restored your view.' } }))).toContain('ok=');
    expect(loc(await req(`/admin/cases/${k.id}/decide`, { cookie: owner.cookie, form: { decision: 'granted', reason: 'Again, by mistake.' } }))).toContain('error=');
    const grants = (await db.prepare('SELECT extra, case_id FROM view_grants WHERE user_id = ?').bind(s.id).all<any>()).results;
    expect(grants).toEqual([{ extra: 1, case_id: k.id }]);
    expect(await db.prepare("SELECT 1 FROM notices WHERE user_id = ? AND title LIKE 'Decision on your request%'").bind(s.id).first()).not.toBeNull();
  });
});

describe('appeals and compensation', () => {
  it('a suspended student can appeal; granting reinstates and extends the enrollment by the restricted time, once', async () => {
    const s = await account();
    const e = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, lectures_until) VALUES (?, 'max', 'active', datetime('now'), ?, ?)").bind(s.id, cohort, ymd(30)).run()).meta.last_row_id);
    await db.prepare("UPDATE users SET status = 'suspended', status_reason = 'Shared login suspected', status_at = datetime('now', '-10 days') WHERE id = ?").bind(s.id).run();
    expect((await req('/account/appeals', { cookie: s.cookie })).status).toBe(200);
    expect(loc(await req('/dashboard', { cookie: s.cookie }))).toBe('/account/suspended');
    expect(loc(await req('/account/appeals', { cookie: s.cookie, form: { kind: 'appeal', statement: 'I never shared my account; that was my own laptop.' } }))).toBe('/account/appeals?ok=1');
    const k = await caseOf(s.id);
    const owner = await account('owner');
    expect(loc(await req(`/admin/cases/${k.id}/decide`, { cookie: owner.cookie, form: { decision: 'granted', reason: 'The sign-ins were from your own devices.' } }))).toContain('ok=');
    expect((await db.prepare('SELECT status FROM users WHERE id = ?').bind(s.id).first<any>()).status).toBe('active');
    const until = (await db.prepare('SELECT lectures_until FROM enrollments WHERE id = ?').bind(e).first<any>()).lectures_until;
    expect([ymd(40), ymd(41)]).toContain(until);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM compensations WHERE case_id = ?').bind(k.id).first<any>()).n).toBe(1);
    // Running the compensation again for the same case gives nothing more.
    expect(await compensate(db, k.id, s.id, new Date(Date.now() - 10 * 86400e3))).toEqual([]);
    expect((await db.prepare('SELECT lectures_until FROM enrollments WHERE id = ?').bind(e).first<any>()).lectures_until).toBe(until);
  });

  it('an enrollment that ran out during the restriction gets back the time it had left', async () => {
    const s = await account();
    const e = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, lectures_until) VALUES (?, 'max', 'active', datetime('now'), ?, ?)").bind(s.id, cohort, ymd(-5)).run()).meta.last_row_id);
    const caseId = Number((await db.prepare("INSERT INTO cases (user_id, kind, statement, due_at) VALUES (?, 'appeal', 'Wrongly locked.', '2099-01-01 00:00:00')").bind(s.id).run()).meta.last_row_id);
    const given = await compensate(db, caseId, s.id, new Date(Date.now() - 8 * 86400e3));
    expect(given).toHaveLength(1);
    const until = (await db.prepare('SELECT lectures_until FROM enrollments WHERE id = ?').bind(e).first<any>()).lectures_until;
    expect([ymd(3), ymd(4)]).toContain(until);
  });

  it('overdue cases raise one staff alert', async () => {
    const s = await account();
    await db.prepare("INSERT INTO cases (user_id, kind, statement, due_at) VALUES (?, 'appeal', 'Please review my account.', '2000-01-01 00:00:00')").bind(s.id).run();
    expect(await escalateCases(db)).toBeGreaterThanOrEqual(1);
    expect(await escalateCases(db)).toBe(0);
    expect(await db.prepare("SELECT 1 FROM staff_alerts WHERE kind = 'case-overdue' AND user_id = ?").bind(s.id).first()).not.toBeNull();
  });
});
