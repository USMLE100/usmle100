import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP, cookies, makeOwner } from './owner';

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
const cookieOf = (r: Response) => cookies(r);
const loc = (r: Response) => r.headers.get('location') ?? '';

let n = 0;
async function account(role: 'student' | 'faculty' | 'owner') {
  const email = `pk${++n}-${Date.now()}@example.com`;
  const r = await req('/sign-up', { form: { ...SIGNUP, email, password: PASSWORD } });
  const cookie = cookieOf(r);
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id;
  if (role === 'owner') await makeOwner(db, email);
  if (role === 'faculty') await db.prepare("UPDATE users SET role = 'faculty' WHERE id = ?").bind(id).run();
  return { email, cookie, id };
}
/** Sign in again from the same browser (its device cookie comes along). */
const signIn = async (email: string, cookie: string) => {
  const device = cookie.split('; ').filter((x) => x.startsWith('u100_device=')).join('; ');
  const r = await req('/sign-in', { cookie: device, form: { email, password: PASSWORD } });
  return { cookie: [cookieOf(r), device].filter(Boolean).join('; '), location: loc(r) };
};

// ---------- A software authenticator: real P-256 keys, CBOR and signatures ----------

function cbor(v: unknown): number[] {
  const head = (major: number, len: number) => (len < 24 ? [(major << 5) | len] : len < 256 ? [(major << 5) | 24, len] : [(major << 5) | 25, len >> 8, len & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = [...new TextEncoder().encode(v)];
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (v instanceof Map) return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
  throw new Error('cbor: unsupported');
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function derSig(raw: Uint8Array) {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = [...x.slice(i)];
    if (v[0] & 0x80) v = [0, ...v];
    return [2, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

class Authenticator {
  keys!: CryptoKeyPair;
  credId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return this;
  }
  async rpHash() {
    return sha256(new TextEncoder().encode('usmle100.test'));
  }
  async register(challenge: string, origin = BASE) {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const un = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, un(jwk.x!)], [-3, un(jwk.y!)]]));
    const authData = new Uint8Array([...(await this.rpHash()), 0x45, ...be32(0), ...new Uint8Array(16), 0, this.credId.length, ...this.credId, ...cose]);
    const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
    const att = new Uint8Array(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
  }
  async assert(challenge: string, origin = BASE) {
    const authData = new Uint8Array([...(await this.rpHash()), 0x05, ...be32(++this.counter)]);
    const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
    const signed = new Uint8Array([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(derSig(raw)) } };
  }
}

async function addPasskey(cookie: string, auth: Authenticator) {
  const o = (await (await req('/account/passkeys/options', { cookie, json: {} })).json()) as any;
  return (await (await req('/account/passkeys/verify', { cookie, json: { name: 'Test key', response: await auth.register(o.challenge) } })).json()) as any;
}
async function usePasskey(cookie: string, auth: Authenticator, purpose: 'signin' | 'stepup') {
  const o = (await (await req('/account/passkey/options', { cookie, json: { purpose } })).json()) as any;
  return req('/account/passkey/verify', { cookie, json: { purpose, response: await auth.assert(o.challenge) } });
}

beforeAll(async () => {
  await req('/');
  await db.prepare("UPDATE settings SET value = '1' WHERE key = 'staff_passkeys'").run();
});

describe('staff passkeys (R021, phishing-resistant privileged sign-in)', () => {
  it('staff must set up a passkey before using staff tools; students are not affected', async () => {
    const owner = await account('owner');
    const faculty = await account('faculty');
    const student = await account('student');
    expect(loc(await req('/admin/security', { cookie: owner.cookie }))).toBe('/account/passkeys');
    expect(loc(await req('/admin/lectures', { cookie: faculty.cookie }))).toBe('/account/passkeys');
    expect(loc(await req('/dashboard', { cookie: faculty.cookie }))).toBe('/account/passkeys');
    expect(loc(await req('/dashboard', { cookie: student.cookie }))).not.toBe('/account/passkeys');
    // Students can't register staff passkeys.
    expect((await req('/account/passkeys/options', { cookie: student.cookie, json: {} })).status).toBe(403);
  });

  it('sign-in needs the passkey after the password; a wrong key or a replayed challenge fails', async () => {
    const owner = await account('owner');
    const key = await new Authenticator().init();
    const added = await addPasskey(owner.cookie, key);
    expect(added.ok).toBe(true);
    expect(added.codes).toHaveLength(10);
    expect((await req('/admin/security', { cookie: owner.cookie })).status).toBe(200);

    const s = await signIn(owner.email, owner.cookie);
    expect(s.location).toBe('/account/passkey/sign-in?next=%2Fdashboard');
    expect(loc(await req('/admin/security', { cookie: s.cookie }))).toContain('/account/passkey/sign-in');
    expect(loc(await req('/dashboard', { cookie: s.cookie }))).toContain('/account/passkey/sign-in');

    // Another authenticator's signature is refused.
    const stranger = await new Authenticator().init();
    stranger.credId = key.credId;
    expect((await usePasskey(s.cookie, stranger, 'signin')).status).toBe(401);
    // A phishing site's origin is refused.
    const o = (await (await req('/account/passkey/options', { cookie: s.cookie, json: { purpose: 'signin' } })).json()) as any;
    const phished = await key.assert(o.challenge, 'https://usmle100-login.example');
    expect((await req('/account/passkey/verify', { cookie: s.cookie, json: { purpose: 'signin', response: phished } })).status).toBe(401);
    // A challenge works once.
    const o2 = (await (await req('/account/passkey/options', { cookie: s.cookie, json: { purpose: 'signin' } })).json()) as any;
    const good = await key.assert(o2.challenge);
    expect((await req('/account/passkey/verify', { cookie: s.cookie, json: { purpose: 'signin', response: good } })).status).toBe(200);
    expect((await req('/account/passkey/verify', { cookie: s.cookie, json: { purpose: 'signin', response: good } })).status).toBe(401);
    expect((await req('/admin/security', { cookie: s.cookie })).status).toBe(200);
  });

  it('owner-only changes need a fresh passkey confirmation; the password alone no longer works', async () => {
    const owner = await account('owner');
    const key = await new Authenticator().init();
    await addPasskey(owner.cookie, key);
    await db.prepare('UPDATE sessions SET reauth_at = NULL WHERE user_id = ?').bind(owner.id).run();
    expect(loc(await req('/admin/settings', { cookie: owner.cookie, form: { student_count: '9' } }))).toContain('/admin/confirm');
    expect(await (await req('/admin/confirm', { cookie: owner.cookie })).text()).toContain('Confirm with my passkey');
    expect(loc(await req('/admin/confirm', { cookie: owner.cookie, form: { password: PASSWORD, next: '/admin/settings' } }))).toContain('/admin/confirm');
    expect((await usePasskey(owner.cookie, key, 'stepup')).status).toBe(200);
    expect(loc(await req('/admin/security/lockdown', { cookie: owner.cookie, form: { on: '0' } }))).toBe('/admin/security?ok=1');
  });

  it('a recovery code finishes a sign-in once, alerts staff, and can’t be reused', async () => {
    const owner = await account('owner');
    const added = await addPasskey(owner.cookie, await new Authenticator().init());
    const s = await signIn(owner.email, owner.cookie);
    expect(loc(await req('/account/passkey/recovery', { cookie: s.cookie, form: { code: 'WRONG-CODES' } }))).toContain('error=1');
    expect(loc(await req('/account/passkey/recovery', { cookie: s.cookie, form: { code: added.codes[0].toLowerCase() } }))).toBe('/account/passkeys?ok=1');
    expect((await req('/admin/security', { cookie: s.cookie })).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM staff_alerts WHERE kind = 'recovery-code' AND user_id = ?").bind(owner.id).first()).not.toBeNull();
    const s2 = await signIn(owner.email, owner.cookie);
    expect(loc(await req('/account/passkey/recovery', { cookie: s2.cookie, form: { code: added.codes[0] } }))).toContain('error=1');
  });

  it('a second passkey needs a fresh confirmation; the last passkey can’t be removed', async () => {
    const owner = await account('owner');
    const k1 = await new Authenticator().init();
    await addPasskey(owner.cookie, k1);
    await db.prepare('UPDATE sessions SET reauth_at = NULL WHERE user_id = ?').bind(owner.id).run();
    expect((await req('/account/passkeys/options', { cookie: owner.cookie, json: {} })).status).toBe(403);
    await usePasskey(owner.cookie, k1, 'stepup');
    expect((await addPasskey(owner.cookie, await new Authenticator().init())).ok).toBe(true);
    const ids = (await db.prepare('SELECT id FROM passkeys WHERE user_id = ? ORDER BY id').bind(owner.id).all<{ id: number }>()).results;
    expect(loc(await req(`/account/passkeys/${ids[1].id}/remove`, { cookie: owner.cookie, form: {} }))).toBe('/account/passkeys?ok=1');
    expect(loc(await req(`/account/passkeys/${ids[0].id}/remove`, { cookie: owner.cookie, form: {} }))).toContain('error=');
  });
});
