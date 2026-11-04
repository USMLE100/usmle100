import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import sql from '../migrations/0027_qa_test_cohort.sql';
import offSql from '../migrations/0028_qa_test_cohort_off.sql';
import { statements } from '../src/lib/migrate';
import { SIGNUP, cookies } from './owner';

// The private player-test cohort: only a student given a program in it sees the test recording; everyone else,
// and every new purchase, is unaffected.
const BASE = 'https://usmle100.test';
const db = (env as any).DB as D1Database;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const req = (path: string, cookie?: string, json?: unknown) =>
  worker.fetch(new Request(BASE + path, { method: json ? 'POST' : 'GET', redirect: 'manual', body: json ? JSON.stringify(json) : undefined, headers: { 'sec-fetch-site': 'same-origin', origin: BASE, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }));
let n = 0;
async function student(cohortId: number) {
  const email = `qa${++n}-${Date.now()}@example.com`;
  const r = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(id, cohortId).run();
  return cookies(r);
}

describe('QA test cohort (0027)', () => {
  it('is a no-op on a non-production database', async () => {
    await req('/');
    await db.prepare("INSERT INTO settings (key, value) VALUES ('db_environment', 'development') ON CONFLICT (key) DO UPDATE SET value = 'development'").run();
    await db.prepare("INSERT INTO zoom_imports (zoom_file_id, meeting_id, topic, bunny_video_id, declined_at) VALUES ('qa-file', '1', 'Test', 'vid-declined-test', datetime('now'))").run();
    for (const s of statements(sql)) await db.prepare(s).run();
    expect(await db.prepare("SELECT 1 FROM cohorts WHERE name LIKE 'QA test%'").first()).toBeNull();
  });
  it('on production: one private cohort with the declined recording, visible only to its own students, never the latest cohort', async () => {
    const real = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Fall 2026 (test)', '2026-11-02')").run()).meta.last_row_id);
    await db.prepare("UPDATE settings SET value = 'production' WHERE key = 'db_environment'").run();
    try {
      for (const s of statements(sql)) await db.prepare(s).run();
      for (const s of statements(sql)) await db.prepare(s).run(); // twice: no duplicates
    } finally {
      await db.prepare("UPDATE settings SET value = 'development' WHERE key = 'db_environment'").run();
    }
    const qa = await db.prepare("SELECT id FROM cohorts WHERE name LIKE 'QA test%'").all<{ id: number }>();
    expect(qa.results.length).toBe(1);
    const lec = await db.prepare('SELECT * FROM lectures WHERE cohort_id = ?').bind(qa.results[0].id).all<any>();
    expect(lec.results.length).toBe(1);
    expect(lec.results[0]).toMatchObject({ status: 'live', bunny_video_id: 'vid-declined-test' });
    // Not the cohort new purchases join.
    expect((await db.prepare('SELECT id FROM cohorts ORDER BY start_date DESC LIMIT 1').first<{ id: number }>())!.id).not.toBe(qa.results[0].id);
    const item = { item: `L:${lec.results[0].id}`, tab: 'abcabcabcabc' };
    // A real-cohort student: no page, no video link.
    const other = await student(real);
    expect((await req(`/lectures/${lec.results[0].id}`, other)).status).toBe(404);
    expect(((await (await req('/play/claim', other, item)).json()) as any).state).not.toBe('ok');
    // The test student in the QA cohort: a signed, watermarked link.
    const tester = await student(qa.results[0].id);
    const c = (await (await req('/play/claim', tester, item)).json()) as any;
    expect(c.state).toBe('ok');
    expect(c.src).toMatch(/token=[0-9a-f]{64}&expires=\d+/);
    expect(c.wm.code).toBe(c.sid);
    // Retiring it (0028, prepared for after the owner's test): the tester loses the video, other cohorts are untouched.
    const realLecture = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id) VALUES (?, 1, 'Real', 'live', 'vid-real')").bind(real).run()).meta.last_row_id);
    for (const s of statements(offSql)) await db.prepare(s).run();
    expect(((await (await req('/play/claim', tester, { item: item.item, tab: 'abcabcabcab9' })).json()) as any).state).not.toBe('ok');
    expect(await db.prepare("SELECT 1 FROM cohorts WHERE name = 'QA test (retired)'").first()).not.toBeNull();
    expect(await db.prepare('SELECT status, bunny_video_id FROM lectures WHERE id = ?').bind(realLecture).first()).toEqual({ status: 'live', bunny_video_id: 'vid-real' });
    expect(((await (await req('/play/claim', other, { item: `L:${realLecture}`, tab: 'abcabcabca10' })).json()) as any).state).toBe('ok');
  });
});
