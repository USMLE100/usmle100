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
        // Stripe's real Payment Link shape: no 'created' field (this once crashed the page in production).
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'plink_1', object: 'payment_link', active: true, url: 'https://buy.stripe.com/old123', livemode: true, metadata: {} }], has_more: false }));
      }
      return realFetch(input, init);
    });
    expect((await worker.fetch(new Request(BASE + '/admin/launch-check', { redirect: 'manual' }))).status).toBe(302); // signed out
    const student = await acct('student');
    expect((await get(student)).status).not.toBe(200);
    const admin = await acct('admin');
    expect((await get(admin)).status).toBe(404);
    // Production has the QA cohort with viewing records: the page must render them (this section once failed in production).
    const qaC = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('QA test (owner only - not for students)', '2026-09-07')").run()).meta.last_row_id);
    const qaL = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'QA', 'live', 'vid-qa', 300)").bind(qaC).run()).meta.last_row_id);
    const anyUser = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first<{ id: number }>())!.id;
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO view_sessions (id, user_id, item, kind, enrollment_id, created_at, started_at, expires_at, last_beat_at, duration, watched_seconds, counted, counted_reason) VALUES ('QAVIEW1', ?, ?, 'paid', NULL, ?, ?, ?, ?, 300, 271, 1, '65%'), ('QAVIEW2', ?, ?, 'paid', NULL, ?, ?, ?, ?, 300, 120, 0, NULL)")
      .bind(anyUser, `L:${qaL}`, now - 900, now - 890, now - 890 + 86400, now - 600, anyUser, `L:${qaL}`, now - 500, now - 490, now - 490 + 86400, now - 300).run();
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
    for (const s of ['QAVIEW1', '271 s of 300 s (90%)', 'yes (65% reached)', 'Question bank and Course Book', 'holidays', 'Thanksgiving', 'Active Stripe Payment Links', 'https://buy.stripe.com/old123', 'Lectures so far', 'QA test setup']) expect(html, s).toContain(s);
    // Read-only: only a GET list of payment links reaches Stripe; nothing is written.
    expect(calls).toEqual([{ url: 'https://api.stripe.com/v1/payment_links?active=true&limit=100', method: 'GET' }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())!.n).toBe(before!.n);
    await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
  });
});

describe('payment link audit', () => {
  it('owner only; lists each link with price and buyers matched to site access; only GETs reach Stripe', async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('staff_passkeys', '0') ON CONFLICT (key) DO UPDATE SET value = '0'").run();
    const buyer = `linkbuyer-${Date.now()}@example.com`;
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.stripe.com/')) return realFetch(input, init);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/payment_links')) return new Response(JSON.stringify({ data: [
        { id: 'plink_course', url: 'https://buy.stripe.com/c1', metadata: {}, after_completion: { type: 'hosted_confirmation' }, line_items: { data: [{ description: '100-Day Course', price: { unit_amount: 138150, recurring: null } }] } },
        { id: 'plink_tutor', url: 'https://buy.stripe.com/t1', metadata: {}, after_completion: { type: 'redirect', redirect: { url: 'https://calendly.com/x' } }, line_items: { data: [{ description: 'Tutoring', price: { unit_amount: 4999, recurring: null } }] } },
      ] }));
      if (url.includes('payment_link=plink_course')) return new Response(JSON.stringify({ data: [{ id: 'cs_live_abc123456789', created: 1793900000, amount_total: 138150, payment_status: 'paid', mode: 'payment', customer_details: { email: buyer.toUpperCase(), name: 'Link Buyer' } }], has_more: false }));
      return new Response(JSON.stringify({ data: [], has_more: false }));
    });
    const stu = await acct('student');
    await db.prepare("UPDATE users SET email = ? WHERE id = (SELECT MAX(id) FROM users)").bind(buyer).run();
    const admin = await acct('admin');
    expect((await worker.fetch(new Request(BASE + '/admin/payment-links', { headers: { cookie: admin }, redirect: 'manual' }))).status).toBe(404);
    expect((await worker.fetch(new Request(BASE + '/admin/payment-links', { headers: { cookie: stu }, redirect: 'manual' }))).status).not.toBe(200);
    // Faculty, signed-out visitors, HEAD and POST requests get nothing either.
    const facCookie = await acct('student');
    await db.prepare("UPDATE users SET role = 'faculty' WHERE id = (SELECT MAX(id) FROM users)").run();
    for (const ck of [facCookie, '']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const r = await worker.fetch(new Request(BASE + '/admin/payment-links', { method, headers: { cookie: ck, origin: BASE, 'sec-fetch-site': 'same-origin' }, redirect: 'manual' }));
        expect(r.status, `${method} ${ck ? 'faculty' : 'signed out'}`).not.toBe(200);
        expect(await r.text()).not.toContain('Link Buyer');
      }
    }
    const owner = await acct('owner');
    const before = await db.prepare('SELECT (SELECT COUNT(*) FROM enrollments) + (SELECT COUNT(*) FROM audit_log) AS n').first<{ n: number }>();
    const r = await worker.fetch(new Request(BASE + '/admin/payment-links', { headers: { cookie: owner } }));
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const s of ['plink_course', '$1,381.50 one-time', '100-Day Course', 'Link Buyer', 'account exists, no access given', 'plink_tutor', 'redirects to https://calendly.com/x', 'No completed payments.']) expect(html, s).toContain(s);
    expect(calls.every((x) => x.method === 'GET')).toBe(true);
    // No payment credentials or full Stripe ids on the page.
    expect(html).not.toMatch(/sk_(live|test)_|cs_live_abc123456789|last4|card_number/i);
    expect((await db.prepare('SELECT (SELECT COUNT(*) FROM enrollments) + (SELECT COUNT(*) FROM audit_log) AS n').first<{ n: number }>())!.n).toBe(before!.n);
    await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
  });
});
