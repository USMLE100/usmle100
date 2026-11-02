import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { _resetDatabaseCheck, checkDatabase, LIVE_BUNNY_LIBRARY_ID, markDatabase, safeEnv } from '../src/lib/environment';
import type { Env } from '../src/lib/types';

const base = env as unknown as Env;
const db = base.DB;
const preview = (extra: Partial<Env> = {}): Env => ({ ...base, ENVIRONMENT: 'preview', ...extra });
const setMark = (v: string | null) =>
  v === null
    ? db.prepare("DELETE FROM settings WHERE key = 'db_environment'").run()
    : db.prepare("INSERT INTO settings (key, value) VALUES ('db_environment', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(v).run();
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

afterEach(async () => {
  await setMark('production');
  _resetDatabaseCheck();
});

describe('preview settings are fenced off from live services', () => {
  it('the test configuration is production', () => {
    expect(base.ENVIRONMENT).toBe('production');
    expect(safeEnv(base)).toBe(base);
  });

  it('drops a live Stripe key but keeps a test key', () => {
    const live = safeEnv(preview({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x' }));
    expect(live.STRIPE_SECRET_KEY).toBeUndefined();
    expect(live.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(safeEnv(preview({ STRIPE_SECRET_KEY: 'rk_live_abc' })).STRIPE_SECRET_KEY).toBeUndefined();
    expect(safeEnv(preview({ STRIPE_SECRET_KEY: 'sk_test_abc' })).STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(safeEnv({ ...base, ENVIRONMENT: undefined, STRIPE_SECRET_KEY: 'sk_live_abc' }).STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('switches off Zoom, the marketing sync and Bunny writes to the live library', () => {
    const e = safeEnv(preview({ ZOOM_CLIENT_SECRET: 'z', ZOOM_ACCOUNT_ID: 'a', ZOOM_CLIENT_ID: 'c', ZOOM_WEBHOOK_SECRET: 'w', SENDER_API_KEY: 's', BUNNY_API_KEY: 'b', BUNNY_LIBRARY_ID: LIVE_BUNNY_LIBRARY_ID }));
    expect([e.ZOOM_CLIENT_SECRET, e.ZOOM_ACCOUNT_ID, e.ZOOM_CLIENT_ID, e.ZOOM_WEBHOOK_SECRET, e.SENDER_API_KEY, e.BUNNY_API_KEY]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(safeEnv(preview({ BUNNY_API_KEY: 'b', BUNNY_LIBRARY_ID: '999' })).BUNNY_API_KEY).toBe('b');
  });

  it('keeps Zoom only when the owner opts a preview in', () => {
    expect(safeEnv(preview({ ZOOM_CLIENT_SECRET: 'z', PREVIEW_ALLOW_ZOOM: '0' })).ZOOM_CLIENT_SECRET).toBeUndefined();
    expect(safeEnv(preview({ ZOOM_CLIENT_SECRET: 'z', PREVIEW_ALLOW_ZOOM: '1' })).ZOOM_CLIENT_SECRET).toBe('z');
  });
});

describe('a preview never runs on the production database', () => {
  it('the live Worker marks its database as production', async () => {
    await setMark(null);
    await markDatabase(base);
    expect((await db.prepare("SELECT value FROM settings WHERE key = 'db_environment'").first<{ value: string }>())?.value).toBe('production');
  });

  it('refuses a database marked production', async () => {
    await setMark('production');
    expect(await checkDatabase(preview())).toMatch(/production database/);
  });

  it('refuses an unmarked database that already holds accounts', async () => {
    await db.prepare("INSERT OR IGNORE INTO users (email, name, password_hash, password_salt, role) VALUES ('env-test@example.com', 'Env Test', 'x', 'x', 'student')").run();
    await setMark(null);
    expect(await checkDatabase(preview())).toMatch(/already holds accounts/);
  });

  it('accepts a development database', async () => {
    await setMark('development');
    expect(await checkDatabase(preview())).toBeNull();
  });

  it('accepts a brand-new empty database and marks it development', async () => {
    const ran: string[] = [];
    const stmt = (sql: string) => ({ bind: () => stmt(sql), first: async () => null, run: async () => (ran.push(sql), { meta: {} }) });
    const empty = { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
    expect(await checkDatabase(preview({ DB: empty }))).toBeNull();
    await markDatabase(preview({ DB: empty }));
    expect(ran.join(' ')).toMatch(/'db_environment', 'development'\) ON CONFLICT \(key\) DO NOTHING/);
  });

  it('the whole site answers 503 before migrating when a preview is bound to the production database', async () => {
    await setMark('production');
    const res = await worker.fetch(new Request('https://preview.example/'), preview(), ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/production database/);
  });

  it('a preview on a development database works and is hidden from search engines', async () => {
    await setMark('development');
    const res = await worker.fetch(new Request('https://preview.example/'), preview(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('staging status page', () => {
  it('does not exist in production', async () => {
    const res = await worker.fetch(new Request('https://x.example/__staging'), base, ctx);
    expect(res.status).toBe(404);
  });
  it('on a preview, reports modes but never a key', async () => {
    await setMark('development');
    const res = await worker.fetch(new Request('https://preview.example/__staging'), preview({ STRIPE_SECRET_KEY: 'rk_test_secretvalue', BUNNY_LIBRARY_ID: '' }), ctx);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ environment: 'preview', stripe: 'test mode (restricted key)', bunny: 'off', zoom: 'off' });
    expect(text).not.toContain('secretvalue');
  });
  it('the live video library on a preview is playback only: the Bunny API key is dropped', async () => {
    await setMark('development');
    const env = preview({ BUNNY_LIBRARY_ID: LIVE_BUNNY_LIBRARY_ID, BUNNY_API_KEY: 'bunny_api_secret', BUNNY_TOKEN_KEY: 'tok' });
    expect(safeEnv(env).BUNNY_API_KEY).toBeUndefined();
    expect(safeEnv(env).BUNNY_TOKEN_KEY).toBe('tok');
    const text = await (await worker.fetch(new Request('https://preview.example/__staging'), env, ctx)).text();
    expect(JSON.parse(text).bunny).toMatch(/playback only.*token key set/);
    expect(Array.isArray(JSON.parse(text).recent_viewings)).toBe(true);
    expect(Array.isArray(JSON.parse(text).lectures_with_video)).toBe(true);
    expect(text).not.toContain('bunny_api_secret');
  });
  it('a live key on a preview shows as not set', async () => {
    await setMark('development');
    const res = await worker.fetch(new Request('https://preview.example/__staging'), preview({ STRIPE_SECRET_KEY: 'sk_live_abc' }), ctx);
    expect((await res.json() as any).stripe).toBe('not set');
  });
});

describe('staging owner', () => {
  it('the first staging account becomes the owner; production never promotes anyone', async () => {
    const { ensureStagingOwner } = await import('../src/lib/environment');
    const owner = await db.prepare('SELECT id FROM users WHERE is_owner = 1').first<{ id: number }>();
    // With an owner already present nothing changes, on staging or production.
    _resetDatabaseCheck();
    await ensureStagingOwner(preview());
    expect((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 1').first<{ n: number }>())!.n).toBe(owner ? 1 : 0);
    // Simulate a fresh staging database: no owner.
    await db.prepare('UPDATE users SET is_owner = 0').run();
    _resetDatabaseCheck();
    await ensureStagingOwner(base); // production: never
    expect(await db.prepare('SELECT 1 FROM users WHERE is_owner = 1').first()).toBeNull();
    await ensureStagingOwner(preview());
    const first = await db.prepare('SELECT id, role, is_owner FROM users ORDER BY id LIMIT 1').first<{ id: number; role: string; is_owner: number }>();
    expect(first).toMatchObject({ role: 'admin', is_owner: 1 });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 1').first<{ n: number }>())!.n).toBe(1);
    // restore
    await db.prepare('UPDATE users SET is_owner = 0').run();
    if (owner) await db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').bind(owner.id).run();
  });
});

describe('staging Stripe log', () => {
  const secret = 'whsec_staging_test';
  async function sign(payload: string) {
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `t=${t},v1=${sig}`;
  }
  it('records webhook deliveries on staging (and bad signatures), shown on /__staging; never in production', async () => {
    await setMark('development');
    await db.prepare("DELETE FROM settings WHERE key = 'staging_stripe_log'").run();
    const env = preview({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: secret });
    const payload = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_test_1', payment_intent: null, amount: 100, amount_refunded: 50, refunded: false } } });
    const ok = await worker.fetch(new Request('https://preview.example/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload) } }), env, ctx);
    expect(ok.status).toBe(200);
    const bad = await worker.fetch(new Request('https://preview.example/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': 't=1,v1=00' } }), env, ctx);
    expect(bad.status).toBe(400);
    const res = await worker.fetch(new Request('https://preview.example/__staging'), env, ctx);
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    const st = (await res.json()) as any;
    expect(st.recent_stripe_events[0]).toMatchObject({ source: 'webhook', outcome: expect.stringContaining('bad or old signature') });
    expect(st.recent_stripe_events[1]).toMatchObject({ source: 'webhook', type: 'charge.refunded', outcome: expect.stringContaining('partial') });
    expect(st.purchases).toBeDefined();
    // Production never writes the log.
    await db.prepare("DELETE FROM settings WHERE key = 'staging_stripe_log'").run();
    _resetDatabaseCheck();
    await worker.fetch(new Request('https://x.example/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': await sign(payload) } }), { ...base, STRIPE_WEBHOOK_SECRET: secret }, ctx);
    expect(await db.prepare("SELECT 1 FROM settings WHERE key = 'staging_stripe_log'").first()).toBeNull();
  });
});

describe('one main address in production', () => {
  it('with SITE_URL set, pages on other addresses move to it; webhooks and previews are untouched', async () => {
    const prod = { ...base, SITE_URL: 'https://usmle100.com' } as Env;
    const r = await worker.fetch(new Request('https://www.usmle100.com/programs?x=1'), prod, ctx);
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://usmle100.com/programs?x=1');
    expect((await worker.fetch(new Request('https://usmle100.com/programs'), prod, ctx)).status).toBe(200);
    const hook = await worker.fetch(new Request('https://usmle100.info-usmle100.workers.dev/stripe/webhook', { method: 'POST', body: '{}' }), prod, ctx);
    expect(hook.status).not.toBe(301);
    expect((await worker.fetch(new Request('https://www.usmle100.com/programs'), base, ctx)).status).toBe(200); // SITE_URL not set yet
    await setMark('development');
    expect((await worker.fetch(new Request('https://preview.example/programs'), preview({ SITE_URL: 'https://usmle100.com' }), ctx)).status).toBe(200);
  });
});
