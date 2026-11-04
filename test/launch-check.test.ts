import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';

// Owner-only, read-only launch check page.
const BASE = 'https://usmle100.test';
const db = (env as any).DB as D1Database;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
afterEach(() => vi.restoreAllMocks());
let n = 0;
async function acct(role: 'student' | 'admin' | 'owner') {
  const email = `lc${++n}-${Date.now()}@example.com`;
  const r = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
  if (role === 'owner') await makeOwner(db, email);
  if (role === 'admin') await db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(email).run();
  return cookies(r);
}
const get = (cookie: string) => worker.fetch(new Request(BASE + '/admin/launch-check', { headers: { cookie }, redirect: 'manual' }));

describe('launch check page', () => {
  it('only the owner sees it; it reports content, holidays, payment links and lectures without changing anything', async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('staff_passkeys', '0') ON CONFLICT (key) DO UPDATE SET value = '0'").run();
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://api.stripe.com/')) {
        calls.push({ url, method: init?.method ?? 'GET' });
        return new Response(JSON.stringify({ data: [{ id: 'plink_1', url: 'https://buy.stripe.com/old123', created: 1700000000 }] }));
      }
      return realFetch(input, init);
    });
    expect((await worker.fetch(new Request(BASE + '/admin/launch-check', { redirect: 'manual' }))).status).toBe(302); // signed out
    const student = await acct('student');
    expect((await get(student)).status).not.toBe(200);
    const admin = await acct('admin');
    expect((await get(admin)).status).toBe(404);
    const owner = await acct('owner');
    const before = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
    const r = await get(owner);
    expect(r.status).toBe(200);
    const html = await r.text();
    // Reachable from the owner's admin menu, and typed variants lead to it.
    const menu = await (await worker.fetch(new Request(BASE + '/admin/lectures', { headers: { cookie: owner } }))).text();
    expect(menu).toContain('href="/admin/launch-check"');
    const adminMenu = await (await worker.fetch(new Request(BASE + '/admin/lectures', { headers: { cookie: admin } }))).text();
    expect(adminMenu).not.toContain('href="/admin/launch-check"');
    for (const v of ['/admin/launch-check/', '/admin/launchcheck']) expect((await worker.fetch(new Request(BASE + v, { headers: { cookie: owner }, redirect: 'manual' }))).headers.get('location'), v).toBe('/admin/launch-check');
    for (const s of ['Question bank and Course Book', 'holidays', 'Thanksgiving', 'Active Stripe Payment Links', 'https://buy.stripe.com/old123', 'Lectures so far', 'QA test setup']) expect(html, s).toContain(s);
    // Read-only: only a GET list of payment links reaches Stripe; nothing is written.
    expect(calls).toEqual([{ url: 'https://api.stripe.com/v1/payment_links?active=true&limit=100', method: 'GET' }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())!.n).toBe(before!.n);
    await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
  });
});
