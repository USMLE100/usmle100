import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';
import { bunnyEmbedUrl } from '../src/lib/content';
import { sha256Hex } from '../src/lib/auth';

// Attempts to get around the video rules (owner, 4 Nov 2026): another student's viewing, unpublished or test
// videos, ended access, classes not bought, faked progress, and the signed Bunny link itself.
const BASE = 'https://usmle100.test';
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
const json = async (r: Response) => (await r.json()) as any;

let n = 0;
async function student(pkg: string | null, cohort: number) {
  const email = `bypass${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: 'correct-horse-battery' } });
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  let enr = 0;
  if (pkg) enr = Number((await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, ?, 'active', datetime('now'), ?)").bind(id, pkg, cohort).run()).meta.last_row_id);
  return { cookie: cookies(res), id, enr };
}
let tabN = 0;
const newTab = () => (++tabN).toString(16).padStart(12, 'b');
const claim = (cookie: string, item: string, tab: string) => req('/play/claim', { cookie, json: { item, tab } }).then(json);
const beat = (cookie: string, c: any, tab: string, body: Record<string, unknown>) => req('/play/beat', { cookie, json: { sid: c.sid, nonce: c.nonce, tab, playing: true, pos: 0, dur: 1000, add: [], ...body } }).then(json);

let cohort = 0, day = 0;
async function lecture(status: string, video: string | null = 'vid-x') {
  return Number((await db.prepare('INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, ?, ?, ?, ?, 1000)').bind(cohort, ++day, `Bypass ${day}`, status, video).run()).meta.last_row_id);
}
beforeAll(async () => {
  await req('/');
  const ymd = new Date(Date.now() - 4 * 86400e3).toISOString().slice(0, 10);
  cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Bypass', ?)").bind(ymd).run()).meta.last_row_id);
});

describe('video access cannot be bypassed', () => {
  it('a student cannot report progress into, or use up, another student’s viewing', async () => {
    const lec = await lecture('live');
    const a = await student('max', cohort);
    const b = await student('max', cohort);
    const ta = newTab(), tb = newTab();
    const ca = await claim(a.cookie, `L:${lec}`, ta);
    const cb = await claim(b.cookie, `L:${lec}`, tb);
    expect([ca.state, cb.state]).toEqual(['ok', 'ok']);
    expect(ca.sid).not.toBe(cb.sid);
    // B uses A's session id (with B's own tab), and A's whole set of ids from B's account.
    expect((await beat(b.cookie, { sid: ca.sid, nonce: cb.nonce }, tb, { add: [[0, 900]] })).state).toBe('gone');
    expect((await beat(b.cookie, ca, ta, { add: [[0, 900]] })).state).toBe('tab');
    const s = await db.prepare('SELECT watched_seconds, started_at, counted FROM view_sessions WHERE id = ?').bind(ca.sid).first<any>();
    expect(s).toMatchObject({ watched_seconds: 0, started_at: null, counted: 0 });
    // The watermark carries the viewer's own name, account number and their own session code.
    const me = await db.prepare('SELECT name FROM users WHERE id = ?').bind(b.id).first<{ name: string }>();
    expect(cb.wm).toEqual({ name: me!.name, id: b.id, code: cb.sid });
  });

  it('unpublished, unapproved or test videos give students no link', async () => {
    const a = await student('max', cohort);
    for (const status of ['processing']) {
      const lec = await lecture(status, 'vid-test-video');
      const c = await claim(a.cookie, `L:${lec}`, newTab());
      expect(c.state, status).not.toBe('ok');
      expect(JSON.stringify(c)).not.toContain('mediadelivery');
    }
    // An unpublished free-list entry pointing straight at a Bunny video (e.g. a test upload).
    const f = Number((await db.prepare("INSERT INTO free_videos (source, title, published) VALUES ('V:vid-test-upload', 'Test', 0)").run()).meta.last_row_id);
    expect(JSON.stringify(await claim(a.cookie, `F:${f}`, newTab()))).not.toContain('mediadelivery');
  });

  it('access that has ended, or a class not bought, gives no link and stops a viewing in progress', async () => {
    const lec = await lecture('live');
    const a = await student('refresher', cohort);
    const t = newTab();
    const c = await claim(a.cookie, `L:${lec}`, t);
    expect(c.state).toBe('ok');
    // Lecture access ended yesterday (60 days after Day 100, or an admin date).
    // Two days back: access lasts to the end of its last day in New York time, and in the evening UTC is already tomorrow.
    await db.prepare("UPDATE enrollments SET lectures_until = date('now', '-2 day') WHERE id = ?").bind(a.enr).run();
    expect((await beat(a.cookie, c, t, {})).state).toBe('gone');
    expect((await claim(a.cookie, `L:${lec}`, newTab())).state).not.toBe('ok');
    // Refresher includes no Evening Questions: no evening class link.
    const ev = Number((await db.prepare("INSERT INTO evening_sessions (session_date, title, bunny_video_id, status, live_at) VALUES (date('now'), 'Bypass evening', 'ev-x', 'live', datetime('now'))").run()).meta.last_row_id);
    expect((await claim(a.cookie, `E:${ev}`, newTab())).state).not.toBe('ok');
    // Made-up or malformed item keys.
    for (const item of ['L:999999', 'X:1', 'L:1 OR 1=1', `L:${lec}/../1`, '']) expect((await claim(a.cookie, item, newTab())).state, item).not.toBe('ok');
  });

  it('faked progress cannot complete a viewing faster than 2× speed', async () => {
    const lec = await lecture('live');
    const a = await student('max', cohort);
    const t = newTab();
    const c = await claim(a.cookie, `L:${lec}`, t);
    await beat(a.cookie, c, t, {});
    // Right away, claim the whole 1000-second lecture was watched.
    const r = await beat(a.cookie, c, t, { add: [[0, 1000]], pos: 1000 });
    expect(r.state).toBe('ok');
    const s = await db.prepare('SELECT watched_seconds, counted FROM view_sessions WHERE id = ?').bind(c.sid).first<any>();
    expect(s.counted).toBe(0);
    expect(s.watched_seconds).toBeLessThan(100);
  });

  it('the Bunny link is signed for one video and one expiry, and lasts 15 minutes in production', async () => {
    const e = { BUNNY_LIBRARY_ID: '785730', BUNNY_TOKEN_KEY: 'k' } as any;
    const a = new URL((await bunnyEmbedUrl(e, 'video-a'))!);
    const b = new URL((await bunnyEmbedUrl(e, 'video-b'))!);
    const exp = Number(a.searchParams.get('expires'));
    expect(exp - Date.now() / 1000).toBeGreaterThan(14 * 60);
    expect(exp - Date.now() / 1000).toBeLessThanOrEqual(15 * 60 + 1);
    expect(a.searchParams.get('token')).toBe(await sha256Hex('k' + 'video-a' + exp));
    expect(a.searchParams.get('token')).not.toBe(b.searchParams.get('token'));
    // No key, no link (never an unsigned player).
    expect(await bunnyEmbedUrl({ BUNNY_LIBRARY_ID: '785730' } as any, 'video-a')).toBeNull();
  });
});
