import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';

// A refunded student keeps their account (and may still see the menu, free lectures and the programs page),
// but every paid page, every paid video and every paid action is refused the moment Stripe's refund arrives,
// even when they type the address directly or a video is already playing.
const BASE = 'https://usmle100.test';
const WHSEC = 'whsec_test_not_real';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
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
async function sign(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const PAID_PAGES = [
  '/dashboard', '/lectures', '/lectures/workbench', '/lectures/path', '/topics', '/qbank', '/create-test', '/warmup',
  '/cards', '/review', '/performance', '/rewards', '/notes', '/ask', '/book', '/search', '/exam-window', '/course-book',
];

let cohort = 0, lec = 0, cookie = '', userId = 0, enrId = 0;
const blocked = (r: Response) => (r.status === 302 || r.status === 303) && /\/enroll|\/programs|\/sign-in/.test(r.headers.get('location') ?? '') ? true : r.status === 403 || r.status === 404;

beforeAll(async () => {
  await req('/');
  const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  cohort = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Refund Access', ymd(-2)).run()).meta.last_row_id);
  lec = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'Paid lecture', 'live', 'vid-paid', 100)").bind(cohort).run()).meta.last_row_id);
  const email = `refund-access-${Date.now()}@example.com`;
  cookie = cookies(await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } }));
  userId = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  enrId = Number(
    (await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, payment_intent, amount_cents) VALUES (?, 'max', 'active', datetime('now'), ?, 'pi_refund_access', 150000)").bind(userId, cohort).run()).meta.last_row_id,
  );
});

describe('after a full refund, paid material is closed even if the menu is still on screen', () => {
  it('refund removes every paid page, lecture, video and paid action', async () => {
    // While paid: the pages open and the video plays.
    for (const p of [...PAID_PAGES, `/lectures/${lec}`]) {
      const r = await req(p, { cookie });
      expect(r.status === 200 || (r.status === 302 && !/\/enroll/.test(r.headers.get('location') ?? '')), `${p} while paid: ${r.status} ${r.headers.get('location')}`).toBe(true);
    }
    const tab = 'aaaaaaaaaaaa';
    const before = (await (await req('/play/claim', { cookie, json: { item: `L:${lec}`, tab } })).json()) as any;
    expect(before.state, JSON.stringify(before)).toBe('ok');

    // Stripe's refund notification arrives (full refund).
    const payload = JSON.stringify({ id: 'evt_ra', type: 'charge.refunded', data: { object: { id: 'ch_ra', payment_intent: 'pi_refund_access', amount: 150000, amount_refunded: 150000, refunded: true } } });
    const wh = await worker.fetch(new Request(BASE + '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload) } }));
    expect(wh.status).toBe(200);
    expect((await db.prepare('SELECT status FROM enrollments WHERE id = ?').bind(enrId).first<{ status: string }>())!.status).toBe('refunded');

    // Same browser session, addresses typed directly: every paid page sends them to choose a program.
    for (const p of [...PAID_PAGES, `/lectures/${lec}`]) {
      const r = await req(p, { cookie });
      expect(blocked(r), `${p} after refund: ${r.status} ${r.headers.get('location')}`).toBe(true);
    }
    // The video that was already playing stops at its next heartbeat, and no new video link is given.
    const beat = (await (await req('/play/beat', { cookie, json: { sid: before.sid, nonce: before.nonce, tab, playing: true, pos: 5, dur: 100, add: [[0, 5]] } })).json()) as any;
    expect(beat.state).toBe('gone');
    const again = await req('/play/claim', { cookie, json: { item: `L:${lec}`, tab: 'bbbbbbbbbbbb' } });
    expect(again.status).toBe(403);
    expect(JSON.stringify(await again.json())).not.toMatch(/token=|mediadelivery/);

    // Paid actions (posting, starting tests, marking lectures done) are refused too.
    for (const [p, form] of [
      ['/qbank/quick', {}],
      ['/create-test', { count: '10' }],
      [`/lectures/${lec}/done`, {}],
      ['/notes', { body: 'x' }],
      ['/ask', { title: 'x', body: 'x' }],
    ] as [string, Record<string, string>][]) {
      const r = await req(p, { cookie, form });
      expect(blocked(r), `POST ${p} after refund: ${r.status} ${r.headers.get('location')}`).toBe(true);
    }

    // The menu no longer shows course progress; it says there is no active program.
    const menu = await (await req('/free-lectures', { cookie })).text();
    expect(menu).toContain('No active program');
    expect(menu).not.toMatch(/of \d+ lectures/);

    // What stays open: their account, the free lectures and the programs page (so they can buy again).
    for (const p of ['/account', '/free-lectures', '/programs', '/enroll']) {
      expect((await req(p, { cookie })).status, p).toBe(200);
    }
  });
});
