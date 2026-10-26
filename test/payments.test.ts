import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Payments: Course Book checkout and package enrollment. Stripe's API is mocked; nothing reaches Stripe.
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
async function student(pkg: string | null = null) {
  const email = `pay${++n}@example.com`;
  const res = await req('/sign-up', { form: { name: 'Pay Test', email, password: 'correct-horse-battery' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const u = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!;
  if (pkg) await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at) VALUES (?, ?, 'active', datetime('now'))").bind(u.id, pkg).run();
  return { cookie, id: u.id, email };
}

async function sign(payload: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
async function webhook(session: Record<string, unknown>, opts: { type?: string; secret?: string } = {}) {
  const payload = JSON.stringify({ id: 'evt_' + Math.random(), type: opts.type ?? 'checkout.session.completed', data: { object: session } });
  return worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload, opts.secret) } }));
}

// Mock Stripe: creating a session returns a fake one; retrieving returns whatever the test set.
let created: URLSearchParams[] = [];
let retrieved: Record<string, any> = {};
let sid = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  created = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
      created.push(new URLSearchParams(String(init.body)));
      const id = `cs_test_${++sid}`;
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
    }
    const m = url.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(.+)$/);
    if (m) return new Response(JSON.stringify(retrieved[decodeURIComponent(m[1])] ?? {}), { status: retrieved[decodeURIComponent(m[1])] ? 200 : 404 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const hasAccess = async (userId: number) => !!(await db.prepare('SELECT 1 FROM book_access WHERE user_id = ?').bind(userId).first());
async function startBookCheckout(cookie: string) {
  const res = await req('/buy/course-book', { cookie, form: {} });
  const p = created.at(-1)!;
  return { res, session: res.headers.get('location')!.split('/').pop()!, ref: p.get('client_reference_id')!, params: p };
}

describe('Course Book checkout', () => {
  it('sends a $199 Stripe Checkout for the right account and unlocks only after a verified paid webhook', async () => {
    const s = await student('refresher');
    const { res, session, ref, params } = await startBookCheckout(s.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('19900');
    expect(params.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(params.get('customer_email')).toBe(s.email);
    expect(ref).toMatch(/^book-\d+$/);
    expect(await hasAccess(s.id)).toBe(false);

    const paid = { id: session, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: ref };
    // A forged webhook (wrong signing secret) is refused.
    expect((await webhook(paid, { secret: 'whsec_wrong' })).status).toBe(400);
    expect(await hasAccess(s.id)).toBe(false);
    // Not yet paid (e.g. a bank payment still processing): no access.
    await webhook({ ...paid, payment_status: 'unpaid' });
    expect(await hasAccess(s.id)).toBe(false);
    // Wrong amount or currency: no access.
    await webhook({ ...paid, amount_total: 100 });
    await webhook({ ...paid, currency: 'eur' });
    expect(await hasAccess(s.id)).toBe(false);
    // A paid session for a different checkout can't unlock this purchase.
    await webhook({ ...paid, id: 'cs_test_other' });
    expect(await hasAccess(s.id)).toBe(false);

    expect((await webhook(paid)).status).toBe(200);
    expect(await hasAccess(s.id)).toBe(true);
    expect((await req('/course-book', { cookie: s.cookie })).status).toBe(200);
  });

  it('a delayed payment unlocks on async_payment_succeeded, and duplicates fulfil only once', async () => {
    const s = await student('refresher');
    const { session, ref } = await startBookCheckout(s.cookie);
    const paid = { id: session, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: ref };
    await webhook({ ...paid, payment_status: 'unpaid' });
    await webhook(paid, { type: 'checkout.session.async_payment_failed' });
    expect(await hasAccess(s.id)).toBe(false);
    await webhook(paid, { type: 'checkout.session.async_payment_succeeded' });
    await webhook(paid, { type: 'checkout.session.async_payment_succeeded' });
    await webhook(paid);
    expect(await hasAccess(s.id)).toBe(true);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM book_purchases WHERE user_id = ? AND status = 'paid'").bind(s.id).first<{ n: number }>();
    expect(rows!.n).toBe(1);
    // If an admin later removes access (e.g. a refund), a replayed webhook does not give it back.
    await db.prepare('DELETE FROM book_access WHERE user_id = ?').bind(s.id).run();
    await webhook(paid);
    expect(await hasAccess(s.id)).toBe(false);
  });

  it('the success page checks Stripe itself, but only for the buyer’s own checkout', async () => {
    const buyer = await student('refresher');
    const other = await student('refresher');
    const { session, ref } = await startBookCheckout(buyer.cookie);
    retrieved[session] = { id: session, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: ref };
    // Someone else opening the buyer's return link gets nothing.
    const stolen = await req(`/buy/course-book/success?session_id=${session}`, { cookie: other.cookie });
    expect(stolen.headers.get('location')).toBe('/buy/course-book?pending=1');
    expect(await hasAccess(other.id)).toBe(false);
    expect(await hasAccess(buyer.id)).toBe(false);
    // An unpaid session leaves the buyer waiting.
    retrieved[session] = { ...retrieved[session], payment_status: 'unpaid' };
    expect((await req(`/buy/course-book/success?session_id=${session}`, { cookie: buyer.cookie })).headers.get('location')).toBe('/buy/course-book?pending=1');
    retrieved[session] = { ...retrieved[session], payment_status: 'paid' };
    expect((await req(`/buy/course-book/success?session_id=${session}`, { cookie: buyer.cookie })).headers.get('location')).toBe('/course-book');
    expect(await hasAccess(buyer.id)).toBe(true);
  });

  it('students who already have the book (package or grant) are not charged again', async () => {
    const max = await student('max');
    const res = await req('/buy/course-book', { cookie: max.cookie, form: {} });
    expect(res.headers.get('location')).toBe('/course-book');
    expect(created.length).toBe(0);
    expect(await db.prepare('SELECT 1 FROM book_purchases WHERE user_id = ?').bind(max.id).first()).toBeNull();
  });

  it('someone with no program who buys the book gets the Course Book pages only', async () => {
    const s = await student(null);
    const { session, ref } = await startBookCheckout(s.cookie);
    await webhook({ id: session, payment_status: 'paid', amount_total: 19900, currency: 'usd', client_reference_id: ref });
    expect((await req('/course-book', { cookie: s.cookie })).status).toBe(200);
    expect((await req('/dashboard', { cookie: s.cookie })).headers.get('location')).toBe('/course-book');
    expect((await req('/lectures', { cookie: s.cookie })).headers.get('location')).toBe('/course-book');
  });

  it('signing in from a payment return link keeps the link', async () => {
    const res = await req('/buy/course-book/success?session_id=cs_test_x');
    expect(res.headers.get('location')).toBe('/sign-in?next=' + encodeURIComponent('/buy/course-book/success?session_id=cs_test_x'));
  });
});

describe('package enrollment checkout', () => {
  it('activates the enrollment only for a paid session with the saved price, once', async () => {
    const s = await student(null);
    const res = await req('/enroll/companion', { cookie: s.cookie, form: {} });
    expect(res.status).toBe(303);
    const p = created.at(-1)!;
    const price = (await db.prepare("SELECT price_cents FROM packages WHERE id = 'companion'").first<{ price_cents: number }>())!.price_cents;
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe(String(price));
    const session = res.headers.get('location')!.split('/').pop()!;
    const ref = p.get('client_reference_id')!;
    expect(ref).toMatch(/^\d+$/);
    const status = async () => (await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(Number(ref)).first<{ status: string }>())!.status;
    const paid = { id: session, payment_status: 'paid', amount_total: price, currency: 'usd', client_reference_id: ref };
    await webhook({ ...paid, payment_status: 'unpaid' });
    await webhook({ ...paid, amount_total: price - 100 });
    expect(await status()).toBe('pending');
    expect((await req('/dashboard', { cookie: s.cookie })).headers.get('location')).toBe('/enroll');
    await webhook(paid);
    await webhook(paid);
    expect(await status()).toBe('active');
    expect((await req('/dashboard', { cookie: s.cookie })).status).toBe(200);
    // A price change after checkout started doesn't affect what was agreed.
    expect((await db.prepare('SELECT amount_cents FROM enrollments WHERE id = ?').bind(Number(ref)).first<{ amount_cents: number }>())!.amount_cents).toBe(price);
  });
});

describe('Course Book PDF storage', () => {
  it('a 5 MB PDF is stored in pieces and comes back byte-for-byte', async () => {
    const admin = await student(null);
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(admin.id).run();
    const big = new Uint8Array(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
    big.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
    const fd = new FormData();
    fd.set('number', '9');
    fd.set('title', 'Big chapter');
    fd.set('live', '1');
    fd.set('pdf', new File([big], 'big.pdf', { type: 'application/pdf' }));
    const up = await worker.fetch(new Request(BASE + '/admin/book', { method: 'POST', body: fd, headers: { cookie: admin.cookie, 'sec-fetch-site': 'same-origin', origin: BASE }, redirect: 'manual' }));
    expect(up.status).toBe(302);
    const ch = (await db.prepare("SELECT id, file_id FROM book_chapters WHERE title = 'Big chapter'").first<{ id: number; file_id: number }>())!;
    expect((await db.prepare('SELECT COUNT(*) AS n FROM file_chunks WHERE file_id = ?').bind(ch.file_id).first<{ n: number }>())!.n).toBe(3);
    const max = await student('max');
    const res = await req(`/course-book/${ch.id}/pdf?download=1`, { cookie: max.cookie });
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(got.every((b, i) => b === big[i])).toBe(true);
  });
});
