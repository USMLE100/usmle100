import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOwner } from './owner';

// Refunds are issued by the owner in the Stripe Dashboard. The site only reacts to Stripe's charge.refunded event.
// Stripe's API is mocked; nothing reaches Stripe.
const BASE = 'https://usmle100.test';
const WHSEC = 'whsec_test_not_real';
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

let n = 0;
async function account(pkg: string | null = null, role = 'student') {
  const email = `refund${++n}@example.com`;
  const res = await req('/sign-up', { form: { name: 'Refund Test', email, password: 'correct-horse-battery' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const u = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!;
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, u.id).run();
  if (pkg) await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at) VALUES (?, ?, 'active', datetime('now'))").bind(u.id, pkg).run();
  return { cookie, id: u.id, email };
}

async function sign(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
async function webhook(object: Record<string, unknown>, type = 'checkout.session.completed') {
  const payload = JSON.stringify({ id: 'evt_' + Math.random(), type, data: { object } });
  return worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload) } }));
}

let created: URLSearchParams[] = [];
let sessionsByPi: Record<string, string[]> = {};
let sid = 0;
let stripeCalls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  created = [];
  stripeCalls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.stripe.com/')) stripeCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
      created.push(new URLSearchParams(String(init.body)));
      const id = `cs_refund_${++sid}`;
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
    }
    const list = url.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\?payment_intent=([^&]+)/);
    if (list) return new Response(JSON.stringify({ data: (sessionsByPi[decodeURIComponent(list[1])] ?? []).map((id) => ({ id })) }), { status: 200 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const hasBookAccess = async (userId: number) => !!(await db.prepare('SELECT 1 FROM book_access WHERE user_id = ?').bind(userId).first());
const charge = (pi: string, amount: number, refunded: number, id = 'ch_' + pi) => ({ id, payment_intent: pi, amount, amount_refunded: refunded, refunded: refunded >= amount });

/** Buy the Course Book through a (mocked) Stripe Checkout and a verified webhook. */
async function buyBook(cookie: string, pi: string) {
  const res = await req('/buy/course-book', { cookie, form: {} });
  const session = res.headers.get('location')!.split('/').pop()!;
  const ref = created.at(-1)!.get('client_reference_id')!;
  await webhook({ id: session, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: ref, payment_intent: pi });
  return { session, purchaseId: Number(ref.slice(5)) };
}
async function buyPackage(cookie: string, pkg: string, pi: string) {
  const res = await req(`/enroll/${pkg}`, { cookie, form: {} });
  const session = res.headers.get('location')!.split('/').pop()!;
  const ref = created.at(-1)!.get('client_reference_id')!;
  const price = (await db.prepare('SELECT price_cents FROM packages WHERE id = ?').bind(pkg).first<{ price_cents: number }>())!.price_cents;
  await webhook({ id: session, payment_status: 'paid', amount_total: price, currency: 'usd', client_reference_id: ref, payment_intent: pi });
  return { session, enrollmentId: Number(ref), price };
}

describe('the site never starts a refund', () => {
  it('there is no refund route, and refund handling never calls Stripe to refund', async () => {
    const s = await account('refresher');
    for (const p of ['/refund', '/refunds/request', '/buy/course-book/refund']) {
      expect((await req(p, { cookie: s.cookie, form: {} })).status, p).toBe(404);
    }
    // "/enroll/<name>" is the package checkout; an unknown name just sends an enrolled student home.
    expect((await req('/enroll/refund', { cookie: s.cookie, form: {} })).headers.get('location')).toBe('/dashboard');
    const { purchaseId } = await buyBook(s.cookie, 'pi_never');
    await webhook(charge('pi_never', 19900, 19900), 'charge.refunded');
    expect(stripeCalls.filter((c) => c.includes('/refunds'))).toEqual([]);
    expect(purchaseId).toBeGreaterThan(0);
  });
});

describe('a full refund issued in Stripe removes only that purchase’s access', () => {
  it('Course Book: full refund revokes; partial does not; repeats are harmless; admin can restore', async () => {
    const s = await account('refresher');
    const { purchaseId } = await buyBook(s.cookie, 'pi_book1');
    expect(await hasBookAccess(s.id)).toBe(true);

    // Partial refund: access stays.
    await webhook(charge('pi_book1', 19900, 5000), 'charge.refunded');
    expect(await hasBookAccess(s.id)).toBe(true);
    expect((await req('/course-book', { cookie: s.cookie })).status).toBe(200);

    // Full refund: access removed, purchase marked refunded, PDF pages closed.
    await webhook(charge('pi_book1', 19900, 19900), 'charge.refunded');
    expect(await hasBookAccess(s.id)).toBe(false);
    expect((await db.prepare('SELECT status FROM book_purchases WHERE id = ?').bind(purchaseId).first<{ status: string }>())!.status).toBe('refunded');
    expect(await (await req('/course-book', { cookie: s.cookie })).text()).toContain('$199');

    // The owner decides to give it back; a duplicate refund notification and a replayed payment change nothing.
    const admin = await account(null, 'owner');
    await req('/admin/book-access', { cookie: admin.cookie, form: { email: s.email, note: 'Restored by owner' } });
    expect(await hasBookAccess(s.id)).toBe(true);
    await webhook(charge('pi_book1', 19900, 19900), 'charge.refunded');
    await webhook({ id: (await db.prepare('SELECT stripe_session_id FROM book_purchases WHERE id = ?').bind(purchaseId).first<{ stripe_session_id: string }>())!.stripe_session_id, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: `book-${purchaseId}`, payment_intent: 'pi_book1' });
    expect(await hasBookAccess(s.id)).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM stripe_refunds WHERE payment_intent = 'pi_book1'").first<{ n: number }>())!.n).toBe(1);
  });

  it('Course Book refund keeps an earlier admin grant and a package that includes the book', async () => {
    // A student with an admin grant who also paid: the refund leaves the grant.
    const a = await account('refresher');
    const { purchaseId } = await buyBook(a.cookie, 'pi_book2');
    await db.prepare("UPDATE book_access SET note = 'Given by admin' WHERE user_id = ?").bind(a.id).run();
    await webhook(charge('pi_book2', 19900, 19900), 'charge.refunded');
    expect(await hasBookAccess(a.id)).toBe(true);
    expect((await db.prepare('SELECT status FROM book_purchases WHERE id = ?').bind(purchaseId).first<{ status: string }>())!.status).toBe('refunded');

    // A Companion student keeps the book through their package even with no book_access row.
    const c = await account('companion');
    const pdfPage = await req('/course-book', { cookie: c.cookie });
    expect(pdfPage.status).toBe(200);
    expect(await pdfPage.text()).not.toContain('$199');
  });

  it('Package: full refund removes that program only; partial keeps it; admin can restore', async () => {
    const s = await account(null);
    const { enrollmentId, price } = await buyPackage(s.cookie, 'companion', 'pi_pkg1');
    expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
    const status = async () => (await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(enrollmentId).first<{ status: string }>())!.status;

    await webhook(charge('pi_pkg1', price, 10000), 'charge.refunded');
    expect(await status()).toBe('active');

    await webhook(charge('pi_pkg1', price, price), 'charge.refunded');
    expect(await status()).toBe('refunded');
    expect((await req('/dashboard', { cookie: s.cookie })).headers.get('location')).toBe('/enroll');
    // The package's Course Book and Evening Questions go with it.
    expect((await req('/course-book', { cookie: s.cookie })).headers.get('location')).toBe('/enroll');

    // A replayed payment event cannot reactivate it.
    const sess = (await db.prepare('SELECT stripe_session_id FROM enrollments WHERE id = ?').bind(enrollmentId).first<{ stripe_session_id: string }>())!.stripe_session_id;
    await webhook({ id: sess, payment_status: 'paid', amount_total: price, currency: 'usd', client_reference_id: String(enrollmentId), payment_intent: 'pi_pkg1' });
    expect(await status()).toBe('refunded');

    // Only an admin can restore it (faculty and students can't), and a repeat refund notice doesn't undo that.
    const fac = await account(null, 'faculty');
    expect((await req(`/admin/students/${enrollmentId}/restore`, { cookie: fac.cookie, form: {} })).status).toBe(404);
    expect((await req(`/admin/students/${enrollmentId}/restore`, { cookie: s.cookie, form: {} })).status).toBe(404);
    expect(await status()).toBe('refunded');
    const admin = await account(null, 'owner');
    expect(await (await req('/admin/students', { cookie: admin.cookie })).text()).toContain('Refunded programs');
    await req(`/admin/students/${enrollmentId}/restore`, { cookie: admin.cookie, form: {} });
    expect(await status()).toBe('active');
    await webhook(charge('pi_pkg1', price, price), 'charge.refunded');
    expect(await status()).toBe('active');
  });

  it('a refund of one purchase leaves the student’s other purchases alone', async () => {
    const s = await account(null);
    await buyPackage(s.cookie, 'refresher', 'pi_pkg2');
    await buyBook(s.cookie, 'pi_book3');
    expect(await hasBookAccess(s.id)).toBe(true);
    await webhook(charge('pi_book3', 19900, 19900), 'charge.refunded');
    expect(await hasBookAccess(s.id)).toBe(false);
    expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
  });

  it('a refund for a purchase saved before payments were remembered is matched through Stripe', async () => {
    const s = await account('refresher');
    const { session, purchaseId } = await buyBook(s.cookie, 'pi_old');
    await db.prepare('UPDATE book_purchases SET payment_intent = NULL WHERE id = ?').bind(purchaseId).run();
    sessionsByPi['pi_old'] = [session];
    await webhook(charge('pi_old', 19900, 19900), 'charge.refunded');
    expect(await hasBookAccess(s.id)).toBe(false);
  });

  it('refund events need a valid Stripe signature, and unknown charges change nothing', async () => {
    const s = await account('refresher');
    await buyBook(s.cookie, 'pi_sig');
    const payload = JSON.stringify({ id: 'evt_x', type: 'charge.refunded', data: { object: charge('pi_sig', 19900, 19900) } });
    const forged = await worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': 't=1,v1=00' } }));
    expect(forged.status).toBe(400);
    expect(await hasBookAccess(s.id)).toBe(true);
    expect((await webhook(charge('pi_unknown', 5000, 5000), 'charge.refunded')).status).toBe(200);
    expect(await hasBookAccess(s.id)).toBe(true);
  });
});
