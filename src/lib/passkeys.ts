/**
 * Passkeys (WebAuthn / FIDO2) for staff: phishing-resistant sign-in and fresh confirmation for owner-only changes.
 * Uses @simplewebauthn/server (pure JavaScript, runs on Workers). The browser side is in views/passkeyJs.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Context } from 'hono';
import type { AppEnv, User } from './types';
import { isStaff } from './types';
import { sha256Hex } from './auth';

const CHALLENGE_SECONDS = 300;
export const RECOVERY_CODE_COUNT = 10;
const epoch = () => Math.floor(Date.now() / 1000);

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

/** The site's own address: WebAuthn ties every passkey to it, so a look-alike site can never use one. */
export function relyingParty(c: Context<AppEnv>) {
  const url = new URL(c.env.SITE_URL || c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

/** Staff must have a passkey before using staff tools (setting 'staff_passkeys', on by default). */
export async function passkeysRequired(db: D1Database, user: User) {
  if (!isStaff(user)) return false;
  return (await db.prepare("SELECT value FROM settings WHERE key = 'staff_passkeys'").first<{ value: string }>())?.value !== '0';
}

export type PasskeyRow = { id: number; user_id: number; credential_id: string; public_key: string; counter: number; transports: string | null; name: string | null; created_at: string; last_used_at: string | null };

export const passkeysOf = async (db: D1Database, userId: number) =>
  (await db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY id').bind(userId).all<PasskeyRow>()).results;
export const hasPasskey = async (db: D1Database, userId: number) => !!(await db.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').bind(userId).first());

async function saveChallenge(db: D1Database, sessionHash: string, purpose: string, challenge: string) {
  await db
    .prepare('INSERT INTO webauthn_challenges (session_hash, purpose, challenge, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (session_hash, purpose) DO UPDATE SET challenge = excluded.challenge, created_at = excluded.created_at')
    .bind(sessionHash, purpose, challenge, epoch())
    .run();
}
/** Each challenge works once and only for 5 minutes. */
async function takeChallenge(db: D1Database, sessionHash: string, purpose: string) {
  const row = await db
    .prepare('DELETE FROM webauthn_challenges WHERE session_hash = ? AND purpose = ? RETURNING challenge, created_at')
    .bind(sessionHash, purpose)
    .first<{ challenge: string; created_at: number }>();
  return row && epoch() - row.created_at <= CHALLENGE_SECONDS ? row.challenge : null;
}

export async function registrationOptions(c: Context<AppEnv>, user: User, sessionHash: string) {
  const { rpID } = relyingParty(c);
  const existing = await passkeysOf(c.env.DB, user.id);
  const options = await generateRegistrationOptions({
    rpName: 'USMLE100',
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(`u100-${user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await saveChallenge(c.env.DB, sessionHash, 'register', options.challenge);
  return options;
}

export async function finishRegistration(c: Context<AppEnv>, user: User, sessionHash: string, response: RegistrationResponseJSON, name: string) {
  const challenge = await takeChallenge(c.env.DB, sessionHash, 'register');
  if (!challenge) return { ok: false as const, error: 'The request expired. Please try again.' };
  const { rpID, origin } = relyingParty(c);
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (e) {
    return { ok: false as const, error: 'This passkey could not be verified.' };
  }
  if (!v.verified || !v.registrationInfo) return { ok: false as const, error: 'This passkey could not be verified.' };
  const cred = v.registrationInfo.credential;
  const r = await c.env.DB.prepare('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (credential_id) DO NOTHING')
    .bind(user.id, cred.id, b64u(cred.publicKey), cred.counter, cred.transports ? JSON.stringify(cred.transports) : null, name.slice(0, 60) || 'Passkey', v.registrationInfo.credentialBackedUp ? 1 : 0)
    .run();
  if (!r.meta.changes) return { ok: false as const, error: 'That passkey is already registered.' };
  return { ok: true as const, id: Number(r.meta.last_row_id) };
}

export async function authenticationOptions(c: Context<AppEnv>, userId: number, sessionHash: string, purpose: 'signin' | 'stepup') {
  const { rpID } = relyingParty(c);
  const keys = await passkeysOf(c.env.DB, userId);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: keys.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
  });
  await saveChallenge(c.env.DB, sessionHash, purpose, options.challenge);
  return options;
}

/** Checks a passkey answer belongs to this user. Returns the passkey's id when it does. */
export async function finishAuthentication(c: Context<AppEnv>, userId: number, sessionHash: string, purpose: 'signin' | 'stepup', response: AuthenticationResponseJSON) {
  const challenge = await takeChallenge(c.env.DB, sessionHash, purpose);
  if (!challenge || typeof response?.id !== 'string') return null;
  const key = await c.env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?').bind(response.id, userId).first<PasskeyRow>();
  if (!key) return null;
  const { rpID, origin } = relyingParty(c);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: key.credential_id, publicKey: unb64u(key.public_key), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
    });
    if (!v.verified) return null;
    await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?").bind(v.authenticationInfo.newCounter, key.id).run();
    return key.id;
  } catch {
    return null;
  }
}

// ---------- Recovery codes ----------

/** New set of 10 one-time codes (old ones stop working). Shown once; only their hashes are stored. */
export async function newRecoveryCodes(db: D1Database, userId: number) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const s = [...b].map((x) => alphabet[x % 32]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  await db.batch([
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    ...(await Promise.all(codes.map(async (code) => db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').bind(userId, await sha256Hex('rc:' + code)))))
  ]);
  return codes;
}

/** Uses up one recovery code. True when it was valid and unused. */
export async function useRecoveryCode(db: D1Database, userId: number, code: string) {
  const norm = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm.length !== 10) return false;
  const h = await sha256Hex('rc:' + `${norm.slice(0, 5)}-${norm.slice(5)}`);
  const r = await db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").bind(userId, h).run();
  return (r.meta.changes ?? 0) > 0;
}

export const recoveryCodesLeft = async (db: D1Database, userId: number) =>
  (await db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(userId).first<{ n: number }>())?.n ?? 0;
