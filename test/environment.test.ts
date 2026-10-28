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
