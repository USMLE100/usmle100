import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';

// The owner's real-world QA sequence (4 Nov 2026) on a 5-minute lecture, through the real endpoints:
// open, End Lecture, reopen, refresh, a second device, play to the end twice, then a third attempt.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const post = (path: string, cookie: string, json: unknown) =>
  worker.fetch(new Request(BASE + path, { method: 'POST', body: JSON.stringify(json), headers: { 'sec-fetch-site': 'same-origin', origin: BASE, 'content-type': 'application/json', cookie } })).then((r) => r.json() as Promise<any>);
const LEN = 300;
let lec = 0, cookie = '', uid = 0;
const claim = (tab: string) => post('/play/claim', cookie, { item: `L:${lec}`, tab });
const beat = (c: any, tab: string, b: Record<string, unknown>) => post('/play/beat', cookie, { sid: c.sid, nonce: c.nonce, tab, playing: true, pos: 0, dur: LEN, add: [], ...b });
const release = (tab: string, pos: number) => post('/play/release', cookie, { tab, pos });
/** Real time passing between check-ins (the server allows at most 2× real time of new progress). */
const elapse = (sid: string, s: number) => db.prepare('UPDATE view_sessions SET last_beat_at = last_beat_at - ? WHERE id = ?').bind(s, sid).run();
const sessions = () => db.prepare('SELECT id, started_at, watched_seconds, counted, counted_reason FROM view_sessions WHERE user_id = ? AND item = ? ORDER BY created_at, rowid').bind(uid, `L:${lec}`).all<any>().then((r) => r.results);

/** Plays [from, to) in 30-second check-ins, as the player does, ending with the pause/ended check-in. */
async function play(c: any, tab: string, from: number, to: number) {
  let r: any = await beat(c, tab, { pos: from });
  for (let a = from; a < to; a += 30) {
    const b = Math.min(to, a + 30);
    await elapse(c.sid, 30);
    r = await beat(c, tab, { add: [[a, b]], pos: b, playing: b < to });
    if (r.state !== 'ok') break;
  }
  return r;
}

beforeAll(async () => {
  await worker.fetch(new Request(BASE + '/'));
  const start = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  const cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Sequence', ?)").bind(start).run()).meta.last_row_id);
  lec = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'Five minutes', 'live', 'vid-5', ?)").bind(cohort, LEN).run()).meta.last_row_id);
  const email = `seq-${Date.now()}@example.com`;
  const r = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
  cookie = cookies(r);
  uid = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'refresher', 'active', datetime('now'), ?)").bind(uid, cohort).run();
});

describe('real-world viewing sequence (5-minute lecture)', () => {
  it('End Lecture, reopening, refreshing and a second device resume the same viewing; two full plays use both views; the third is refused', async () => {
    // Open, play 1 minute, End Lecture, reopen: same viewing, nothing used.
    let c = await claim('aaaaaaaaaaa1');
    expect(c.state).toBe('ok');
    const first = c.sid;
    await play(c, 'aaaaaaaaaaa1', 0, 60);
    await release('aaaaaaaaaaa1', 60);
    c = await claim('aaaaaaaaaaa1');
    expect(c.sid).toBe(first);
    // Refresh (a new tab id) and a second device: still the same viewing.
    await release('aaaaaaaaaaa1', 60);
    c = await claim('aaaaaaaaaaa2');
    expect(c.sid).toBe(first);
    await release('aaaaaaaaaaa2', 60);
    // Replaying the same minute from 00:00 adds nothing new.
    c = await claim('aaaaaaaaaaa3');
    await play(c, 'aaaaaaaaaaa3', 0, 60);
    expect((await sessions())[0]).toMatchObject({ watched_seconds: 60, counted: 0 });

    // Play through to the end: the first view is used at 90% (270 of 300 seconds).
    const r1 = await play(c, 'aaaaaaaaaaa3', 60, LEN);
    expect(r1).toMatchObject({ state: 'done', viewsLeft: 1 });
    expect((await sessions()).map((s: any) => s.counted)).toEqual([1]);

    // Start Lecture again: a NEW viewing (the second view); End Lecture and reopen keep it.
    await release('aaaaaaaaaaa3', LEN);
    c = await claim('aaaaaaaaaaa3');
    expect(c.state).toBe('ok');
    expect(c.sid).not.toBe(first);
    const second = c.sid;
    await play(c, 'aaaaaaaaaaa3', 0, 120);
    await release('aaaaaaaaaaa3', 120);
    c = await claim('aaaaaaaaaaa4');
    expect(c.sid).toBe(second);
    const r2 = await play(c, 'aaaaaaaaaaa4', 120, LEN);
    expect(r2).toMatchObject({ state: 'done', viewsLeft: 0 });

    // Third attempt, from any tab or device: refused, with no video link; the request option is offered.
    await release('aaaaaaaaaaa4', LEN);
    for (const tab of ['aaaaaaaaaaa4', 'aaaaaaaaaaa5']) {
      const third = await claim(tab);
      expect(third.state).toBe('locked');
      expect(third.src).toBeUndefined();
      expect(third).toMatchObject({ allowed: 2, used: 2, request: true });
    }
    expect((await sessions()).map((s: any) => [s.counted, s.counted_reason])).toEqual([[1, '65%'], [1, '65%']]);
  });


  it('saves what the page heard from the player on the viewing (no personal data), in the same write as the check-in', async () => {
    const lec2 = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) SELECT cohort_id, 2, 'Diag', 'live', 'vid-d', 300 FROM lectures WHERE id = ?").bind(lec).run()).meta.last_row_id);
    const c = await post('/play/claim', cookie, { item: `L:${lec2}`, tab: 'dddddddddddd' });
    expect(c.state).toBe('ok');
    const diag = { lib: true, libReady: false, rawReady: false, msgs: 0, ev: {}, origins: [] };
    const r = await post('/play/beat', cookie, { sid: c.sid, nonce: c.nonce, tab: 'dddddddddddd', playing: false, pos: 0, dur: 0, add: [], diag });
    expect(r.state).toBe('ok');
    const row = await db.prepare('SELECT diag FROM view_sessions WHERE id = ?').bind(c.sid).first<{ diag: string }>();
    expect(row!.diag).toMatch(/^lib loaded · direct not ready · messages 0 · events \{\} · origins {2}· /);
    expect(row!.diag).not.toMatch(/@|example\.com/);
  });
});
