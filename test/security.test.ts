import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;

/** A browser-like request from the site itself (passes the same-origin check). */
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

let n = 0;
/** Create an account through the public sign-up form and return its session cookie. */
async function signUp(email = `user${++n}@example.com`) {
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  const cookie = cookies(res);
  expect(cookie).toMatch(/u100_session=/);
  return { cookie, email };
}

const roleOf = async (email: string) => (await db.prepare('SELECT role FROM users WHERE email = ?').bind(email).first<{ role: string }>())?.role;
const setRole = (email: string, role: string) => db.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();

async function as(role: 'student' | 'faculty' | 'admin' | 'owner') {
  const u = await signUp();
  if (role === 'owner') await makeOwner(db, u.email);
  else if (role !== 'student') await setRole(u.email, role);
  return u;
}

/** Admin-only pages and actions (GET pages and POST actions). */
const ADMIN_ONLY_GET = ['/admin/settings', '/admin/team', '/admin/students'];
const ADMIN_ONLY_POST: [string, Record<string, string>][] = [
  ['/admin/settings', { student_count: 'hacked' }],
  ['/admin/team', { email: 'x@example.com', role: 'admin' }],
  ['/admin/students/1/lectures', { until: '2099-01-01' }],
  ['/admin/cohorts', { name: 'X', start_date: '2027-01-04' }],
  ['/admin/days-off', { date: '2027-01-05', label: 'X' }],
  ['/admin/days-off/remove', { date: '2027-01-05' }],
  ['/admin/zoom-settings', { zoom_meeting_ids: '1' }],
  ['/admin/evening/settings', { ids: '1' }],
  ['/admin/evening/access', { email: 'x@example.com', start: '2027-01-04', months: '1' }],
  ['/admin/evening/access/extend', { user_id: '1' }],
  ['/admin/evening/access/remove', { user_id: '1' }],
];
const TEACHING_GET = ['/admin/lectures', '/admin/questions', '/admin/questions/new', '/admin/questions/import', '/admin/evening'];

describe('sign-up never grants staff roles', () => {
  it('signing up with the former admin email creates a student with no admin access', async () => {
    const { cookie, email } = await signUp('info.usmle100@gmail.com');
    expect(await roleOf(email)).toBe('student');
    for (const path of [...ADMIN_ONLY_GET, ...TEACHING_GET]) expect((await req(path, { cookie })).status, path).toBe(404);
  });

  it('a role field sent with the sign-up form is ignored', async () => {
    const email = 'sneaky@example.com';
    await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery', role: 'admin' } });
    expect(await roleOf(email)).toBe('student');
  });
});

describe('students cannot use the admin area', () => {
  it('every admin page and action is refused', async () => {
    const { cookie } = await as('student');
    for (const path of [...ADMIN_ONLY_GET, ...TEACHING_GET]) expect((await req(path, { cookie })).status, path).toBe(404);
    for (const [path, form] of ADMIN_ONLY_POST) expect((await req(path, { cookie, form })).status, path).toBe(404);
  });

  it('a student cannot promote themselves or change prices', async () => {
    const { cookie, email } = await as('student');
    await req('/admin/team', { cookie, form: { email, role: 'admin' } });
    expect(await roleOf(email)).toBe('student');
    const before = await db.prepare("SELECT price_cents FROM packages WHERE id = 'max'").first<{ price_cents: number }>();
    await req('/admin/settings', { cookie, form: { price_max: '1' } });
    const after = await db.prepare("SELECT price_cents FROM packages WHERE id = 'max'").first<{ price_cents: number }>();
    expect(after?.price_cents).toBe(before?.price_cents);
  });

  it('signed-out visitors are sent to sign in', async () => {
    const res = await req('/admin/settings');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });
});

describe('faculty get only the teaching tools', () => {
  it('can open questions, lectures and evening recordings', async () => {
    const { cookie } = await as('faculty');
    for (const path of TEACHING_GET) expect((await req(path, { cookie })).status, path).toBe(200);
  });

  it('cannot open or use admin-only pages', async () => {
    const { cookie } = await as('faculty');
    for (const path of ADMIN_ONLY_GET) expect((await req(path, { cookie })).status, path).toBe(404);
    for (const [path, form] of ADMIN_ONLY_POST) expect((await req(path, { cookie, form })).status, path).toBe(404);
  });

  it('cannot make themselves admin', async () => {
    const { cookie, email } = await as('faculty');
    await req('/admin/team', { cookie, form: { email, role: 'admin' } });
    expect(await roleOf(email)).toBe('faculty');
  });

  it('do not see admin-only controls on shared pages', async () => {
    const { cookie } = await as('faculty');
    const evening = await (await req('/admin/evening', { cookie })).text();
    expect(evening).not.toContain('Who can watch');
    expect(evening).not.toContain('action="/admin/evening/settings"');
    const menu = await (await req('/admin/lectures', { cookie })).text();
    expect(menu).not.toContain('href="/admin/settings"');
    expect(menu).not.toContain('href="/admin/team"');
  });
});

describe('admins keep full access', () => {
  it('can open every admin page', async () => {
    const { cookie } = await as('admin');
    for (const path of [...ADMIN_ONLY_GET, ...TEACHING_GET]) expect((await req(path, { cookie })).status, path).toBe(200);
  });

  it('the owner can make someone faculty and remove it again', async () => {
    const { cookie } = await as('owner');
    const other = await as('student');
    await req('/admin/team', { cookie, form: { email: other.email, role: 'faculty' } });
    expect(await roleOf(other.email)).toBe('faculty');
    await req('/admin/team', { cookie, form: { email: other.email, role: 'student' } });
    expect(await roleOf(other.email)).toBe('student');
  });

  it('the owner cannot be demoted, not even by themselves', async () => {
    const { cookie, email } = await as('owner');
    const res = await req('/admin/team', { cookie, form: { email, role: 'student' } });
    expect(res.headers.get('location')).toContain('error=');
    expect(await roleOf(email)).toBe('admin');
  });

  it('an admin who is not the owner cannot change the team', async () => {
    const { cookie } = await as('admin');
    const other = await as('student');
    expect((await req('/admin/team', { cookie, form: { email: other.email, role: 'admin' } })).status).toBe(403);
    expect(await roleOf(other.email)).toBe('student');
  });
});

describe('everyday sign-in still works', () => {
  it('a student can sign out and back in, and is asked to enroll before the portal', async () => {
    const { email } = await as('student');
    const res = await req('/sign-in', { form: { email, password: 'correct-horse-battery' } });
    const cookie = cookies(res);
    expect(cookie).toMatch(/u100_session=/);
    const dash = await req('/dashboard', { cookie });
    expect(dash.status).toBe(302);
    expect(dash.headers.get('location')).toBe('/enroll');
  });

  it('a wrong password is refused', async () => {
    const { email } = await as('student');
    const res = await req('/sign-in', { form: { email, password: 'wrong-password-123' } });
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/u100_session=[^;]+/);
  });
});
