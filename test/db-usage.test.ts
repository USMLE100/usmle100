import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { SIGNUP, cookies } from './owner';

// Free-plan budget (owner, 2 Nov 2026: stay on Cloudflare's free plan). D1 free: 100,000 rows written and 5,000,000 rows
// read per day; Workers free: 100,000 requests per day. This measures what the busiest requests cost, so the lecture
// check-in (sent all the time while a video plays) stays small. Fails if a change makes them expensive again.
const BASE = 'https://usmle100.test';
const db = (env as any).DB as D1Database;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const self = (exports as any).default as { fetch: (r: Request) => Promise<Response> };

type Tally = { read: number; written: number; statements: number };
function counting(base: D1Database, t: Tally): D1Database {
  const add = (m: any) => {
    t.statements++;
    t.read += m?.rows_read ?? 0;
    t.written += m?.rows_written ?? 0;
  };
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(target, prop) {
        if (prop === 'bind') return (...a: unknown[]) => wrap((target as any).bind(...a));
        if (prop === 'first')
          return async (col?: string) => {
            const r = await target.all();
            add(r.meta);
            const row = (r.results as any[])[0] ?? null;
            return col ? (row ? row[col] : null) : row;
          };
        if (prop === 'all' || prop === 'run')
          return async () => {
            const r = await (target as any)[prop]();
            add(r.meta);
            return r;
          };
        if (prop === 'raw') return async (o?: any) => { const r = await target.all(); add(r.meta); return (target as any).raw(o); };
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return async (sts: D1PreparedStatement[]) => {
          const r = await target.batch(sts.map((s: any) => s.__target ?? s));
          for (const x of r) add(x.meta);
          return r;
        };
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function measure(req: Request) {
  const t: Tally = { read: 0, written: 0, statements: 0 };
  const res = await worker.fetch(req, { ...(env as any), DB: counting(db, t) }, ctx);
  await res.arrayBuffer();
  return { ...t, status: res.status };
}

let cookie = '', lec = 0;
const tab = 'cccccccccccc';
const H = (extra: Record<string, string> = {}) => ({ 'sec-fetch-site': 'same-origin', origin: BASE, cookie, ...extra });

beforeAll(async () => {
  await self.fetch(new Request(BASE + '/'));
  const ymd = (d: number) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const cohort = Number((await db.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind('Budget', ymd(-3)).run()).meta.last_row_id);
  lec = Number((await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id, duration_seconds) VALUES (?, 1, 'Budget lecture', 'live', 'vid-b', 3600)").bind(cohort).run()).meta.last_row_id);
  const email = `budget-${Date.now()}@example.com`;
  const r = await self.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: BASE } }));
  cookie = cookies(r);
  const uid = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(uid, cohort).run();
});

describe('database cost of busy requests (free plan)', () => {
  it('reports and limits rows per request', async () => {
    const claimRes = await self.fetch(new Request(BASE + '/play/claim', { method: 'POST', body: JSON.stringify({ item: `L:${lec}`, tab }), headers: H({ 'content-type': 'application/json' }) }));
    const c = (await claimRes.json()) as any;
    expect(c.state).toBe('ok');
    const beatReq = (add: [number, number][], playing = true, pos = 0) =>
      new Request(BASE + '/play/beat', { method: 'POST', body: JSON.stringify({ sid: c.sid, nonce: c.nonce, tab, playing, pos, dur: 3600, add }), headers: H({ 'content-type': 'application/json' }) });
    // Start playback, then measure steady check-ins while watching.
    await measure(beatReq([], true));
    const rows: Record<string, Awaited<ReturnType<typeof measure>>> = {};
    rows['check-in while playing'] = await measure(beatReq([[0, 1]], true, 1));
    rows['check-in while playing (next)'] = await measure(beatReq([[1, 2]], true, 2));
    rows['check-in while paused'] = await measure(beatReq([], false, 2));
    rows['claim (open lecture)'] = await measure(new Request(BASE + '/play/claim', { method: 'POST', body: JSON.stringify({ item: `L:${lec}`, tab }), headers: H({ 'content-type': 'application/json' }) }));
    rows['dashboard page'] = await measure(new Request(BASE + '/dashboard', { headers: H() }));
    rows['lecture page'] = await measure(new Request(BASE + `/lectures/${lec}`, { headers: H() }));
    rows['session status ping'] = await measure(new Request(BASE + '/session/status', { headers: H() }));
    console.log('\nDB rows per request:\n' + Object.entries(rows).map(([k, v]) => `  ${k.padEnd(32)} written ${String(v.written).padStart(3)}  read ${String(v.read).padStart(5)}  statements ${v.statements}`).join('\n'));
    (globalThis as any).__usage = rows;
    expect(rows['check-in while playing'].status).toBe(200);
    // Budget guard: a playing check-in may write at most 2 rows on average (view progress + tab), plus the resume point
    // about once a minute; pages and pings write nothing.
    expect(rows['check-in while playing (next)'].written).toBeLessThanOrEqual(2);
    expect(rows['dashboard page'].written).toBe(0);
    expect(rows['session status ping'].written).toBe(0);
  });
});
