import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { bunnyEmbedUrl } from '../src/lib/content';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PASSWORD = 'correct-horse-battery';

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE, 'cf-connecting-ip': opts.ip ?? '203.0.113.1' };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) {
    init.method = 'POST';
    init.body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  return worker.fetch(new Request(BASE + path, init));
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

let n = 0;
async function account(role: 'student' | 'faculty' | 'admin' = 'student') {
  const email = `h${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { name: `Person ${n}`, email, password: PASSWORD }, ip: `198.51.100.${n}` });
  if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();
  return { email, cookie: cookieOf(res) };
}
const signIn = (email: string, password: string, ip = '203.0.113.1') => req('/sign-in', { form: { email, password }, ip });

describe('sign-in lockout', () => {
  it('locks an account after 5 wrong passwords until an admin unlocks it, even for the right password (R029)', async () => {
    const { email } = await account();
    for (let i = 0; i < 4; i++) expect((await signIn(email, 'wrong-password-' + i, `192.0.2.${i}`)).status).toBe(401);
    const fifth = await signIn(email, 'wrong-password-4', '192.0.2.4');
    expect(fifth.status).toBe(429);
    expect(await fifth.text()).toContain('until USMLE100 unlocks it');
    const blocked = await signIn(email, PASSWORD, '192.0.2.99');
    expect(blocked.status).toBe(429);
    expect(cookieOf(blocked)).not.toMatch(/u100_session=./);
    expect(await blocked.text()).toContain('Too many sign-in attempts');
  });

  it('does not lock other accounts', async () => {
    const a = await account();
    const b = await account();
    for (let i = 0; i < 5; i++) await signIn(a.email, 'nope-nope-nope', `192.0.2.${10 + i}`);
    const res = await signIn(b.email, PASSWORD, '192.0.2.50');
    expect(res.status).toBe(302);
    expect(cookieOf(res)).toMatch(/^u100_session=./);
  });

  it('stays locked after 15 minutes; works again once an admin unlocks it', async () => {
    const { email } = await account();
    for (let i = 0; i < 5; i++) await signIn(email, 'nope-nope-nope', `192.0.2.${20 + i}`);
    // Even when the timed limit has passed, the account lock remains.
    await db.prepare("UPDATE login_attempts SET locked_until = 1, window_start = 1 WHERE key = 'email:' || ?").bind(email).run();
    expect((await signIn(email, PASSWORD, '192.0.2.60')).status).toBe(429);
    // A student cannot unlock; an admin can.
    const student = await account();
    expect((await req('/admin/security/unlock', { cookie: student.cookie, form: { email } })).status).toBe(404);
    const admin = await account('admin');
    expect((await req('/admin/security/unlock', { cookie: admin.cookie, form: { email } })).status).toBe(302);
    expect((await signIn(email, PASSWORD, '192.0.2.61')).status).toBe(302);
    const log = await db.prepare("SELECT action FROM audit_log WHERE detail LIKE ? ORDER BY id").bind(`%${email}%`).all<{ action: string }>();
    expect(log.results.map((x) => x.action)).toEqual(expect.arrayContaining(['signin.failed', 'signin.locked', 'account.unlocked']));
  });

  it('a correct password clears earlier mistakes', async () => {
    const { email } = await account();
    for (let i = 0; i < 4; i++) await signIn(email, 'nope-nope-nope', `192.0.2.${30 + i}`);
    expect((await signIn(email, PASSWORD, '192.0.2.70')).status).toBe(302);
    for (let i = 0; i < 4; i++) await signIn(email, 'nope-nope-nope', `192.0.2.${40 + i}`);
    expect((await signIn(email, PASSWORD, '192.0.2.71')).status).toBe(302);
  });

  it('treats unknown emails the same, so it does not reveal which accounts exist', async () => {
    const ghost = 'nobody-here@example.com';
    for (let i = 0; i < 4; i++) expect((await signIn(ghost, 'nope-nope-nope', `192.0.2.${80 + i}`)).status).toBe(401);
    expect((await signIn(ghost, 'nope-nope-nope', '192.0.2.84')).status).toBe(429);
    expect((await signIn(ghost, 'nope-nope-nope', '192.0.2.90')).status).toBe(429);
  });

  it('locks one network address after 20 wrong passwords across different emails', async () => {
    const ip = '203.0.113.200';
    for (let i = 0; i < 20; i++) await signIn(`spray${i}@example.com`, 'Password123!', ip);
    const { email } = await account();
    expect((await signIn(email, PASSWORD, ip)).status).toBe(429);
    expect((await signIn(email, PASSWORD, '203.0.113.201')).status).toBe(302);
  });
});

describe('video links are always signed', () => {
  it('gives no player link without the token key', async () => {
    expect(await bunnyEmbedUrl({ BUNNY_LIBRARY_ID: '785730' } as any, 'abc')).toBeNull();
    expect(await bunnyEmbedUrl({ BUNNY_TOKEN_KEY: 'k' } as any, 'abc')).toBeNull();
  });

  it('signs and time-limits the link when the key is set', async () => {
    const url = new URL((await bunnyEmbedUrl({ BUNNY_LIBRARY_ID: '785730', BUNNY_TOKEN_KEY: 'key' } as any, 'abc'))!);
    expect(url.host).toBe('iframe.mediadelivery.net');
    expect(url.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
    const expires = Number(url.searchParams.get('expires'));
    expect(expires).toBeGreaterThan(Date.now() / 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() / 1000 + 3600 + 5);
  });
});

/** Admin makes a link for `email`; returns the link's path. */
async function makeLink(adminCookie: string, email: string) {
  const res = await req('/admin/reset-link', { cookie: adminCookie, form: { email } });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  const m = (await res.text()).match(/https?:\/\/[^\s<"]+\/reset-password\?token=([A-Za-z0-9_-]+)/);
  expect(m).not.toBeNull();
  return { path: '/reset-password?token=' + m![1], token: m![1] };
}

describe('password reset links', () => {
  it('lets the owner set a new password once, and signs out old sessions', async () => {
    const admin = await account('admin');
    const student = await account();
    const { path, token } = await makeLink(admin.cookie, student.email);

    const page = await req(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Choose a new password');

    const done = await req('/reset-password', { form: { token, password: 'brand-new-password-1', again: 'brand-new-password-1' } });
    expect(done.status).toBe(302);
    expect(cookieOf(done)).toMatch(/^u100_session=./);

    // Old sign-in is gone; old password no longer works; new one does.
    expect((await req('/dashboard', { cookie: student.cookie })).headers.get('location')).toContain('/sign-in');
    expect((await signIn(student.email, PASSWORD, '192.0.2.150')).status).toBe(401);
    expect((await signIn(student.email, 'brand-new-password-1', '192.0.2.151')).status).toBe(302);

    // The link cannot be used twice.
    expect((await req(path)).status).toBe(400);
    const again = await req('/reset-password', { form: { token, password: 'another-password-22', again: 'another-password-22' } });
    expect(again.status).toBe(400);
    expect((await signIn(student.email, 'another-password-22', '192.0.2.152')).status).toBe(401);
  });

  it('refuses expired, replaced and made-up links', async () => {
    const admin = await account('admin');
    const student = await account();
    const first = await makeLink(admin.cookie, student.email);
    const second = await makeLink(admin.cookie, student.email);
    expect((await req(first.path)).status).toBe(400); // replaced by the newer link
    await db.prepare('UPDATE password_resets SET expires_at = 1').run();
    expect((await req(second.path)).status).toBe(400); // expired
    expect((await req('/reset-password?token=' + 'x'.repeat(43))).status).toBe(400);
    expect((await req('/reset-password', { form: { token: 'x'.repeat(43), password: 'whatever-12345', again: 'whatever-12345' } })).status).toBe(400);
  });

  it('checks the new password', async () => {
    const admin = await account('admin');
    const student = await account();
    const { token } = await makeLink(admin.cookie, student.email);
    expect((await req('/reset-password', { form: { token, password: 'short', again: 'short' } })).status).toBe(400);
    expect((await req('/reset-password', { form: { token, password: 'long-enough-111', again: 'different-222' } })).status).toBe(400);
    // Mistakes do not use up the link.
    expect((await req('/reset-password', { form: { token, password: 'long-enough-111', again: 'long-enough-111' } })).status).toBe(302);
  });

  it('clears a sign-in lock for that account', async () => {
    const admin = await account('admin');
    const student = await account();
    for (let i = 0; i < 5; i++) await signIn(student.email, 'nope-nope-nope', `192.0.2.${160 + i}`);
    const { token } = await makeLink(admin.cookie, student.email);
    await req('/reset-password', { form: { token, password: 'fresh-password-333', again: 'fresh-password-333' } });
    expect((await signIn(student.email, 'fresh-password-333', '192.0.2.170')).status).toBe(302);
  });

  it('only admins can make links', async () => {
    const student = await account();
    const faculty = await account('faculty');
    for (const who of [student, faculty]) {
      expect((await req('/admin/reset-link', { cookie: who.cookie, form: { email: student.email } })).status).toBe(404);
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(student.email).first('n')).toBe(0);
  });

  it('only stores a hash of the link secret', async () => {
    const admin = await account('admin');
    const student = await account();
    const { token } = await makeLink(admin.cookie, student.email);
    const stored = await db.prepare('SELECT token_hash FROM password_resets ORDER BY created_at DESC, rowid DESC LIMIT 1').first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(token);
  });

  it('the reset page does not pass its address on to other sites', async () => {
    const admin = await account('admin');
    const student = await account();
    const { path } = await makeLink(admin.cookie, student.email);
    const res = await req(path);
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('sign-in page', () => {
  it('tells people how to get a reset link', async () => {
    const html = await (await req('/sign-in')).text();
    expect(html).toContain('Forgot your password?');
  });
});
