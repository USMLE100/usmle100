import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { readChapter } from './reader';
import { SIGNUP, cookies, makeOwner } from './owner';
import { verifyAuditChain } from '../src/lib/audit';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PASSWORD = 'correct-horse-battery';

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; ip?: string; referer?: string } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE, 'cf-connecting-ip': opts.ip ?? '203.0.113.9' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.referer) headers.referer = BASE + opts.referer;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) {
    init.method = 'POST';
    init.body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  return worker.fetch(new Request(BASE + path, init));
}
const cookieOf = (res: Response) => cookies(res);
const loc = (res: Response) => res.headers.get('location') ?? '';

let n = 0;
type Role = 'student' | 'faculty' | 'admin' | 'owner';
async function account(role: Role = 'student', pkg: string | null = 'max') {
  const email = `os${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD }, ip: `198.51.100.${(n % 200) + 1}` });
  const cookie = cookieOf(res);
  browser.set(email, cookie.split('; ').filter((c) => c.startsWith('u100_device=')).join('; '));
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  if (role === 'student' && pkg) await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at) VALUES (?, ?, 'active', datetime('now'))").bind(id, pkg).run();
  return { email, cookie, id };
}
const browser = new Map<string, string>();
const signIn = async (email: string) => cookieOf(await req('/sign-in', { form: { email, password: PASSWORD }, ip: '192.0.2.200', cookie: browser.get(email) }));
const sessionsOf = async (id: number) => (await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(id).first<{ n: number }>())!.n;
const statusOf = async (id: number) => (await db.prepare('SELECT status FROM users WHERE id = ?').bind(id).first<{ status: string }>())!.status;

/** Owner-only POSTs and a harmless body for each. */
const OWNER_ONLY: [string, Record<string, string>][] = [
  ['/admin/settings', { student_count: 'hacked' }],
  ['/admin/team', { email: 'nobody@example.com', role: 'admin' }],
  ['/admin/book-access', { email: 'nobody@example.com' }],
  ['/admin/book-access/remove', { user_id: '999999' }],
  ['/admin/evening/access', { email: 'nobody@example.com', start: '2027-01-04', months: '1' }],
  ['/admin/students/999999/restore', {}],
  ['/admin/students/999999/lectures', { until: '2099-01-01' }],
  ['/admin/security/lockdown', { on: '0' }],
  ['/admin/security/reinstate', { user_id: '999999' }],
  ['/admin/agreement', { title: 'X', body: 'x' }],
];

describe('owner-only administration (R021, R164)', () => {
  it('students and faculty get "not found"; admins who are not the owner are refused', async () => {
    const student = await account('student');
    const faculty = await account('faculty');
    const admin = await account('admin');
    for (const [path, form] of OWNER_ONLY) {
      expect((await req(path, { cookie: student.cookie, form })).status, `student ${path}`).toBe(404);
      expect((await req(path, { cookie: faculty.cookie, form })).status, `faculty ${path}`).toBe(404);
      expect((await req(path, { cookie: admin.cookie, form })).status, `admin ${path}`).toBe(403);
    }
    expect((await db.prepare("SELECT value FROM settings WHERE key = 'student_count'").first<{ value: string }>())?.value).not.toBe('hacked');
    const denied = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'owner.denied' AND actor_id = ?").bind(admin.id).first<{ n: number }>();
    expect(denied!.n).toBe(OWNER_ONLY.length);
  });

  it('the owner must re-enter their password before an owner-only change', async () => {
    const owner = await account('owner');
    await db.prepare('UPDATE sessions SET reauth_at = NULL WHERE user_id = ?').bind(owner.id).run();
    const first = await req('/admin/settings', { cookie: owner.cookie, form: { student_count: '123' }, referer: '/admin/settings' });
    expect(first.status).toBe(302);
    expect(loc(first)).toBe('/admin/confirm?next=%2Fadmin%2Fsettings');
    expect((await req('/admin/confirm', { cookie: owner.cookie, form: { password: 'wrong-wrong-wrong', next: '/admin/settings' } })).status).toBe(401);
    const ok = await req('/admin/confirm', { cookie: owner.cookie, form: { password: PASSWORD, next: '/admin/settings' } });
    expect(loc(ok)).toBe('/admin/settings');
    expect((await req('/admin/security/lockdown', { cookie: owner.cookie, form: { on: '0' } })).status).toBe(302);
    // Confirmation lapses after 15 minutes.
    await db.prepare('UPDATE sessions SET reauth_at = reauth_at - 901 WHERE user_id = ?').bind(owner.id).run();
    expect(loc(await req('/admin/security/lockdown', { cookie: owner.cookie, form: { on: '0' } }))).toContain('/admin/confirm');
  });

  it('an admin cannot confirm as owner, and only staff see the security page', async () => {
    const admin = await account('admin');
    expect((await req('/admin/confirm', { cookie: admin.cookie })).status).toBe(403);
    expect((await req('/admin/security', { cookie: admin.cookie })).status).toBe(200);
    expect((await req('/admin/security', { cookie: (await account('faculty')).cookie })).status).toBe(404);
    expect((await req('/admin/security', { cookie: (await account('student')).cookie })).status).toBe(404);
  });

  it('staff changes are written to the tamper-evident log', async () => {
    const owner = await account('owner');
    const s = await account('student', null);
    await req('/admin/team', { cookie: owner.cookie, form: { email: s.email, role: 'faculty' } });
    const e = await db.prepare("SELECT detail FROM audit_log WHERE action = 'admin.post' AND actor_id = ? ORDER BY id DESC").bind(owner.id).first<{ detail: string }>();
    expect(JSON.parse(e!.detail)).toMatchObject({ path: '/admin/team', email: s.email, role: 'faculty' });
    expect((await verifyAuditChain(db)).ok).toBe(true);
    // Editing an entry breaks the chain.
    const victim = await db.prepare('SELECT id, detail FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 1').first<{ id: number; detail: string }>();
    await db.prepare("UPDATE audit_log SET detail = 'edited' WHERE id = ?").bind(victim!.id).run();
    const broken = await verifyAuditChain(db);
    expect(broken.ok).toBe(false);
    await db.prepare('UPDATE audit_log SET detail = ? WHERE id = ?').bind(victim!.detail, victim!.id).run();
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});

describe('sessions (R088–R091)', () => {
  it('ends after 30 minutes without activity and says why', async () => {
    const s = await account('student');
    await db.prepare('UPDATE sessions SET last_seen_at = last_seen_at - 1801 WHERE user_id = ?').bind(s.id).run();
    const res = await req('/dashboard', { cookie: s.cookie });
    expect(loc(res)).toContain('ended=idle');
    expect(await sessionsOf(s.id)).toBe(0);
    expect(await (await req('/sign-in?ended=idle')).text()).toContain('30 minutes without activity');
  });

  it('ends 24 hours after sign-in even when active', async () => {
    const s = await account('student');
    await db.prepare('UPDATE sessions SET created_at = created_at - 86401 WHERE user_id = ?').bind(s.id).run();
    expect(loc(await req('/dashboard', { cookie: s.cookie }))).toContain('ended=expired');
  });

  it('checking the timer does not count as activity; "Stay logged in" does', async () => {
    const s = await account('student');
    await db.prepare('UPDATE sessions SET last_seen_at = last_seen_at - 1600 WHERE user_id = ?').bind(s.id).run();
    const st = (await (await req('/session/status', { cookie: s.cookie })).json()) as any;
    expect(st.idleLeft).toBeLessThanOrEqual(200);
    expect(st.absoluteLeft).toBeGreaterThan(86000);
    const again = (await (await req('/session/status', { cookie: s.cookie })).json()) as any;
    expect(again.idleLeft).toBeLessThanOrEqual(200);
    const ping = (await (await req('/session/ping', { cookie: s.cookie, form: {} })).json()) as any;
    expect(ping.idleLeft).toBe(1800);
    expect((await req('/session/status')).status).toBe(401);
  });

  it('the portal page carries the inactivity warning', async () => {
    const s = await account('student');
    const html = await (await req('/dashboard', { cookie: s.cookie })).text();
    expect(html).toContain('id="sess-modal"');
    expect(html).toContain('Stay logged in');
  });
});

describe('passwords (R094)', () => {
  it('needs 12 characters and refuses breached passwords, at sign-up and reset', async () => {
    const short = await req('/sign-up', { form: { ...SIGNUP, email: `short${Date.now()}@example.com`, password: 'elevenchars' } });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain('at least 12 characters');
    const breached = await req('/sign-up', { form: { ...SIGNUP, email: `br${Date.now()}@example.com`, password: 'password12345' } });
    expect(breached.status).toBe(400);
    expect(await breached.text()).toContain('data breach');
    expect((await req('/sign-up', { form: { ...SIGNUP, email: `ok${Date.now()}@example.com`, password: 'a long passphrase here' } })).status).toBe(302);
  });
});

describe('suspension and warnings (R003, R149)', () => {
  it('an admin suspends a student: signed out, blocked everywhere but public pages, until the owner reinstates', async () => {
    const admin = await account('admin');
    const owner = await account('owner');
    const s = await account('student');
    expect(loc(await req('/admin/security/status', { cookie: admin.cookie, form: { email: s.email, status: 'suspended', reason: 'Shared login' } }))).toBe('/admin/security?ok=1');
    expect(await sessionsOf(s.id)).toBe(0);
    const c = await signIn(s.email);
    expect(loc(await req('/dashboard', { cookie: c }))).toBe('/account/suspended');
    expect(loc(await req('/lectures', { cookie: c }))).toBe('/account/suspended');
    expect(loc(await req('/course-book', { cookie: c }))).toBe('/account/suspended');
    const page = await req('/account/suspended', { cookie: c });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('Shared login');
    expect((await req('/', { cookie: c })).status).toBe(200);
    // Only the owner reinstates.
    expect((await req('/admin/security/reinstate', { cookie: admin.cookie, form: { user_id: String(s.id) } })).status).toBe(403);
    await req('/admin/security/reinstate', { cookie: owner.cookie, form: { user_id: String(s.id) } });
    expect(await statusOf(s.id)).toBe('active');
    expect((await req('/dashboard', { cookie: c })).status).toBe(200);
  });

  it('the owner cannot be suspended, and admins cannot suspend other staff', async () => {
    const admin = await account('admin');
    const owner = await account('owner');
    const faculty = await account('faculty');
    expect(loc(await req('/admin/security/status', { cookie: admin.cookie, form: { email: owner.email, status: 'suspended', reason: 'x' } }))).toContain('error=');
    expect(loc(await req('/admin/security/status', { cookie: admin.cookie, form: { email: faculty.email, status: 'suspended', reason: 'x' } }))).toContain('error=');
    expect(await statusOf(owner.id)).toBe('active');
    expect(await statusOf(faculty.id)).toBe('active');
    // Students and faculty cannot use the tool at all.
    expect((await req('/admin/security/status', { cookie: faculty.cookie, form: { email: admin.email, status: 'suspended', reason: 'x' } })).status).toBe(404);
  });

  it('a warned student must acknowledge the warning before continuing', async () => {
    const admin = await account('admin');
    const s = await account('student');
    await req('/admin/security/status', { cookie: admin.cookie, form: { email: s.email, status: 'warned', reason: 'Two devices at once' } });
    expect(loc(await req('/dashboard', { cookie: s.cookie }))).toBe('/account/notice');
    expect(await (await req('/account/notice', { cookie: s.cookie })).text()).toContain('Two devices at once');
    await req('/account/notice', { cookie: s.cookie, form: {} });
    expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
    expect((await db.prepare('SELECT warnings FROM users WHERE id = ?').bind(s.id).first<{ warnings: number }>())!.warnings).toBe(1);
  });
});

describe('emergency lockdown (R023)', () => {
  it('signs students out and closes student areas; public pages, checkout and staff keep working', async () => {
    const owner = await account('owner');
    const faculty = await account('faculty');
    const s = await account('student');
    await req('/admin/security/lockdown', { cookie: owner.cookie, form: { on: '1' } });
    try {
      expect(await sessionsOf(s.id)).toBe(0);
      expect(await sessionsOf(faculty.id)).toBe(1);
      const c = await signIn(s.email);
      expect(loc(await req('/dashboard', { cookie: c }))).toBe('/account/unavailable');
      expect(loc(await req('/lectures', { cookie: c }))).toBe('/account/unavailable');
      expect((await req('/', { cookie: c })).status).toBe(200);
      expect((await req('/programs')).status).toBe(200);
      expect(loc(await req('/enroll', { cookie: c }))).not.toContain('/account/unavailable');
      expect((await req('/admin/lectures', { cookie: faculty.cookie })).status).toBe(200);
    } finally {
      await req('/admin/security/lockdown', { cookie: owner.cookie, form: { on: '0' } });
    }
    const c2 = await signIn(s.email);
    expect((await req('/dashboard', { cookie: c2 })).status).toBe(200);
  });
});

describe('student agreement (R012, R014)', () => {
  const TEXT = 'I will not share my account, record lectures or copy the Course Book. '.repeat(3);
  it('students sign the latest material version; staff are exempt; minor edits do not re-ask', async () => {
    const owner = await account('owner');
    const admin = await account('admin');
    const faculty = await account('faculty');
    const s = await account('student');
    expect((await req('/admin/agreement', { cookie: admin.cookie, form: { title: 'Agreement', body: TEXT, material: '1' } })).status).toBe(403);
    await req('/admin/agreement', { cookie: owner.cookie, form: { title: 'Agreement', body: TEXT, material: '1' } });
    try {
      expect(loc(await req('/dashboard', { cookie: s.cookie }))).toBe('/agreement?next=%2Fdashboard');
      expect((await req('/admin/lectures', { cookie: faculty.cookie })).status).toBe(200);
      const page = await (await req('/agreement', { cookie: s.cookie })).text();
      const version = /name="version" value="(\d+)"/.exec(page)![1];
      const base = { version, legal_name: 'Test Student', accept: '1', next: '/dashboard' };
      const young = new Date(Date.now() - 17 * 365.25 * 86400e3).toISOString().slice(0, 10);
      const under = await req('/agreement', { cookie: s.cookie, form: { ...base, birth_date: young } });
      expect(under.status).toBe(400);
      expect(await under.text()).toContain('18 or older');
      expect((await req('/agreement', { cookie: s.cookie, form: { ...base, birth_date: '1995-06-15', accept: '' } })).status).toBe(400);
      expect(loc(await req('/agreement', { cookie: s.cookie, form: { ...base, birth_date: '1995-06-15' } }))).toBe('/dashboard');
      expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
      const sig = await db.prepare('SELECT legal_name, email, birth_date, body_hash, ip FROM agreement_signatures WHERE user_id = ?').bind(s.id).first<any>();
      expect(sig).toMatchObject({ legal_name: 'Test Student', email: s.email, birth_date: '1995-06-15', ip: '203.0.113.9' });
      expect(sig.body_hash).toMatch(/^[0-9a-f]{64}$/);
      // A minor correction does not ask again; a material change does.
      await req('/admin/agreement', { cookie: owner.cookie, form: { title: 'Agreement', body: TEXT + ' Typo fixed.', material: '' } });
      expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
      await req('/admin/agreement', { cookie: owner.cookie, form: { title: 'Agreement', body: TEXT + ' New rule.', material: '1' } });
      expect(loc(await req('/dashboard', { cookie: s.cookie }))).toContain('/agreement');
    } finally {
      // Leave other tests unaffected.
      await db.prepare('DELETE FROM agreement_signatures').run();
      await db.prepare('DELETE FROM agreements').run();
    }
  });
});

describe('paid lectures stay within the student’s cohort', () => {
  it('a student cannot open, save or complete another cohort’s lecture; staff can open it', async () => {
    const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
    const a = await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Cohort A', ymd(-10)).run();
    const b = await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Cohort B', ymd(-20)).run();
    const own = await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status) VALUES (?, 1, 'Own lecture', 'live')").bind(a.meta.last_row_id).run();
    const other = await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status) VALUES (?, 1, 'Other cohort lecture', 'live')").bind(b.meta.last_row_id).run();
    const s = await account('student', null);
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(s.id, a.meta.last_row_id).run();
    const c = await signIn(s.email);
    expect((await req(`/lectures/${own.meta.last_row_id}`, { cookie: c })).status).toBe(200);
    expect((await req(`/lectures/${other.meta.last_row_id}`, { cookie: c })).status).toBe(404);
    await req(`/lectures/${other.meta.last_row_id}/done`, { cookie: c, form: {} });
    await req(`/lectures/${other.meta.last_row_id}/save`, { cookie: c, form: {} });
    expect(await db.prepare('SELECT 1 FROM lecture_progress WHERE user_id = ? AND lecture_id = ?').bind(s.id, other.meta.last_row_id).first()).toBeNull();
    expect(await db.prepare('SELECT 1 FROM lecture_bookmarks WHERE user_id = ? AND lecture_id = ?').bind(s.id, other.meta.last_row_id).first()).toBeNull();
    await req(`/lectures/${own.meta.last_row_id}/done`, { cookie: c, form: {} });
    expect(await db.prepare('SELECT 1 FROM lecture_progress WHERE user_id = ? AND lecture_id = ?').bind(s.id, own.meta.last_row_id).first()).not.toBeNull();
    const faculty = await account('faculty');
    expect((await req(`/lectures/${other.meta.last_row_id}`, { cookie: faculty.cookie })).status).toBe(200);
  });
});

describe('Course Book is view-only (R005)', () => {
  it('no download links are offered', async () => {
    const s = await account('student');
    const html = await (await req('/course-book', { cookie: s.cookie })).text();
    expect(html).not.toContain('download=1');
    expect(html).not.toContain('downloadable');
  });
});

describe('Course Book reader (R005–R007)', () => {
  it('each reading session fetches the chapter once, scrambled, and stamps the student on the page', async () => {
    const owner = await account('owner');
    const fd = new FormData();
    fd.set('number', '91');
    fd.set('title', 'Reader chapter');
    fd.set('live', '1');
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    fd.set('pdf', new File([pdf], 'r.pdf', { type: 'application/pdf' }));
    await worker.fetch(new Request(BASE + '/admin/book', { method: 'POST', body: fd, headers: { cookie: owner.cookie, 'sec-fetch-site': 'same-origin', origin: BASE }, redirect: 'manual' }));
    const ch = (await db.prepare("SELECT id FROM book_chapters WHERE title = 'Reader chapter'").first<{ id: number }>())!;
    const s = await account('student', 'max');
    const r = await readChapter(req, s.cookie, ch.id);
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual(pdf);
    // What travels over the network is not a usable PDF.
    expect(new TextDecoder().decode(r.raw!.slice(0, 4))).not.toBe('%PDF');
    expect(r.html).toContain('data-name="Test Student"');
    expect(r.html).toContain(`data-account="${s.id}"`);
    expect(r.html).not.toContain('download');
    // The same session cannot fetch again, and another student cannot use it.
    expect((await req(`/course-book/${ch.id}/data?s=${r.session}`, { cookie: s.cookie })).status).toBe(410);
    const other = await account('student', 'max');
    expect((await req(`/course-book/${ch.id}/data?s=${r.session}`, { cookie: other.cookie })).status).toBe(404);
    // The original file is for staff only.
    expect((await req(`/course-book/${ch.id}/pdf`, { cookie: s.cookie })).status).toBe(302);
    expect((await req(`/course-book/${ch.id}/pdf`, { cookie: owner.cookie })).status).toBe(200);
    expect(await db.prepare('SELECT 1 FROM book_view_sessions WHERE id = ? AND user_id = ?').bind(r.session, s.id).first()).not.toBeNull();
  });
});

describe('anti-scraping limits', () => {
  it('opening the Course Book far faster than reading is slowed down and flagged once', async () => {
    const ch = (await db.prepare("SELECT id FROM book_chapters WHERE title = 'Reader chapter'").first<{ id: number }>())!;
    const s = await account('student', 'max');
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await req(`/course-book/${ch.id}/read`, { cookie: s.cookie })).status);
    expect(statuses.slice(0, 6).every((x) => x === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM security_flags WHERE user_id = ? AND kind = 'book_scraping'").bind(s.id).first<any>()).n).toBe(1);
    // Staff aren't limited.
    const f = await account('faculty');
    for (let i = 0; i < 8; i++) expect((await req(`/course-book/${ch.id}/read`, { cookie: f.cookie })).status).toBe(200);
  });
});
