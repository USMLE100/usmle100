import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SIGNUP, cookies } from './owner';

// A shared network address (Wi-Fi, mobile carrier, iCloud Private Relay) can reach the address-wide limit through
// other people's mistakes. Students on a device registered to their own account must still get in with the right
// password; anyone else from that address stays locked out, and the per-account limit is unchanged.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const PW = 'correct-horse-battery';

const post = (path: string, form: Record<string, string>, ip: string, cookie = '') =>
  worker.fetch(new Request(BASE + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: BASE, 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) } }));
const signedIn = (r: Response) => r.status === 302 && !/sign-in/.test(r.headers.get('location') ?? '');

describe('sign-in locks', () => {
  it('a shared address that hit the limit does not lock out a student on their own registered device', async () => {
    const ip = '203.0.113.' + Math.floor(Math.random() * 200);
    const email = `shared-${Date.now()}@example.com`;
    const up = await post('/sign-up', { ...SIGNUP, email, password: PW }, '198.51.100.9');
    const device = cookies(up).split('; ').filter((x) => x.startsWith('u100_device=')).join('; ');
    // 20 wrong passwords for other (unknown) accounts from the same address lock the address.
    for (let i = 0; i < 20; i++) await post('/sign-in', { email: `someone${i}@example.com`, password: 'nope' }, ip);
    // Without the student's registered device (an attacker, or a new browser): still locked, even with the right password.
    const stranger = await post('/sign-in', { email, password: PW }, ip);
    expect(stranger.status).toBe(429);
    expect(await stranger.text()).toMatch(/wait \d+ minute/);
    // The student's own registered device with the right password: signed in.
    expect(signedIn(await post('/sign-in', { email, password: PW }, ip, device))).toBe(true);
    // A wrong password from the trusted device is still refused and still counted.
    const wrong = await post('/sign-in', { email, password: 'wrong-one' }, ip, device);
    expect(wrong.status).toBe(401);
    // The refusal is in the sign-in log.
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'signin.refused' AND detail LIKE ?").bind(`%${email}%`).first()).not.toBeNull();
  });

  it('the per-account limit still applies on a trusted device', async () => {
    const email = `acct-${Date.now()}@example.com`;
    const up = await post('/sign-up', { ...SIGNUP, email, password: PW }, '198.51.100.10');
    const device = cookies(up).split('; ').filter((x) => x.startsWith('u100_device=')).join('; ');
    for (let i = 0; i < 5; i++) await post('/sign-in', { email, password: 'bad-' + i }, '198.51.100.10', device);
    const r = await post('/sign-in', { email, password: PW }, '198.51.100.10', device);
    expect(r.status).toBe(429);
    expect(await r.text()).toMatch(/until USMLE100 unlocks it/);
  });
});
