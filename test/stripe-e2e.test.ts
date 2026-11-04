import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP, cookies } from './owner';

// End-to-end payment simulation with Stripe-shaped events (owner, 4 Nov 2026): each package from checkout to access,
// refund and revocation, plus people who never paid. Stripe's API is mocked and every webhook is signed exactly as
// Stripe signs it; nothing reaches Stripe and no money moves.
const BASE = 'https://usmle100.test';
const WHSEC = 'whsec_test_not_real';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) { init.method = 'POST'; init.body = new URLSearchParams(opts.form); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (opts.json !== undefined) { init.method = 'POST'; init.body = JSON.stringify(opts.json); headers['content-type'] = 'application/json'; }
  return worker.fetch(new Request(BASE + path, init));
}

async function sign(payload: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  // Stripe's real header carries t, a v1 signature and sometimes a v0 test signature.
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')},v0=deadbeef`;
}
let ev = 0;
/** A Stripe event exactly as delivered: an event envelope around a snapshot of the object. */
async function deliver(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${++ev}`, object: 'event', api_version: '2025-09-30.clover', created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
  return worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload), 'content-type': 'application/json; charset=utf-8' } }));
}

let created: URLSearchParams[] = [];
let sid = 0;
beforeEach(() => {
  created = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
      created.push(new URLSearchParams(init.body));
      const id = `cs_test_e2e_${++sid}`;
      return new Response(JSON.stringify({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
    }
    if (url.startsWith('https://api.stripe.com/')) return new Response('{"error":{"message":"not mocked"}}', { status: 404 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function student() {
  const email = `e2e${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  return { cookie: cookies(res), id, email };
}

let lecture = 0;
beforeAll(async () => {
  await worker.fetch(new Request(BASE + '/'));
  const ymd = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  const cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('E2E', ?)").bind(ymd).run()).meta.last_row_id);
  lecture = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'E2E lecture', 'live', 'vid-e2e', 3600)").bind(cohort).run()).meta.last_row_id);
});

const claim = async (cookie: string) => (await (await req('/play/claim', { cookie, json: { item: `L:${lecture}`, tab: 'eeeeeeeeeeee' } })).json()) as { state: string };
const portalOpen = async (cookie: string) => (await req('/dashboard', { cookie })).status === 200;
// The locked page ("Buy the Course Book") also loads normally, so check for the book itself.
const bookOpen = async (cookie: string) => {
  const r = await req('/course-book', { cookie });
  return r.status === 200 && !(await r.text()).includes('href="/buy/course-book"');
};

const PACKAGES = [
  { id: 'refresher', cents: 150000, book: false, evening: 0 },
  { id: 'companion', cents: 199900, book: true, evening: 4 },
  { id: 'complete', cents: 244900, book: true, evening: 4 },
  { id: 'max', cents: 379900, book: true, evening: 4 },
];

describe('payments end to end (Stripe-shaped events)', () => {
  it('prices in the database match the confirmed prices', async () => {
    for (const p of PACKAGES) {
      const row = await db.prepare('SELECT price_cents, evening_q_months FROM packages WHERE id = ?').bind(p.id).first<{ price_cents: number; evening_q_months: number }>();
      expect(row, p.id).toMatchObject({ price_cents: p.cents, evening_q_months: p.evening });
    }
  });

  for (const p of PACKAGES) {
    it(`${p.id}: checkout → paid webhook unlocks exactly that package → full refund removes it`, async () => {
      const s = await student();
      // Before paying: nothing paid opens.
      expect(await portalOpen(s.cookie)).toBe(false);
      expect((await claim(s.cookie)).state).not.toBe('ok');
      expect(await bookOpen(s.cookie)).toBe(false);

      const res = await req(`/enroll/${p.id}`, { cookie: s.cookie, form: {} });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const params = created.at(-1)!;
      expect(params.get('mode')).toBe('payment');
      expect(params.get('line_items[0][price_data][currency]')).toBe('usd');
      expect(params.get('line_items[0][price_data][unit_amount]')).toBe(String(p.cents));
      expect(params.get('customer_email')).toBe(s.email);
      expect(params.get('success_url')).toMatch(/\/enroll\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);
      const session = res.headers.get('location')!.split('/').pop()!;
      const ref = params.get('client_reference_id')!;
      const pi = `pi_e2e_${p.id}_${s.id}`;

      // Still not paid while the checkout is open or abandoned.
      expect(await portalOpen(s.cookie)).toBe(false);

      const sessionObj = { id: session, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: p.cents, amount_subtotal: p.cents, currency: 'usd', client_reference_id: ref, customer_email: s.email, payment_intent: pi, livemode: false, metadata: { kind: 'enrollment' } };
      expect((await deliver('checkout.session.completed', sessionObj)).status).toBe(200);
      expect((await deliver('checkout.session.completed', sessionObj)).status).toBe(200); // Stripe retry: harmless

      const enr = await db.prepare('SELECT status, package_id, amount_cents, payment_intent FROM enrollments WHERE id = ?').bind(Number(ref)).first<any>();
      expect(enr).toMatchObject({ status: 'active', package_id: p.id, amount_cents: p.cents, payment_intent: pi });
      expect(await portalOpen(s.cookie)).toBe(true);
      expect((await claim(s.cookie)).state).toBe('ok');
      expect(await bookOpen(s.cookie)).toBe(p.book);

      // Full refund issued in the Stripe Dashboard.
      const charge = { id: `ch_e2e_${p.id}_${s.id}`, object: 'charge', amount: p.cents, amount_captured: p.cents, amount_refunded: p.cents, refunded: true, captured: true, paid: true, currency: 'usd', payment_intent: pi, status: 'succeeded' };
      expect((await deliver('charge.refunded', charge)).status).toBe(200);
      expect((await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(Number(ref)).first<any>()).status).toBe('refunded');
      expect(await portalOpen(s.cookie)).toBe(false);
      expect((await claim(s.cookie)).state).not.toBe('ok');
      expect(await bookOpen(s.cookie)).toBe(false);
    });
  }

  it('failed, unpaid or tampered payments never unlock anything', async () => {
    const s = await student();
    const res = await req('/enroll/complete', { cookie: s.cookie, form: {} });
    const session = res.headers.get('location')!.split('/').pop()!;
    const ref = created.at(-1)!.get('client_reference_id')!;
    const base = { id: session, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 244900, currency: 'usd', client_reference_id: ref, payment_intent: 'pi_e2e_fail' };
    // Bank debit still pending, then failed (Stripe sends async_payment_failed; the site ignores it).
    await deliver('checkout.session.completed', { ...base, payment_status: 'unpaid' });
    await deliver('checkout.session.async_payment_failed', { ...base, payment_status: 'unpaid' });
    // Session expired without paying.
    await deliver('checkout.session.expired', { ...base, status: 'expired', payment_status: 'unpaid' });
    // Wrong amount or currency.
    await deliver('checkout.session.completed', { ...base, amount_total: 100 });
    await deliver('checkout.session.completed', { ...base, currency: 'eur' });
    // A different checkout session pointing at this enrollment.
    await deliver('checkout.session.completed', { ...base, id: 'cs_test_someone_else' });
    expect((await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(Number(ref)).first<any>()).status).toBe('pending');
    expect(await portalOpen(s.cookie)).toBe(false);
    expect((await claim(s.cookie)).state).not.toBe('ok');

    // A forged webhook (wrong secret) and a replayed one (old timestamp) are refused before anything happens.
    const forged = JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: base } });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_wrong'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const t = Math.floor(Date.now() / 1000);
    const bad = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${forged}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((await worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: forged, headers: { 'stripe-signature': `t=${t},v1=${bad}` } }))).status).toBe(400);
    expect((await worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: forged, headers: { 'stripe-signature': await sign(forged, t - 3600) } }))).status).toBe(400);
    expect((await worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: forged }))).status).toBe(400);
    expect((await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(Number(ref)).first<any>()).status).toBe('pending');
  });

  it('one student’s payment can never unlock another student’s account', async () => {
    const a = await student();
    const b = await student();
    const ra = await req('/enroll/max', { cookie: a.cookie, form: {} });
    const sessionA = ra.headers.get('location')!.split('/').pop()!;
    await req('/enroll/refresher', { cookie: b.cookie, form: {} });
    const refB = created.at(-1)!.get('client_reference_id')!;
    // A's real paid session, but pointing at B's enrollment.
    await deliver('checkout.session.completed', { id: sessionA, object: 'checkout.session', payment_status: 'paid', amount_total: 150000, currency: 'usd', client_reference_id: refB, payment_intent: 'pi_e2e_cross' });
    expect((await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(Number(refB)).first<any>()).status).toBe('pending');
    expect(await portalOpen(b.cookie)).toBe(false);
    // And a student cannot open the success page to activate someone else's checkout.
    await req(`/enroll/success?session_id=${sessionA}`, { cookie: b.cookie });
    expect(await portalOpen(b.cookie)).toBe(false);
  });

  it('a partial refund keeps access; a chargeback pauses it straight away', async () => {
    const s = await student();
    const res = await req('/enroll/companion', { cookie: s.cookie, form: {} });
    const session = res.headers.get('location')!.split('/').pop()!;
    const ref = created.at(-1)!.get('client_reference_id')!;
    await deliver('checkout.session.completed', { id: session, object: 'checkout.session', payment_status: 'paid', amount_total: 199900, currency: 'usd', client_reference_id: ref, payment_intent: 'pi_e2e_part' });
    await deliver('charge.refunded', { id: 'ch_e2e_part', object: 'charge', amount: 199900, amount_refunded: 50000, refunded: false, payment_intent: 'pi_e2e_part' });
    expect(await portalOpen(s.cookie)).toBe(true);
    await deliver('charge.dispute.created', { id: 'dp_e2e', object: 'dispute', charge: 'ch_e2e_part', payment_intent: 'pi_e2e_part', amount: 199900, reason: 'product_not_received', status: 'needs_response' });
    expect((await claim(s.cookie)).state).not.toBe('ok');
  });
});
