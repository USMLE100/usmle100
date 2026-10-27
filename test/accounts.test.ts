import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PASSWORD = 'correct-horse-battery';

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; json?: unknown; ip?: string; ua?: string } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  if (opts.ua) headers['user-agent'] = opts.ua;
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) {
    init.method = 'POST';
    init.body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (opts.json !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(BASE + path, init));
}
const loc = (r: Response) => r.headers.get('location') ?? '';
const deviceOf = (cookie: string) => cookie.split('; ').filter((c) => c.startsWith('u100_device=')).join('; ');
const user = (email: string) => db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<any>();

let n = 0;
async function signUp(extra: Record<string, string> = {}, role: 'student' | 'admin' | 'owner' | 'faculty' = 'student') {
  const email = `acct${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD, ...extra }, ip: `198.18.0.${n % 250}`, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' });
  const cookie = cookies(res);
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();
  return { email, cookie, res, id: (await user(email))?.id as number };
}
const signIn = (email: string, device = '', ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', ip = '203.0.113.50') =>
  req('/sign-in', { form: { email, password: PASSWORD }, cookie: device || undefined, ua, ip });

beforeAll(async () => {
  await req('/');
});

describe('registration (owner: name, email, phone, exam, graduation year; optional consent)', () => {
  it('asks for every field, with the marketing box unchecked', async () => {
    const html = await (await req('/sign-up')).text();
    for (const f of ['first_name', 'last_name', 'phone', 'exam', 'grad_year']) expect(html).toContain(`name="${f}"`);
    expect(html).toMatch(/<input type="checkbox" name="marketing" value="1"\s*\/?>/);
    expect(html).not.toMatch(/name="marketing" value="1" checked/);
  });

  it('refuses missing or invalid details and accepts international numbers', async () => {
    const bad = async (extra: Record<string, string>, text: RegExp) => {
      const r = await req('/sign-up', { form: { ...SIGNUP, email: `bad${++n}@example.com`, password: PASSWORD, ...extra } });
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(text);
    };
    await bad({ last_name: '' }, /first and last name/);
    await bad({ phone: '12' }, /valid mobile number/);
    await bad({ exam: 'Astrology' }, /exam/);
    await bad({ grad_year: '1800' }, /graduation year/);
    const intl = await signUp({ phone: '+44 7700 900123' });
    expect(intl.res.status).toBe(302);
    const u = await user(intl.email);
    expect(u).toMatchObject({ first_name: 'Test', last_name: 'Student', name: 'Test Student', phone: '+447700900123', exam: 'USMLE Step 1', grad_year: 2024, marketing_opt_in: 0, signup_source: 'sign-up' });
    expect(u.marketing_consent_at).toBeNull();
    const us = await signUp({ phone: '(555) 555-0199' });
    expect((await user(us.email)).phone).toBe('+15555550199');
  });

  it('stores consent with its time and exact wording, separately from registration', async () => {
    const a = await signUp({ marketing: '1' }, 'student');
    const u = await user(a.email);
    expect(u.marketing_opt_in).toBe(1);
    expect(u.marketing_consent_at).not.toBeNull();
    expect(u.marketing_consent_text).toMatch(/unsubscribe at any time/);
    // Withdrawing keeps the record of what was agreed, and when.
    await req('/account/marketing', { cookie: a.cookie, form: { on: '0' } });
    expect((await user(a.email)).marketing_opt_in).toBe(0);
  });

  it('limits sign-ups from one network address', async () => {
    const ip = '198.51.100.250';
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await req('/sign-up', { form: { ...SIGNUP, email: `flood${i}-${Date.now()}@example.com`, password: PASSWORD }, ip })).status;
    expect(last).toBe(429);
  });

  it('a free-lecture sign-up goes back to free lectures and records where it came from', async () => {
    const r = await req('/sign-up', { form: { ...SIGNUP, email: `fl${Date.now()}@example.com`, password: PASSWORD, next: '/free-lectures' } });
    expect(loc(r)).toBe('/free-lectures');
  });
});

describe('two registered devices (R001, R017)', () => {
  it('the third device waits for an administrator, who chooses which device it replaces', async () => {
    const s = await signUp();
    const phone = deviceOf(s.cookie);
    const laptop = await signIn(s.email);
    expect(laptop.status).toBe(302);
    const laptopCookie = cookies(laptop);
    // Same browser again: fine.
    expect((await signIn(s.email, deviceOf(laptopCookie))).status).toBe(302);
    // A third browser is refused and becomes a request.
    const third = await signIn(s.email, '', 'Mozilla/5.0 (Macintosh; Mac OS X 14) Safari/605.1');
    expect(third.status).toBe(403);
    expect(await third.text()).toContain('USMLE100 must approve');
    expect(cookies(third)).not.toMatch(/u100_session=/);
    const thirdDevice = deviceOf(cookies(third));
    expect((await signIn(s.email, thirdDevice)).status).toBe(403);
    // Students can't approve; an admin approves it in place of the laptop.
    const pending = (await db.prepare("SELECT id FROM devices WHERE user_id = ? AND status = 'pending'").bind(s.id).first<{ id: number }>())!;
    const laptopRow = (await db.prepare("SELECT id FROM devices WHERE user_id = ? AND status = 'active' AND label LIKE 'Chrome%'").bind(s.id).first<{ id: number }>())!;
    expect((await req(`/admin/requests/device/${pending.id}`, { cookie: s.cookie, form: { decision: 'approve', replace: String(laptopRow.id) } })).status).toBe(404);
    const admin = await signUp({}, 'admin');
    expect(await (await req('/admin/requests', { cookie: admin.cookie })).text()).toContain('New devices waiting');
    expect(loc(await req(`/admin/requests/device/${pending.id}`, { cookie: admin.cookie, form: { decision: 'approve', replace: String(laptopRow.id) } }))).toContain('ok=');
    // The laptop is signed out and can no longer sign in; the new device can; the phone still can.
    expect(loc(await req('/account', { cookie: laptopCookie }))).toContain('/sign-in');
    expect((await signIn(s.email, deviceOf(laptopCookie))).status).toBe(403);
    expect((await signIn(s.email, thirdDevice)).status).toBe(302);
    expect((await signIn(s.email, phone)).status).toBe(302);
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'device.approved' AND target_user_id = ?").bind(s.id).first()).not.toBeNull();
  });

  it('staff are not limited', async () => {
    const f = await signUp({}, 'faculty');
    for (let i = 0; i < 4; i++) expect((await signIn(f.email)).status).toBe(302);
  });
});

describe('suspected account sharing (R003/R004)', () => {
  it('a lecture playing on another device elsewhere warns first, then locks until the owner reinstates', async () => {
    const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
    const cohort = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Share', ymd(-3)).run()).meta.last_row_id);
    const lec = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'Shared', 'live', 'v1', 100)").bind(cohort).run()).meta.last_row_id);
    const s = await signUp();
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(s.id, cohort).run();
    // Agreement-free for this test: device A at home, device B elsewhere.
    const a = await signIn(s.email, deviceOf(s.cookie), undefined, '203.0.113.10');
    const b = await signIn(s.email, '', undefined, '198.51.100.77');
    const A = cookies(a), B = cookies(b);
    const play = (cookie: string, ip: string, tab: string) =>
      worker.fetch(new Request(BASE + '/play/claim', { method: 'POST', body: JSON.stringify({ item: `L:${lec}`, tab }), headers: { cookie, 'cf-connecting-ip': ip, origin: BASE, 'content-type': 'application/json' } })).then((r) => r.json() as any);
    expect((await play(A, '203.0.113.10', 'aaaaaaaaaaaa')).state).toBe('ok');
    // Same person switching devices on the same network: just told the lecture is open elsewhere.
    const sameNet = await signIn(s.email, deviceOf(B), undefined, '203.0.113.10');
    expect((await play(cookies(sameNet), '203.0.113.10', 'bbbbbbbbbbbb')).state).toBe('busy');
    expect((await user(s.email)).status).toBe('active');
    // Another network while it's playing: warning.
    expect(await play(B, '198.51.100.77', 'cccccccccccc')).toEqual({ state: 'sharing', locked: false });
    expect((await user(s.email)).status).toBe('warned');
    expect(await db.prepare("SELECT 1 FROM staff_alerts WHERE kind = 'sharing' AND user_id = ?").bind(s.id).first()).not.toBeNull();
    // The student must read the warning first; doing it again locks the account and signs it out everywhere.
    expect(await play(B, '198.51.100.77', 'dddddddddddd')).toEqual({ state: 'account', url: '/account/notice' });
    await req('/account/notice', { cookie: B, form: {} });
    expect(await play(B, '198.51.100.77', 'dddddddddddd')).toEqual({ state: 'sharing', locked: true });
    expect((await user(s.email)).status).toBe('suspended');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(s.id).first<any>()).n).toBe(0);
    const owner = await signUp({}, 'owner');
    await req('/admin/security/reinstate', { cookie: owner.cookie, form: { user_id: String(s.id) } });
    expect((await user(s.email)).status).toBe('active');
  });
});

describe('My account', () => {
  it('updates details; a verified phone change waits for approval; email changes always do', async () => {
    const s = await signUp();
    const r = await req('/account/profile', { cookie: s.cookie, form: { first_name: 'Ana', last_name: 'Lima', phone: '+5511999998888', exam: 'USMLE Step 2', grad_year: '2023' } });
    expect(loc(r)).toContain('ok=');
    expect(await user(s.email)).toMatchObject({ name: 'Ana Lima', phone: '+5511999998888', exam: 'USMLE Step 2', grad_year: 2023 });
    await db.prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").bind(s.id).run();
    await req('/account/profile', { cookie: s.cookie, form: { first_name: 'Ana', last_name: 'Lima', phone: '+5511911112222', exam: 'USMLE Step 2', grad_year: '2023' } });
    expect((await user(s.email)).phone).toBe('+5511999998888');
    await req('/account/email', { cookie: s.cookie, form: { email: 'new-address@example.com' } });
    expect((await user(s.email)).email).toBe(s.email);
    const admin = await signUp({}, 'admin');
    const reqs = (await db.prepare("SELECT id, field FROM contact_change_requests WHERE user_id = ? AND status = 'pending' ORDER BY id").bind(s.id).all<any>()).results;
    expect(reqs.map((x: any) => x.field)).toEqual(['phone', 'email']);
    for (const x of reqs) await req(`/admin/requests/contact/${x.id}`, { cookie: admin.cookie, form: { decision: 'approve' } });
    const u = await db.prepare('SELECT email, phone, phone_verified_at FROM users WHERE id = ?').bind(s.id).first<any>();
    expect(u).toMatchObject({ email: 'new-address@example.com', phone: '+5511911112222', phone_verified_at: null });
  });

  it('changing the password needs the current one and signs out every device', async () => {
    const s = await signUp();
    const other = cookies(await signIn(s.email));
    expect(loc(await req('/account/password', { cookie: s.cookie, form: { current: 'wrong-password-x', password: 'a brand new passphrase', again: 'a brand new passphrase' } }))).toContain('error=');
    expect(loc(await req('/account/password', { cookie: s.cookie, form: { current: PASSWORD, password: 'a brand new passphrase', again: 'a brand new passphrase' } }))).toBe('/sign-in?ended=password');
    expect(loc(await req('/account', { cookie: s.cookie }))).toContain('/sign-in');
    expect(loc(await req('/account', { cookie: other }))).toContain('/sign-in');
    expect((await user(s.email)).status).toBe('active');
  });

  it('shows sign-ins; "this wasn’t me" ends that sign-in; signing out everywhere needs the password', async () => {
    const s = await signUp();
    const other = cookies(await signIn(s.email));
    const html = await (await req('/account', { cookie: s.cookie })).text();
    expect(html).toContain('(this one)');
    expect(html).toContain('Sign-in history');
    const rid = /name="rid" value="(\d+)"/.exec(html)![1];
    await req('/account/report', { cookie: s.cookie, form: { rid } });
    expect(loc(await req('/account', { cookie: other }))).toContain('/sign-in');
    expect(await db.prepare("SELECT 1 FROM staff_alerts WHERE kind = 'reported_session' AND user_id = ?").bind(s.id).first()).not.toBeNull();
    const third = cookies(await signIn(s.email));
    expect(loc(await req('/account/sign-out-all', { cookie: s.cookie, form: { password: 'nope-nope-nope' } }))).toContain('error=');
    await req('/account/sign-out-all', { cookie: s.cookie, form: { password: PASSWORD } });
    expect(loc(await req('/account', { cookie: third }))).toContain('/sign-in');
    expect((await req('/account', { cookie: s.cookie })).status).toBe(200);
  });

  it('data copies and deletions: admins see them, only the owner completes them', async () => {
    const s = await signUp();
    await req('/account/privacy', { cookie: s.cookie, form: { kind: 'export' } });
    await req('/account/privacy', { cookie: s.cookie, form: { kind: 'deletion' } });
    const [exp, del] = (await db.prepare('SELECT id FROM privacy_requests WHERE user_id = ? ORDER BY id').bind(s.id).all<any>()).results;
    const admin = await signUp({}, 'admin');
    const data = await req(`/admin/requests/privacy/${exp.id}/export`, { cookie: admin.cookie });
    expect(((await data.json()) as any).account.email).toBe(s.email);
    expect((await req(`/admin/requests/privacy/${del.id}`, { cookie: admin.cookie, form: { decision: 'complete' } })).status).toBe(403);
    const owner = await signUp({}, 'owner');
    await req(`/admin/requests/privacy/${del.id}`, { cookie: owner.cookie, form: { decision: 'complete' } });
    const u = await db.prepare('SELECT email, name, phone, status FROM users WHERE id = ?').bind(s.id).first<any>();
    expect(u).toMatchObject({ email: `deleted-${s.id}@deleted.invalid`, name: 'Deleted student', phone: null, status: 'suspended' });
    expect(loc(await req('/account', { cookie: s.cookie }))).toContain('/sign-in');
  });
});

describe('admin students directory and payments check', () => {
  it('admins search and export; faculty and students cannot; only the owner gives a program', async () => {
    const s = await signUp();
    const admin = await signUp({}, 'admin');
    const faculty = await signUp({}, 'faculty');
    const page = await (await req(`/admin/students/directory?q=${encodeURIComponent(s.email)}`, { cookie: admin.cookie })).text();
    expect(page).toContain(s.email);
    expect((await req('/admin/students/directory', { cookie: faculty.cookie })).status).toBe(404);
    expect((await req('/admin/students/export.csv', { cookie: s.cookie })).status).toBe(404);
    const csv = await (await req(`/admin/students/export.csv?q=${encodeURIComponent(s.email)}`, { cookie: admin.cookie })).text();
    expect(csv.split('\n')[0]).toContain('Email');
    expect(csv).toContain(s.email);
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'export.students' AND actor_id = ?").bind(admin.id).first()).not.toBeNull();
    const cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Given', '2026-10-05')").run()).meta.last_row_id);
    const give = { package: 'max', cohort: String(cohort), reason: 'Paid by bank transfer' };
    expect((await req(`/admin/students/${s.id}/give-program`, { cookie: admin.cookie, form: give })).status).toBe(403);
    const owner = await signUp({}, 'owner');
    await req(`/admin/students/${s.id}/give-program`, { cookie: owner.cookie, form: give });
    const e = await db.prepare("SELECT note, cohort_id, amount_cents FROM enrollments WHERE user_id = ? AND status = 'active'").bind(s.id).first<any>();
    expect(e).toMatchObject({ cohort_id: cohort, amount_cents: 0, note: 'Given by the owner: Paid by bank transfer' });
    expect((await req('/admin/payments', { cookie: admin.cookie })).status).toBe(200);
    expect((await req('/admin/payments', { cookie: faculty.cookie })).status).toBe(404);
  });
});
