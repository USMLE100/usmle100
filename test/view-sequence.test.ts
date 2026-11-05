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
    expect(row!.diag).toMatch(/^lib loaded · direct not ready · messages 0 · events \{\} · answers 0 · subscribes 0 · other 0 · origins {2}· /);
    expect(row!.diag).not.toMatch(/@|example\.com/);
  });
});

describe('lecture player progress fallback (iPad Safari, 4 Nov 2026)', () => {
  it('the lecture page subscribes again until events arrive and asks the player for its time when none come', async () => {
    const html = await (await worker.fetch(new Request(BASE + `/lectures/${lec}`, { headers: { cookie } }))).text();
    expect(html).toContain('function subscribe()');
    expect(html).toMatch(/\[1500,4000,10000,20000\]/);
    expect(html).toContain("cmd('getCurrentTime',undefined,'g1')");
    expect(html).toContain("d.event==='getCurrentTime'");
  });
});

describe('uninterrupted playback after 90% (owner, 4 Nov 2026)', () => {
  it('a viewing used at 90% keeps its tab and resume point, can be continued to the end, and only within its short window', async () => {
    const lec3 = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) SELECT cohort_id, 3, 'Continue', 'live', 'vid-c', 300 FROM lectures WHERE id = ?").bind(lec).run()).meta.last_row_id);
    const item = `L:${lec3}`;
    await release('dddddddddddd', 0); // the diagnostics test above still holds the one-tab slot
    const c = await post('/play/claim', cookie, { item, tab: 'cccccccccccc' });
    expect(c.state).toBe('ok');
    const r = await play(c, 'cccccccccccc', 0, 280);
    expect(r.state).toBe('done'); // used at 90%; the player keeps playing
    // Playing on to 100%: check-ins still answer, keep the one-tab slot (another tab is refused) and save the position.
    await elapse(c.sid, 30);
    const more = await post('/play/beat', cookie, { sid: c.sid, nonce: c.nonce, tab: 'cccccccccccc', playing: true, pos: 300, dur: LEN, add: [[280, 300]] });
    expect(more.state).toBe('done');
    expect((await post('/play/claim', cookie, { item, tab: 'cccccccccc99' })).state).not.toBe('ok');
    expect((await db.prepare('SELECT seconds FROM video_positions WHERE user_id = ? AND item = ?').bind(uid, item).first<any>()).seconds).toBeGreaterThanOrEqual(270);
    // After a long pause the link is refreshed for the SAME viewing (nothing new counted).
    await release('cccccccccccc', 300);
    const cont = await post('/play/claim', cookie, { item, tab: 'cccccccccccc', continue: c.sid });
    expect(cont).toMatchObject({ state: 'ok', sid: c.sid, completed: true });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND item = ? AND counted = 1').bind(uid, item).first<any>()).n).toBe(1); // still one view used
    // Past its window (30 min + 10% of the lecture), continuing opens no extra time: a new viewing starts as usual.
    await db.prepare('UPDATE view_sessions SET counted_at = counted_at - 7200 WHERE id = ?').bind(c.sid).run();
    await release('cccccccccccc', 300);
    const later = await post('/play/claim', cookie, { item, tab: 'cccccccccccc', continue: c.sid });
    expect(later.state).toBe('ok');
    expect(later.sid).not.toBe(c.sid);
    expect(later.completed).toBeUndefined();
    // Someone else's viewing id can never be continued.
    await release('cccccccccccc', 0);
    const other = await post('/play/claim', cookie, { item, tab: 'cccccccccccc', continue: 'NOTMINE12' });
    expect(other.sid).not.toBe('NOTMINE12');
  });

  it('students see neutral wording; the limits stay disclosed before purchase', async () => {
    const page = await (await worker.fetch(new Request(BASE + `/lectures/${lec}`, { headers: { cookie } }))).text();
    expect(page).toContain('Lecture completed');
    expect(page).toContain('Your lecture access has been completed');
    expect(page).not.toMatch(/watched twice|views left|both views|another view|Request additional view/);
    const home = await (await worker.fetch(new Request(BASE + '/'))).text();
    const programs = await (await worker.fetch(new Request(BASE + '/programs'))).text();
    for (const h of [home, programs]) expect(h).not.toMatch(/watched twice|2 views/);
    const email = `buyer-${Date.now()}@example.com`;
    const su = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
    const enroll = await (await worker.fetch(new Request(BASE + '/enroll', { headers: { cookie: cookies(su) } }))).text();
    expect(enroll).toMatch(/watched twice per enrollment/); // the purchase page still discloses the limit
  });
});
