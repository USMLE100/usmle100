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
    await req(`/admin/students/${s.id}/course/until`, { cookie: owner.cookie, form: { until: '2027-01-31' } });
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
    for (const t of ['100-Day Course', 'Give course access', 'Evening Questions', 'Give Evening Questions']) expect(html, t).toContain(t);
  });
});
