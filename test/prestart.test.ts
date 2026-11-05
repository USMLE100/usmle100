import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';

// A student enrolled before their cohort's Day 1 (the November cohort now starts 9 Nov) can use the site.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
describe('before Day 1', () => {
  it('dashboard, lectures and account pages work for an enrolled student whose cohort starts next week', async () => {
    const email = `pre-${Date.now()}@example.com`;
    const r = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
    const cookie = cookies(r);
    const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<any>()).id;
    const start = new Date(Date.now() + 4 * 86400e3).toISOString().slice(0, 10);
    const co = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Pre', ?)").bind(start).run()).meta.last_row_id);
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, amount_cents) VALUES (?, 'companion', 'active', datetime('now'), ?, 138150)").bind(id, co).run();
    await db.prepare("INSERT INTO agreement_signatures (user_id, agreement_id, legal_name, signed_at) SELECT ?, id, 'Pre', datetime('now') FROM agreements ORDER BY id DESC LIMIT 1").bind(id).run().catch(() => {});
    for (const p of ['/dashboard', '/lectures', '/account', '/topics']) {
      const res = await worker.fetch(new Request(BASE + p, { headers: { cookie }, redirect: 'manual' }));
      expect([200, 302], p).toContain(res.status);
      if (res.status === 302) expect(res.headers.get('location'), p).not.toBe('/enroll');
      if (res.status === 200) expect(await res.text(), p).not.toMatch(/Something went wrong/);
    }
  });
});
