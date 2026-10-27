import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';
import { markSeconds } from '../src/lib/viewing';

const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PASSWORD = 'correct-horse-battery';

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
const json = async (r: Response) => (await r.json()) as any;

let n = 0;
async function account(role: 'student' | 'faculty' | 'admin' | 'owner' = 'student') {
  const email = `view${++n}-${Date.now()}@example.com`;
  const res = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD } });
  const cookie = cookies(res);
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  return { email, cookie, id };
}
async function enroll(userId: number, cohortId: number) {
  const r = await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(userId, cohortId).run();
  return Number(r.meta.last_row_id);
}

let cohortA = 0, cohortB = 0, day = 0;
async function lecture(cohort: number) {
  const r = await db
    .prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, ?, ?, 'live', 'vid-abc', 100)")
    .bind(cohort, ++day, `Lecture ${day}`)
    .run();
  return Number(r.meta.last_row_id);
}

beforeAll(async () => {
  await req('/'); // runs the database migrations
  const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  // Cohort B starts later so it is the "latest" cohort; enrollments name their cohort explicitly.
  cohortA = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('View A', ymd(-30)).run()).meta.last_row_id);
  cohortB = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('View B', ymd(-5)).run()).meta.last_row_id);
});

let tabN = 0;
const newTab = () => (++tabN).toString(16).padStart(12, 'a');
/** Lecture ids are numbers ('L:' videos); free list entries and others are passed as their item key. */
const key = (v: number | string) => (typeof v === 'number' ? `L:${v}` : v);
const claim = (cookie: string, video: number | string, tab: string) => req('/play/claim', { cookie, json: { item: key(video), tab } }).then(json);
const beat = (cookie: string, c: any, tab: string, body: Record<string, unknown>) => req('/play/beat', { cookie, json: { sid: c.sid, nonce: c.nonce, tab, playing: true, pos: 0, dur: 100, add: [], ...body } }).then(json);
/** Pretend the last progress report was long ago, so the 2×-speed limit allows a big jump. */
const rewindBeat = (sid: string) => db.prepare('UPDATE view_sessions SET last_beat_at = last_beat_at - 1000 WHERE id = ?').bind(sid).run();
const session = (sid: string) => db.prepare('SELECT * FROM view_sessions WHERE id = ?').bind(sid).first<any>();
/** Watch 65 of 100 seconds in one session. */
async function watch65(cookie: string, lectureId: number | string, tab: string) {
  const c = await claim(cookie, lectureId, tab);
  expect(c.state, JSON.stringify(c)).toBe('ok');
  await beat(cookie, c, tab, { add: [] });
  await rewindBeat(c.sid);
  const r = await beat(cookie, c, tab, { add: [[0, 65]], pos: 65 });
  expect(r.state).toBe('done');
  return c;
}

describe('unique seconds', () => {
  it('counts each second once and respects the limit', () => {
    let m = markSeconds('', 100, [[0, 10], [5, 15]], 1000);
    expect(m.total).toBe(15);
    m = markSeconds(m.hex, 100, [[10, 20]], 3);
    expect(m.added).toBe(3);
    expect(m.total).toBe(18);
  });
});

describe('paid lectures: 5 views, 65% or 24 hours', () => {
  it('a viewing starts at playback, ends at 65% unique content, and the 6th viewing is locked', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const tab = newTab();
    const c = await claim(s.cookie, lec, tab);
    expect(c).toMatchObject({ state: 'ok', first: true, wm: { id: s.id } });
    expect(c.src).toContain('iframe.mediadelivery.net/embed/785730/vid-abc?token=');
    expect(c.wm.code).toBe(c.sid);
    // Nothing starts until playback actually begins.
    await beat(s.cookie, c, tab, { playing: false });
    expect((await session(c.sid)).started_at).toBeNull();
    await beat(s.cookie, c, tab, { playing: true });
    const st = await session(c.sid);
    expect(st.expires_at - st.started_at).toBe(86400);
    // Faking progress faster than 2× speed is capped.
    const fast = await beat(s.cookie, c, tab, { add: [[0, 90]] });
    expect(fast.state).toBe('ok');
    expect((await session(c.sid)).watched_seconds).toBeLessThan(40);
    // Rewatching the same part counts once; reaching 65% ends the viewing and marks the lecture watched.
    await rewindBeat(c.sid);
    expect((await beat(s.cookie, c, tab, { add: [[0, 30], [0, 30]] })).state).toBe('ok');
    await rewindBeat(c.sid);
    expect(await beat(s.cookie, c, tab, { add: [[30, 66]], pos: 66 })).toEqual({ state: 'done', reason: '65%' });
    expect(await db.prepare('SELECT completed_at FROM lecture_progress WHERE user_id = ? AND lecture_id = ?').bind(s.id, lec).first()).not.toBeNull();
    // The next viewing resumes where they stopped and no longer shows the first-time notice.
    const again = await claim(s.cookie, lec, tab);
    expect(again).toMatchObject({ state: 'ok', first: false, pos: 66 });
    expect(again.sid).not.toBe(c.sid);
    for (let i = 0; i < 4; i++) await watch65(s.cookie, lec, tab);
    const locked = await claim(s.cookie, lec, tab);
    expect(locked).toMatchObject({ state: 'locked', allowed: 5, used: 5 });
    expect(locked.src).toBeUndefined();
  });

  it('a started viewing uses its view when its 24 hours end, even below 65%; an unstarted one never does', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const tab = newTab();
    const c1 = await claim(s.cookie, lec, tab);
    const c2 = await claim(s.cookie, lec, tab);
    expect(c2.sid).toBe(c1.sid);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND counted = 1').bind(s.id).first<any>()).n).toBe(0);
    await beat(s.cookie, c2, tab, { add: [] });
    await db.prepare('UPDATE view_sessions SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 1, c1.sid).run();
    expect(await beat(s.cookie, c2, tab, {})).toEqual({ state: 'done', reason: 'expired' });
    expect(await session(c1.sid)).toMatchObject({ counted: 1, counted_reason: 'expired' });
    const c3 = await claim(s.cookie, lec, tab);
    expect(c3.sid).not.toBe(c1.sid);
  });

  it('progress sent late (after a dropped connection) still starts the viewing and counts', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const tab = newTab();
    const c = await claim(s.cookie, lec, tab);
    expect((await beat(s.cookie, c, tab, { playing: false, add: [[0, 20]], pos: 20 })).state).toBe('ok');
    expect(await session(c.sid)).toMatchObject({ watched_seconds: 20 });
    expect((await session(c.sid)).started_at).not.toBeNull();
  });

  it('End Lecture frees the tab and resuming keeps the same viewing, with no extra view used', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const tab = newTab();
    const c = await claim(s.cookie, lec, tab);
    await beat(s.cookie, c, tab, { add: [], pos: 12 });
    await req('/play/release', { cookie: s.cookie, json: { tab } });
    const back = await claim(s.cookie, lec, newTab());
    expect(back.sid).toBe(c.sid);
    expect((await session(c.sid)).counted).toBe(0);
  });

  it('a new paid enrollment brings 5 fresh views; owner-only extra views', async () => {
    const s = await account();
    const e1 = await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const tab = newTab();
    for (let i = 0; i < 5; i++) await watch65(s.cookie, lec, tab);
    expect((await claim(s.cookie, lec, tab)).state).toBe('locked');
    // The student asks; an admin who is not the owner cannot decide; the owner can.
    expect(await json(await req('/play/request', { cookie: s.cookie, json: { item: key(lec) } }))).toEqual({ ok: true });
    expect((await claim(s.cookie, lec, tab)).requested).toBe(true);
    const admin = await account('admin');
    const owner = await account('owner');
    const grant = { user_id: String(s.id), item: key(lec), kind: 'paid', extra: '1', reason: 'Internet outage' };
    expect((await req('/admin/views', { cookie: admin.cookie })).status).toBe(200);
    expect((await req('/admin/views/grant', { cookie: admin.cookie, form: grant })).status).toBe(403);
    expect((await req('/admin/views/grant', { cookie: (await account('faculty')).cookie, form: grant })).status).toBe(404);
    expect((await req('/admin/views/grant', { cookie: s.cookie, form: grant })).status).toBe(404);
    expect((await req('/admin/views/grant', { cookie: owner.cookie, form: grant })).status).toBe(302);
    expect((await claim(s.cookie, lec, tab)).state).toBe('ok');
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'views.granted' AND target_user_id = ?").bind(s.id).first()).not.toBeNull();
    // A renewal: the old enrollment ends, a new one starts with 5 fresh views (history kept).
    await db.prepare("UPDATE enrollments SET status = 'cancelled' WHERE id = ?").bind(e1).run();
    await enroll(s.id, cohortA);
    const fresh = await claim(s.cookie, lec, tab);
    expect(fresh.state).toBe('ok');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND counted = 1').bind(s.id).first<any>()).n).toBe(5);
  });

  it('another cohort’s lecture, or no program at all, gets no video link', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const other = await lecture(cohortB);
    const r = await req('/play/claim', { cookie: s.cookie, json: { item: key(other), tab: newTab() } });
    expect(r.status).toBe(403);
    const none = await account();
    expect((await req('/play/claim', { cookie: none.cookie, json: { item: key(other), tab: newTab() } })).status).toBe(403);
    expect((await req('/play/claim', { json: { item: key(other), tab: newTab() } })).status).toBe(401);
  });

  it('the lecture page carries no video link: only the claim gives one', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const lec = await lecture(cohortA);
    const html = await (await req(`/lectures/${lec}`, { cookie: s.cookie })).text();
    expect(html).toContain('id="pp"');
    expect(html).not.toContain('mediadelivery.net/embed');
  });

  it('staff can watch without limits or viewing sessions', async () => {
    const f = await account('faculty');
    const lec = await lecture(cohortB);
    const c = await claim(f.cookie, lec, newTab());
    expect(c).toMatchObject({ state: 'ok', sid: 'staff' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ?').bind(f.id).first<any>()).n).toBe(0);
  });
});

describe('one protected lecture tab (R060–R062)', () => {
  it('blocks a second tab until the first ends, closes or goes quiet for 2 minutes', async () => {
    const s = await account();
    await enroll(s.id, cohortA);
    const l1 = await lecture(cohortA);
    const l2 = await lecture(cohortA);
    const t1 = newTab(), t2 = newTab();
    const a = await claim(s.cookie, l1, t1);
    expect(a.state).toBe('ok');
    expect(await claim(s.cookie, l2, t2)).toMatchObject({ state: 'busy', title: 'Lecture ' + (day - 1) });
    // Reloading the same tab is fine.
    const reload = await claim(s.cookie, l1, t1);
    expect(reload.state).toBe('ok');
    // The old page of that tab is told it lost the slot.
    expect((await beat(s.cookie, a, t1, {})).state).toBe('tab');
    await req('/play/release', { cookie: s.cookie, json: { tab: t1 } });
    const b = await claim(s.cookie, l2, t2);
    expect(b.state).toBe('ok');
    expect((await claim(s.cookie, l1, t1)).state).toBe('busy');
    // Two minutes without a signal releases it.
    await db.prepare('UPDATE play_tabs SET seen_at = seen_at - 121 WHERE user_id = ?').bind(s.id).run();
    expect((await claim(s.cookie, l1, t1)).state).toBe('ok');
    expect((await beat(s.cookie, b, t2, {})).state).toBe('tab');
  });
});

describe('Free Lectures list (R035–R046)', () => {
  it('admins add entries, only the owner publishes; signed-in students get 2 views; unpublishing revokes; re-publishing keeps counts', async () => {
    const admin = await account('admin');
    const owner = await account('owner');
    const faculty = await account('faculty');
    const s = await account();
    const lec = await lecture(cohortB);
    const tab = newTab();
    expect((await req('/play/claim', { cookie: s.cookie, json: { item: key(lec), tab } })).status).toBe(403);
    expect((await req('/admin/free-lectures', { cookie: faculty.cookie, form: { lecture: String(lec) } })).status).toBe(404);
    expect((await req('/admin/free-lectures', { cookie: s.cookie, form: { lecture: String(lec) } })).status).toBe(404);
    await req('/admin/free-lectures', { cookie: admin.cookie, form: { lecture: String(lec), category: 'sample' } });
    const f = (await db.prepare('SELECT id, published FROM free_videos WHERE source = ?').bind(`L:${lec}`).first<{ id: number; published: number }>())!;
    expect(f.published).toBe(0);
    const item = `F:${f.id}`;
    // Not published yet: nothing plays, and the original lecture is still paid-only.
    expect((await req('/play/claim', { cookie: s.cookie, json: { item, tab } })).status).toBe(403);
    expect((await req(`/admin/free-lectures/${f.id}/publish`, { cookie: admin.cookie, form: { on: '1' } })).status).toBe(403);
    expect((await req(`/admin/free-lectures/${f.id}/publish`, { cookie: owner.cookie, form: { on: '1' } })).status).toBe(302);
    expect(await (await req('/free-lectures', { cookie: s.cookie })).text()).toContain(`/free-lectures/${f.id}`);
    expect((await req(`/free-lectures/${f.id}`, { cookie: s.cookie })).status).toBe(200);
    // The free entry never opens the paid lecture itself.
    expect((await req('/play/claim', { cookie: s.cookie, json: { item: key(lec), tab } })).status).toBe(403);
    await watch65(s.cookie, item, tab);
    const c = await claim(s.cookie, item, tab);
    expect(c.state).toBe('ok');
    await beat(s.cookie, c, tab, {});
    // Unpublished while watching: the player stops and no new link is given.
    await req(`/admin/free-lectures/${f.id}/publish`, { cookie: owner.cookie, form: { on: '0' } });
    expect((await beat(s.cookie, c, tab, {})).state).toBe('gone');
    expect((await req('/play/claim', { cookie: s.cookie, json: { item, tab } })).status).toBe(403);
    expect((await req(`/free-lectures/${f.id}`, { cookie: s.cookie })).status).toBe(404);
    // Published again: earlier views still count.
    await req(`/admin/free-lectures/${f.id}/publish`, { cookie: owner.cookie, form: { on: '1' } });
    const resumed = await claim(s.cookie, item, tab);
    expect(resumed.sid).toBe(c.sid);
    await rewindBeat(c.sid);
    expect((await beat(s.cookie, resumed, tab, { add: [[0, 70]] })).state).toBe('done');
    expect(await claim(s.cookie, item, tab)).toMatchObject({ state: 'locked', allowed: 2 });
    // Buying the program that includes it gives the 5 paid views instead (R046).
    await enroll(s.id, cohortB);
    expect(await claim(s.cookie, item, tab)).toMatchObject({ state: 'redirect', url: `/lectures/${lec}` });
    expect((await claim(s.cookie, lec, tab)).state).toBe('ok');
    expect((await req(`/free-lectures/${f.id}`, { cookie: s.cookie })).headers.get('location')).toBe(`/lectures/${lec}`);
  });

  it('needs the phone, exam and graduation year; signed-out visitors get nothing', async () => {
    const owner = await account('owner');
    const r = await req('/admin/free-lectures', { cookie: owner.cookie, form: { bunny: 'info-video-123', title: 'About USMLE100', category: 'info', minutes: '3' } });
    expect(r.status).toBe(302);
    const f = (await db.prepare("SELECT id FROM free_videos WHERE source = 'V:info-video-123'").first<{ id: number }>())!;
    await req(`/admin/free-lectures/${f.id}/publish`, { cookie: owner.cookie, form: { on: '1' } });
    const s = await account();
    await db.prepare('UPDATE users SET phone = NULL WHERE id = ?').bind(s.id).run();
    expect(await claim(s.cookie, `F:${f.id}`, newTab())).toEqual({ state: 'profile' });
    expect((await req('/play/claim', { json: { item: `F:${f.id}`, tab: newTab() } })).status).toBe(401);
    await db.prepare("UPDATE users SET phone = '+447700900123' WHERE id = ?").bind(s.id).run();
    const ok = await claim(s.cookie, `F:${f.id}`, newTab());
    expect(ok.state).toBe('ok');
    expect(ok.src).toContain('/info-video-123?token=');
  });
});
