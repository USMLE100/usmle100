import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';

// Build v4 loading screen (owner, 5 Nov 2026): visual only, dashboard only, hidden unless the sign-in page just sent the student.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const get = (p: string, cookie = '') => worker.fetch(new Request(BASE + p, { headers: { cookie }, redirect: 'manual' }));

describe('loading screen', () => {
  it('the sign-in page only adds a note-in-this-tab script; sign-in itself is unchanged', async () => {
    const html = await (await get('/sign-in')).text();
    expect(html).toContain("sessionStorage.setItem('u100-splash','1')");
    expect(html).not.toContain('id="u100-splash"');
    expect(await (await get('/sign-up')).text()).not.toContain('u100-splash');
  });
  it('appears (hidden by default) on the dashboard only, removes itself, and never on public pages', async () => {
    const email = `splash-${Date.now()}@example.com`;
    const r = await worker.fetch(new Request(BASE + '/sign-up', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: BASE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } }));
    const cookie = cookies(r);
    const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<any>()).id;
    const co = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Splash', date('now','-2 days'))").run()).meta.last_row_id);
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id, amount_cents) VALUES (?, 'refresher', 'active', datetime('now'), ?, 150000)").bind(id, co).run();
    await db.prepare("INSERT INTO agreement_signatures (user_id, agreement_id, legal_name, email, birth_date, body_hash) SELECT ?, id, 'S', ?, '', body_hash FROM agreements ORDER BY id DESC LIMIT 1").bind(id, email).run();
    const res = await get('/dashboard', cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<div id="u100-splash" hidden/);
    expect(html).toContain('setTimeout(hide,4500)');
    expect(html).toContain('prefers-reduced-motion');
    for (const p of ['/', '/programs', '/sign-in']) expect(await (await get(p, cookie)).text(), p).not.toContain('id="u100-splash"');
  });
});
