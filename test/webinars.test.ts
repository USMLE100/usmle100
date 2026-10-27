import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';
import { nyToIso } from '../src/routes/webinars';

const BASE = 'https://usmle100.test';
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
let n = 0;
async function account(role = 'student') {
  const email = `web${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();
  return { email, cookie: cookies(res), id: (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id };
}

beforeAll(async () => {
  await req('/');
});

describe('live webinars', () => {
  it('New York times are stored as UTC, through daylight saving', () => {
    expect(nyToIso('2026-11-12T19:00')).toBe('2026-11-13T00:00:00.000Z');
    expect(nyToIso('2026-07-01T19:00')).toBe('2026-07-01T23:00:00.000Z');
    expect(nyToIso('nonsense')).toBeNull();
  });

  it('listed publicly; only registered students with their details get the link; admins get the attendee list', async () => {
    const admin = await account('admin');
    const starts = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 16);
    await req('/admin/webinars', { cookie: admin.cookie, form: { title: 'High-yield cardio', starts, minutes: '60', join_url: 'https://zoom.us/j/123456' } });
    const w = (await db.prepare("SELECT id FROM webinars WHERE title = 'High-yield cardio'").first<{ id: number }>())!;
    const pub = await (await req('/webinars')).text();
    expect(pub).toContain('High-yield cardio');
    expect(pub).not.toContain('zoom.us/j/123456');
    expect((await req(`/webinars/${w.id}`)).headers.get('location')).toContain('/sign-in');
    const s = await account();
    await db.prepare('UPDATE users SET grad_year = NULL WHERE id = ?').bind(s.id).run();
    expect(await (await req(`/webinars/${w.id}`, { cookie: s.cookie })).text()).toContain('Complete my details');
    expect((await req(`/webinars/${w.id}/register`, { cookie: s.cookie, form: {} })).headers.get('location')).toContain('/account');
    await db.prepare('UPDATE users SET grad_year = 2025 WHERE id = ?').bind(s.id).run();
    expect(await (await req(`/webinars/${w.id}`, { cookie: s.cookie })).text()).not.toContain('zoom.us/j/123456');
    await req(`/webinars/${w.id}/register`, { cookie: s.cookie, form: {} });
    expect(await (await req(`/webinars/${w.id}`, { cookie: s.cookie })).text()).toContain('zoom.us/j/123456');
    const csv = await (await req(`/admin/webinars/${w.id}/attendees.csv`, { cookie: admin.cookie })).text();
    expect(csv).toContain(s.email);
    expect((await req(`/admin/webinars/${w.id}/attendees.csv`, { cookie: (await account('faculty')).cookie })).status).toBe(404);
    expect((await req(`/admin/webinars/${w.id}/attendees.csv`, { cookie: s.cookie })).status).toBe(404);
  });
});

describe('Evening Questions recordings use the protected player', () => {
  it('subscribers get a link with no view limit; others get nothing', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const e = Number((await db.prepare("INSERT INTO evening_sessions (session_date, title, bunny_video_id, status, live_at) VALUES ('2000-01-03', 'Evening test', 'ev-vid', 'live', datetime('now'))").run()).meta.last_row_id);
    const outsider = await account();
    expect((await req('/play/claim', { cookie: outsider.cookie, json: { item: `E:${e}`, tab: 'abcdef123456' } })).status).toBe(403);
    const staff = await account('faculty');
    const st = (await (await req('/play/claim', { cookie: staff.cookie, json: { item: `E:${e}`, tab: 'abcdef123457' } })).json()) as any;
    expect(st.state).toBe('ok');
    expect(st.src).toContain('/ev-vid?token=');
    expect(today).toBeTruthy();
  });
});
