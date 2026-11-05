import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';
import { eveningAccess } from '../src/lib/evening';

// Owner, 5 Nov 2026: the 100-Day Course and Evening Questions are granted and removed separately in Admin → Students.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
async function req(path: string, opts: { cookie?: string; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) { init.method = 'POST'; init.body = new URLSearchParams(opts.form); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  return worker.fetch(new Request(BASE + path, init));
}
let n = 0;
async function acct(role: 'student' | 'owner' | 'admin' = 'student') {
  const email = `sep${++n}-${Date.now()}@example.com`;
  const r = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  if (role === 'owner') await makeOwner(db, email);
  if (role === 'admin') await db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(email).run();
  const u = (await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<any>())!;
  return { email, id: u.id as number, cookie: cookies(r) };
}
const course = (uid: number) => db.prepare("SELECT * FROM enrollments WHERE user_id = ? AND status = 'active'").bind(uid).first<any>();
const evening = async (uid: number) => !!(await eveningAccess(db, (await db.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<any>())!));
let owner: { cookie: string }, cohort = 0;
beforeAll(async () => {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('staff_passkeys', '0') ON CONFLICT (key) DO UPDATE SET value = '0'").run();
  owner = await acct('owner');
  cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Sep', date('now','-3 days'))").run()).meta.last_row_id);
  // Evening classes so far, so months have recordings to show.
  for (let i = 0; i < 3; i++) await db.prepare("INSERT INTO evening_sessions (session_date, title, status, live_at, bunny_video_id) VALUES (date('now', ?), 'Ev', 'live', datetime('now'), 'ev')").bind(`-${i} day`).run();
});

describe('separate access for the 100-Day Course and Evening Questions', () => {
  it('a student can have either one or both, and each is changed without touching the other', async () => {
    const s = await acct();
    // Evening only.
    await req(`/admin/students/${s.id}/evening/give`, { cookie: owner.cookie, form: { months: '1', note: 'monthly link' } });
    expect(await evening(s.id)).toBe(true);
    expect(await course(s.id)).toBeNull();
    // Add the course without its included months: Evening stays exactly as given.
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: { package: 'companion', cohort: String(cohort), reason: 'Payment Link', evening_choice: '1', until: '2027-05-23' } });
    const e = await course(s.id);
    expect(e).toMatchObject({ package_id: 'companion', lectures_until: '2027-05-23' });
    expect(e.evening_removed_at).not.toBeNull();
    // Removing Evening leaves the course untouched.
    const before = JSON.stringify(await course(s.id));
    await req(`/admin/students/${s.id}/evening/remove`, { cookie: owner.cookie, form: { reason: 'stopped paying' } });
    expect(await evening(s.id)).toBe(false);
    expect(JSON.stringify({ ...(await course(s.id)), evening_removed_at: null })).toBe(JSON.stringify({ ...JSON.parse(before), evening_removed_at: null }));
    // Giving Evening again, then removing the course: Evening stays.
    await req(`/admin/students/${s.id}/evening/give`, { cookie: owner.cookie, form: { months: '2' } });
    await req(`/admin/students/${s.id}/course/remove`, { cookie: owner.cookie, form: { reason: 'test' } });
    expect(await course(s.id)).toBeNull();
    expect(await evening(s.id)).toBe(true);
  });

  it('removing the course keeps the Evening months the program included; removing those keeps the course', async () => {
    const a = await acct();
    await req(`/admin/students/${a.id}/give-program`, { cookie: owner.cookie, form: { package: 'max', cohort: String(cohort), reason: 'bank', evening_choice: '1', include_evening: '1' } });
    expect(await evening(a.id)).toBe(true);
    await req(`/admin/students/${a.id}/course/remove`, { cookie: owner.cookie, form: { reason: 'r' } });
    expect(await course(a.id)).toBeNull();
    expect(await evening(a.id)).toBe(true);
    expect((await db.prepare('SELECT months FROM evening_subscriptions WHERE user_id = ?').bind(a.id).first<any>()).months).toBe(4);

    const b = await acct();
    await req(`/admin/students/${b.id}/give-program`, { cookie: owner.cookie, form: { package: 'max', cohort: String(cohort), reason: 'bank', evening_choice: '1', include_evening: '1' } });
    await req(`/admin/students/${b.id}/evening/remove`, { cookie: owner.cookie, form: { reason: 'r' } });
    expect(await evening(b.id)).toBe(false);
    expect(await course(b.id)).not.toBeNull();
  });

  it('end dates: Evening closes after its date; the course end date sets lecture access; clearing works', async () => {
    const s = await acct();
    await req(`/admin/students/${s.id}/evening/give`, { cookie: owner.cookie, form: { months: '1', until: '2020-01-01' } });
    expect(await evening(s.id)).toBe(false);
    await req(`/admin/students/${s.id}/evening/until`, { cookie: owner.cookie, form: { clear: '1' } });
    expect(await evening(s.id)).toBe(true);
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: { package: 'refresher', cohort: String(cohort), reason: 'x', evening_choice: '1' } });
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: '2027-01-31', reason: 'extension' } });
    expect((await course(s.id)).lectures_until).toBe('2027-01-31');
    expect(await evening(s.id)).toBe(true);
  });

  it('existing access is unchanged: an older program row with included months still gets Evening, and the old form keeps them', async () => {
    const s = await acct();
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, amount_cents) VALUES (?, 'companion', 'active', datetime('now'), ?, 199900)").bind(s.id, cohort).run();
    expect(await evening(s.id)).toBe(true);
    const t = await acct();
    await req(`/admin/students/${t.id}/give-program`, { cookie: owner.cookie, form: { package: 'companion', cohort: String(cohort), reason: 'old form' } });
    expect(await evening(t.id)).toBe(true);
  });

  it('only the owner can use these controls; the student page shows both panels', async () => {
    const s = await acct();
    const admin = await acct('admin');
    for (const p of ['course/until', 'course/remove', 'evening/give', 'evening/until', 'evening/remove']) {
      const r = await req(`/admin/students/${s.id}/${p}`, { cookie: admin.cookie, form: { reason: 'x', months: '1', until: '2027-01-01' } });
      expect([403, 404], p).toContain(r.status);
    }
    expect(await evening(s.id)).toBe(false);
    const html = await (await req(`/admin/students/view?email=${encodeURIComponent(s.email)}`, { cookie: owner.cookie })).text();
    for (const t of ['100-Day Course', 'Give access', 'Evening Questions', 'End date (optional'])  expect(html, t).toContain(t);
  });
});

describe('Day 160: paid course access ends together', () => {
  const ymd = (days: number) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
  const page = (cookie: string, p: string) => req(p, { cookie });
  it('the standard end is Day 160 from the cohort start (60 days after Day 100), not the payment date', async () => {
    const { currentCohort, defaultLecturesUntil, dayDate } = await import('../src/lib/content');
    const co = (await currentCohort(db, cohort))!;
    const d100 = dayDate(co, co.total_days).getTime();
    expect(Date.parse(defaultLecturesUntil(co)) - d100).toBe(60 * 86400e3);
  });

  it('before the end everything opens; after it lectures, Qbank and materials close together, account and purchases stay, buying again works', async () => {
    const s = await acct();
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: { package: 'companion', cohort: String(cohort), reason: 'x', evening_choice: '1', until: ymd(5) } });
    for (const p of ['/dashboard', '/topics']) expect((await page(s.cookie, p)).status, p).toBe(200);
    // Owner shortens access to a day already past (with a reason): everything paid closes.
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: ymd(-3), reason: 'shorten test' } });
    for (const p of ['/dashboard', '/topics', '/lectures']) expect((await page(s.cookie, p)).headers.get('location'), p).toBe('/enroll');
    const claim = await req('/play/claim', { cookie: s.cookie, form: {} });
    expect(claim.status).not.toBe(200);
    const acc = await page(s.cookie, '/account');
    expect(acc.status).toBe(200);
    const html = await acc.text();
    expect(html).toContain('Your purchases');
    expect(html).toMatch(/access ended/);
    expect((await page(s.cookie, '/enroll')).status).toBe(200);
    // Extend again with a reason: access returns. Every change is in the activity log with its reason.
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: ymd(30), reason: 'medical leave' } });
    expect((await page(s.cookie, '/dashboard')).status).toBe(200);
    const log = (await db.prepare("SELECT detail FROM audit_log WHERE action = 'access.course_until' AND target_user_id = ?").bind(s.id).all<any>()).results.map((r: any) => r.detail).join(' ');
    expect(log).toContain('medical leave');
    // A change without a reason is refused.
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: ymd(-3) } });
    expect((await page(s.cookie, '/dashboard')).status).toBe(200);
  });

  it('Evening Questions bought separately stay open after the course has ended', async () => {
    const s = await acct();
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: { package: 'refresher', cohort: String(cohort), reason: 'x', evening_choice: '1', until: ymd(-2) } });
    await req(`/admin/students/${s.id}/evening/give`, { cookie: owner.cookie, form: { months: '1' } });
    expect(await evening(s.id)).toBe(true);
    expect((await page(s.cookie, '/evening')).status).toBe(200);
    expect((await page(s.cookie, '/topics')).headers.get('location')).not.toBe('/topics');
  });

  it('existing students: a program whose date had already passed when the rule began keeps working and is flagged for review', async () => {
    const { exemptAlreadyEnded } = await import('../src/lib/content');
    const s = await acct();
    const id = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, amount_cents, lectures_until) VALUES (?, 'refresher', 'active', datetime('now'), ?, 150000, ?)").bind(s.id, cohort, ymd(-10)).run()).meta.last_row_id);
    const open = await acct();
    const id2 = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, amount_cents) VALUES (?, 'refresher', 'active', datetime('now'), ?, 150000)").bind(open.id, cohort).run()).meta.last_row_id);
    // Simulate the first run of the rule on a database that already has these students.
    await db.prepare("DELETE FROM settings WHERE key = 'course_end_rule_started'").run();
    const mod = await import('../src/lib/content');
    (mod as any)._resetExemptForTests();
    await exemptAlreadyEnded(db);
    expect((await db.prepare('SELECT expiry_exempt, lectures_until FROM enrollments WHERE id = ?').bind(id).first<any>())).toEqual({ expiry_exempt: 1, lectures_until: ymd(-10) });
    expect((await db.prepare('SELECT expiry_exempt FROM enrollments WHERE id = ?').bind(id2).first<any>())!.expiry_exempt).toBe(0);
    expect((await page(s.cookie, '/dashboard')).status).toBe(200);
    // The owner sees it on the student page and decides.
    const html = await (await req(`/admin/students/view?email=${encodeURIComponent(s.email)}`, { cookie: owner.cookie })).text();
    for (const t of ['kept open', 'Day 160', 'Day 100', 'starts']) expect(html, t).toContain(t);
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: ymd(-10), reason: 'reviewed: ended' } });
    expect((await page(s.cookie, '/dashboard')).headers.get('location')).toBe('/enroll');
  });

  it('no duplicate programs: giving the course to a student who has it is refused', async () => {
    const s = await acct();
    const give = { package: 'refresher', cohort: String(cohort), reason: 'x', evening_choice: '1' };
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: give });
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: give });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ? AND status = 'active'").bind(s.id).first<any>()).n).toBe(1);
  });
});
