import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SIGNUP, cookies } from './owner';
import { checkCode, notify, retryNotices, sendCode, syncMarketing, emailStaffAlerts } from '../src/lib/messaging';
import { signInRisk } from '../src/lib/risk';

// Email (Resend), SMS (Twilio) and Sender are off in the real config until their keys exist. Here they're switched on
// with fake keys and every call to them is mocked, to check USMLE100's own logic.
const db = (env as any).DB as D1Database;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const on = { ...(env as any), RESEND_API_KEY: 're_test', EMAIL_FROM: 'USMLE100 <no-reply@usmle100.com>', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550000000', SENDER_API_KEY: 'snd', OWNER_ALERT_EMAIL: 'owner@example.com' };
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function account() {
  const email = `msg${++n}-${Date.now()}@example.com`;
  const res = await worker.fetch(new Request('https://usmle100.test/sign-up', { method: 'POST', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: 'https://usmle100.test', 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }));
  cookies(res);
  return (await db.prepare('SELECT id, email, phone FROM users WHERE email = ?').bind(email).first<{ id: number; email: string; phone: string }>())!;
}
function mockProviders(fail: { email?: boolean; sms?: boolean } = {}) {
  const sent: { to: string; body: string; via: string }[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const b = JSON.parse(init.body);
      sent.push({ to: b.to[0], body: b.subject + ' ' + b.text, via: 'email' });
      return new Response('{}', { status: fail.email ? 500 : 200 });
    }
    if (url.startsWith('https://api.twilio.com/')) {
      const b = new URLSearchParams(init.body);
      sent.push({ to: b.get('To')!, body: b.get('Body')!, via: 'sms' });
      return new Response('{}', { status: fail.sms ? 500 : 201 });
    }
    if (url.startsWith('https://api.sender.net/')) {
      sent.push({ to: init.method, body: init.body, via: 'sender' });
      return new Response('{}');
    }
    return real(input, init);
  });
  return sent;
}

beforeAll(async () => {
  await worker.fetch(new Request('https://usmle100.test/'));
});

describe('one-time codes', () => {
  it('are 6 digits, expire, and lock after 5 wrong tries; only a hash is stored', async () => {
    const u = await account();
    const sent = mockProviders();
    expect((await sendCode(on, u.id, 'email', 'verify_email', u.email)).ok).toBe(true);
    const code = /code is (\d{6})/.exec(sent[0].body)![1];
    expect(await db.prepare('SELECT 1 FROM otp_codes WHERE code_hash = ?').bind(code).first()).toBeNull();
    expect(await checkCode(db, u.id, 'email', 'verify_email', '000000')).toBe('wrong');
    expect(await checkCode(db, u.id, 'email', 'verify_email', code)).toBe('ok');
    expect(await checkCode(db, u.id, 'email', 'verify_email', code)).toBe('wrong'); // used up
    await sendCode(on, u.id, 'sms', 'signin', u.phone);
    for (let i = 0; i < 4; i++) expect(await checkCode(db, u.id, 'sms', 'signin', '111111')).toBe('wrong');
    expect(await checkCode(db, u.id, 'sms', 'signin', '111111')).toBe('locked');
    const right = /code is (\d{6})/.exec(sent.at(-1)!.body)![1];
    expect(await checkCode(db, u.id, 'sms', 'signin', right)).toBe('locked');
    // Expired codes don't work.
    await sendCode(on, u.id, 'email', 'reset', u.email);
    const c3 = /code is (\d{6})/.exec(sent.at(-1)!.body)![1];
    await db.prepare("UPDATE otp_codes SET expires_at = 1 WHERE user_id = ? AND purpose = 'reset'").bind(u.id).run();
    expect(await checkCode(db, u.id, 'email', 'reset', c3)).toBe('wrong');
  });

  it('at most 5 codes per hour per channel', async () => {
    const u = await account();
    mockProviders();
    for (let i = 0; i < 5; i++) expect((await sendCode(on, u.id, 'email', 'verify_email', u.email)).ok).toBe(true);
    expect((await sendCode(on, u.id, 'email', 'verify_email', u.email)).ok).toBe(false);
  });
});

describe('messages to students', () => {
  it('always kept in the portal; emailed and texted when set up; nothing sent when not', async () => {
    const u = await account();
    const sent = mockProviders();
    await notify(on, u.id, { kind: 'security', title: 'Test', body: 'Hello', sms: true });
    expect(sent.map((s) => s.via)).toEqual(['email', 'sms']);
    await notify(env as any, u.id, { kind: 'security', title: 'Off', body: 'Nothing sent' });
    expect(sent.length).toBe(2);
    const rows = (await db.prepare('SELECT title, email_status FROM notices WHERE user_id = ? ORDER BY id').bind(u.id).all<any>()).results;
    expect(rows.map((r: any) => [r.title, r.email_status])).toEqual([['Test', 'sent'], ['Off', 'skipped']]);
  });

  it('failed deliveries are retried, then escalated to admins after 1 hour and the owner after 24', async () => {
    const u = await account();
    mockProviders({ email: true, sms: true });
    const id = await notify(on, u.id, { kind: 'security', title: 'Unreachable', body: 'x' });
    await db.prepare("UPDATE notices SET created_at = datetime('now', '-2 hours') WHERE id = ?").bind(id).run();
    await retryNotices(on);
    expect((await db.prepare("SELECT level FROM staff_alerts WHERE kind = 'delivery' AND user_id = ?").bind(u.id).all<any>()).results.map((x: any) => x.level)).toEqual(['warning']);
    await db.prepare("UPDATE notices SET created_at = datetime('now', '-25 hours') WHERE id = ?").bind(id).run();
    await retryNotices(on);
    expect((await db.prepare("SELECT level FROM staff_alerts WHERE kind = 'delivery' AND user_id = ? ORDER BY id").bind(u.id).all<any>()).results.map((x: any) => x.level)).toEqual(['warning', 'critical']);
    expect((await db.prepare('SELECT email_attempts FROM notices WHERE id = ?').bind(id).first<any>()).email_attempts).toBe(3);
  });

  it('warning and critical alerts are emailed to the owner once', async () => {
    const sent = mockProviders();
    await db.prepare("INSERT INTO staff_alerts (level, kind, message) VALUES ('critical', 'test', 'Something urgent')").run();
    await emailStaffAlerts(on);
    await emailStaffAlerts(on);
    expect(sent.filter((s) => s.to === 'owner@example.com' && s.body.includes('Something urgent')).length).toBe(1);
  });
});

describe('risk-based sign-in checks', () => {
  it('flags 30 days without signing in, a new country, and a new device', async () => {
    const u = await account();
    expect(await signInRisk(db, u.id, 'US', false)).toBeNull();
    await db.prepare("INSERT INTO audit_log (at, action, target_user_id, detail, prev_hash, hash) VALUES (?, 'signin.ok', ?, '{\"country\":\"US\"}', 'x', ?)").bind(new Date().toISOString(), u.id, 'h' + u.id + Date.now()).run();
    expect(await signInRisk(db, u.id, 'US', false)).toBeNull();
    expect(await signInRisk(db, u.id, 'BR', false)).toBe('new-country');
    expect(await signInRisk(db, u.id, 'US', true)).toBe('new-device');
    await db.prepare("UPDATE audit_log SET at = ? WHERE target_user_id = ? AND action = 'signin.ok'").bind(new Date(Date.now() - 31 * 86400e3).toISOString(), u.id).run();
    expect(await signInRisk(db, u.id, 'US', false)).toBe('inactive');
  });
});

describe('Sender marketing sync', () => {
  it('sends only students who opted in with a verified email, and removes those who withdraw', async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    await db.prepare("UPDATE users SET marketing_opt_in = 1, email_verified_at = datetime('now') WHERE id = ?").bind(a.id).run();
    await db.prepare('UPDATE users SET marketing_opt_in = 1 WHERE id = ?').bind(b.id).run(); // not verified
    const sent = mockProviders();
    await syncMarketing(on);
    const posted = sent.filter((s) => s.via === 'sender' && s.to === 'POST').map((s) => JSON.parse(s.body).email);
    expect(posted).toContain(a.email);
    expect(posted).not.toContain(b.email);
    expect(posted).not.toContain(c.email);
    await db.prepare('UPDATE users SET marketing_opt_in = 0 WHERE id = ?').bind(a.id).run();
    await syncMarketing(on);
    expect(sent.some((s) => s.via === 'sender' && s.to === 'DELETE' && s.body.includes(a.email))).toBe(true);
  });
});
