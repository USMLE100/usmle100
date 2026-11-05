import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';
import { toCsv } from '../src/lib/csv';

// Regression tests for the independent pre-launch security review (2 Nov 2026). Each one is the reviewer's
// working attack, which must now fail.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PASSWORD = 'correct-horse-battery';

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) { init.method = 'POST'; init.body = new URLSearchParams(opts.form); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (opts.json !== undefined) { init.method = 'POST'; init.body = JSON.stringify(opts.json); headers['content-type'] = 'application/json'; }
  return worker.fetch(new Request(BASE + path, init));
}
let n = 0;
async function acct(tag: string) {
  const email = `${tag}-${++n}-${Date.now()}@example.com`;
  const r = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD } });
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  return { email, id, cookie: cookies(r), device: cookies(r).split('; ').filter((x) => x.startsWith('u100_device=')).join('; ') };
}

describe('pre-launch review fixes', () => {
  it('a stolen staff password alone cannot get past the passkey step', async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('staff_passkeys','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const a = await acct('victim');
    await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(a.id).run();
    await db.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, counter, name) VALUES (?, ?, 'AAAA', 0, 'Victim key')").bind(a.id, 'cred-' + a.id).run();
    const s = await req('/sign-in', { cookie: a.device, form: { email: a.email, password: PASSWORD } });
    expect(s.headers.get('location')).toMatch(/^\/account\/passkey\/sign-in/);
    const ck = [cookies(s), a.device].filter(Boolean).join('; ');
    // Nothing but the passkey step opens: not admin pages, not exports, not recovery codes, not adding or removing passkeys.
    expect((await req('/admin/students/directory', { cookie: ck })).headers.get('location')).toMatch(/^\/account\/passkey\/sign-in/);
    const csv = await req('/admin/students/export.csv', { cookie: ck });
    expect(csv.status).toBe(302);
    expect(csv.headers.get('content-type') ?? '').not.toContain('csv');
    const codes = await req('/account/passkeys/codes', { cookie: ck, form: {} });
    expect(codes.status).not.toBe(200);
    expect(await codes.text()).not.toMatch(/[A-Z2-9]{5}-[A-Z2-9]{5}/);
    expect((await req('/account/passkeys/options', { cookie: ck, json: {} })).status).not.toBe(200);
    expect((await req('/account/passkeys', { cookie: ck })).status).toBe(302);
    // The session is not a "fresh confirmation" either.
    const row = await db.prepare('SELECT reauth_at FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').bind(a.id).first<{ reauth_at: number | null }>();
    expect(row!.reauth_at).toBeNull();
  });

  it('app routes ending in a file extension still pass the account checks', async () => {
    const s = await acct('susp');
    const cohort = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Ext', date('now','-3 days'))").run()).meta.last_row_id);
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, cohort_id) VALUES (?, 'max', 'active', datetime('now'), ?)").bind(s.id, cohort).run();
    await db.prepare("UPDATE users SET status='suspended' WHERE id=?").bind(s.id).run();
    for (const p of ['/evening/5.00', '/dashboard.json', '/lectures/1.css']) {
      const r = await req(p, { cookie: s.cookie });
      expect([302, 404], p).toContain(r.status);
      if (r.status === 302) expect(r.headers.get('location'), p).toBe('/account/suspended');
    }
  });

  it('a non-owner admin cannot make reset links for staff or the owner, nor reach owner-only actions with odd ids', async () => {
    // Passkeys are covered above; here the admin acts straight after a password sign-in.
    await db.prepare("UPDATE settings SET value = '0' WHERE key = 'staff_passkeys'").run();
    const admin = await acct('adm');
    await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(admin.id).run();
    const owner = await acct('own');
    await makeOwner(db, owner.email);
    const other = await acct('adm2');
    await db.prepare("UPDATE users SET role='faculty' WHERE id=?").bind(other.id).run();
    for (const target of [owner.email, other.email]) {
      const rl = await req('/admin/reset-link', { cookie: admin.cookie, form: { email: target } });
      expect(rl.status).toBe(302);
      expect(rl.headers.get('location')).toMatch(/error=/);
      expect(await rl.text()).not.toMatch(/token=/);
    }
    // Student links still work for admins.
    const stu = await acct('stu');
    expect(await (await req('/admin/reset-link', { cookie: admin.cookie, form: { email: stu.email } })).text()).toMatch(/token=/);

    const e = await db.prepare("INSERT INTO enrollments (user_id, package_id, status, amount_cents) VALUES (?, 'max', 'active', 100)").bind(stu.id).run();
    const eid = Number(e.meta.last_row_id);
    for (const id of [`0x${eid.toString(16)}`, `${eid}.0`, `+${eid}`]) {
      const r = await req(`/admin/students/${id}/lectures`, { cookie: admin.cookie, form: { until: '2099-01-01' } });
      expect([403, 404], id).toContain(r.status);
    }
    expect((await db.prepare('SELECT lectures_until FROM enrollments WHERE id=?').bind(eid).first<any>()).lectures_until).not.toBe('2099-01-01');
    await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
  });

  it('the owner is never held in an admin-only lock by wrong passwords', async () => {
    const owner = await acct('ownlock');
    await makeOwner(db, owner.email);
    for (let i = 0; i < 6; i++) await req('/sign-in', { form: { email: owner.email, password: 'wrong-' + i } });
    expect(await db.prepare('SELECT 1 FROM account_locks WHERE email = ? AND unlocked_at IS NULL').bind(owner.email).first()).toBeNull();
    const stu = await acct('stulock');
    for (let i = 0; i < 6; i++) await req('/sign-in', { form: { email: stu.email, password: 'wrong-' + i } });
    expect(await db.prepare('SELECT 1 FROM account_locks WHERE email = ? AND unlocked_at IS NULL').bind(stu.email).first()).not.toBeNull();
  });

  it('/admin opens the admin area for staff and stays closed to students', async () => {
    const stu = await acct('adminroot');
    const r = await req('/admin', { cookie: stu.cookie });
    expect(r.headers.get('location') ?? '').not.toBe('/admin/lectures');
    const own = await acct('adminrootown');
    await makeOwner(db, own.email);
    await db.prepare("UPDATE settings SET value = '0' WHERE key = 'staff_passkeys'").run();
    try {
      expect((await req('/admin', { cookie: own.cookie })).headers.get('location')).toBe('/admin/lectures');
    } finally {
      await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
    }
  });

  it('plain http is redirected to https (and http form posts refused); local development is unaffected', async () => {
    const r = await worker.fetch(new Request('http://usmle100.test/programs?x=1', { redirect: 'manual' }));
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://usmle100.test/programs?x=1');
    expect((await worker.fetch(new Request('http://usmle100.test/sign-in', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).status).toBe(400);
    expect((await worker.fetch(new Request('http://127.0.0.1/programs', { redirect: 'manual' }))).status).toBe(200);
  });

  it('sign-in never sends people to another site', async () => {
    const a = await acct('redir');
    for (const next of ['/\\evil.example', '//evil.example', '/\tevil']) {
      const r = await req('/sign-in', { cookie: a.device, form: { email: a.email, password: PASSWORD, next } });
      expect(new URL(r.headers.get('location')!, BASE).host, next).toBe('usmle100.test');
    }
  });

  it('exports neutralise spreadsheet formulas but keep plain numbers', () => {
    expect(toCsv([['=HYPERLINK("x")', '+1+1', '@SUM(A1)', '-5', '12.5', 'Maya']])).toBe(`"'=HYPERLINK(""x"")",'+1+1,'@SUM(A1),-5,12.5,Maya`);
  });
});

describe('Bunny player link', () => {
  it('turns off casting and the native iPhone player, and stays signed', async () => {
    const { bunnyEmbedUrl } = await import('../src/lib/content');
    const u = new URL((await bunnyEmbedUrl({ BUNNY_LIBRARY_ID: '785730', BUNNY_TOKEN_KEY: 'k' } as any, 'vid-1'))!);
    expect(u.origin + u.pathname).toBe('https://iframe.mediadelivery.net/embed/785730/vid-1');
    for (const [k, v] of [['disableAirPlay', 'true'], ['chromecast', 'false'], ['disableIosPlayer', 'true'], ['rememberPosition', 'false'], ['preload', 'false'], ['levelCap', 'true']]) expect(u.searchParams.get(k), k).toBe(v);
    expect(u.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('one agreement box at sign-up', () => {
  it('sign-up needs the box; acceptance is recorded', async () => {
    const { agree, ...noBox } = SIGNUP as any;
    const email = `agree-${Date.now()}@example.com`;
    const r = await req('/sign-up', { form: { ...noBox, email, password: PASSWORD } });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/18 or older/);
    expect(await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()).toBeNull();
    const ok = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD } });
    expect(ok.status).toBe(302);
    const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'terms.accepted' AND target_user_id = ?").bind(id).first()).not.toBeNull();
    // Version-specific evidence: box wording, policy hashes that match stored full texts, time and browser.
    const acc = await db.prepare('SELECT * FROM terms_acceptances WHERE user_id = ?').bind(id).first<any>();
    expect(acc.checkbox_text).toMatch(/18 or older.*arbitration/);
    expect(acc.accepted_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    for (const [h, kind] of [[acc.terms_hash, 'terms'], [acc.privacy_hash, 'privacy'], [acc.refund_hash, 'refund']]) {
      expect(await db.prepare('SELECT 1 FROM policy_versions WHERE hash = ? AND kind = ?').bind(h, kind).first(), kind).not.toBeNull();
    }
    const page = await (await req('/sign-up')).text();
    expect((page.match(/name="agree"/g) ?? []).length).toBe(1);
  });
});
