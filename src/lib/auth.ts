import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Enrollment, User } from './types';
import { isAdmin, isStaff } from './types';

const COOKIE = 'u100_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // Workers' maximum

const enc = new TextEncoder();

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toB64(bits), salt: toB64(salt) };
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  const res = await hashPassword(password, salt);
  return safeEqual(res.hash, hash);
}

/** Sign in. With "Remember me" off, the cookie ends when the browser closes and the session expires within a day. */
export async function createSession(c: Context<AppEnv>, userId: number, remember = true) {
  const raw = toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' })[m]!);
  const expires = new Date(Date.now() + (remember ? SESSION_DAYS * 86400_000 : 86400_000));
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(raw), userId, expires.toISOString())
    .run();
  setCookie(c, COOKIE, raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    ...(remember ? { expires } : {}),
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const raw = getCookie(c, COOKIE);
  if (raw) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(raw)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Loads the signed-in user (if any) and their active enrollment onto the context. */
export async function loadUser(c: Context<AppEnv>, next: Next) {
  c.set('user', null);
  c.set('enrollment', null);
  const raw = getCookie(c, COOKIE);
  if (raw) {
    const user = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.exam_date, u.exam, u.onboarded_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
      .bind(await sha256Hex(raw), new Date().toISOString())
      .first<User>();
    if (user) {
      c.set('user', user);
      const enr = await c.env.DB.prepare(
        `SELECT e.id, e.package_id, e.cohort_id, e.status, p.name AS package_name, p.one_on_one_sessions, p.evening_q_months, e.lectures_until
         FROM enrollments e JOIN packages p ON p.id = e.package_id
         WHERE e.user_id = ? AND e.status = 'active' ORDER BY e.paid_at DESC LIMIT 1`,
      )
        .bind(user.id)
        .first<Enrollment>();
      c.set('enrollment', enr ?? null);
    }
  }
  await next();
}

/** Rejects cross-site form posts (defence in depth on top of SameSite cookies). */
export async function sameOrigin(c: Context<AppEnv>, next: Next) {
  if (c.req.method === 'POST' && !c.req.path.startsWith('/stripe/webhook') && !c.req.path.startsWith('/zoom/webhook')) {
    // Browsers send Sec-Fetch-Site on every request; Origin can be "null" under strict referrer policies.
    const site = c.req.header('sec-fetch-site');
    if (site === 'cross-site') return c.text('Forbidden', 403);
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      const host = c.req.header('host') ?? new URL(c.req.url).host;
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {}
      if (originHost !== host) return c.text('Forbidden', 403);
    }
  }
  await next();
}

export async function requireUser(c: Context<AppEnv>, next: Next) {
  if (!c.get('user')) return c.redirect('/sign-in?next=' + encodeURIComponent(c.req.path));
  await next();
}

/** Students must have paid. Faculty and admins always get in. */
export async function requireEnrolled(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.redirect('/sign-in?next=' + encodeURIComponent(c.req.path));
  if (!isStaff(user) && !c.get('enrollment')) return c.redirect('/enroll');
  await next();
}

export async function requireStaff(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.redirect('/sign-in?next=' + encodeURIComponent(c.req.path));
  if (!isStaff(user)) return c.text('Not found', 404);
  await next();
}

/**
 * What faculty may do in the admin area (everything else there is admin-only).
 * Deny by default: a new admin page is admin-only unless it is added here.
 */
const FACULTY_ALLOWED: [method: string, path: RegExp][] = [
  // Qbank: write, import, approve
  ['GET', /^\/admin\/questions(\/.*)?$/],
  ['POST', /^\/admin\/questions(\/.*)?$/],
  // Lectures: list, add a day, edit title / video / live
  ['GET', /^\/admin\/lectures$/],
  ['POST', /^\/admin\/lectures(\/\d+)?$/],
  // Attach an imported Zoom recording to a lecture day or an evening class
  ['POST', /^\/admin\/zoom-imports\/\d+\/(assign|assign-evening)$/],
  // Evening Questions recordings (not who can watch)
  ['GET', /^\/admin\/evening$/],
  ['POST', /^\/admin\/evening\/sessions(\/\d+)?$/],
  // Phase 2 teaching content: lecture details, sections and flash cards.
  ['GET', /^\/admin\/lectures\/\d+$/],
  ['POST', /^\/admin\/lectures\/\d+\/details$/],
  ['GET', /^\/admin\/sections$/],
  ['POST', /^\/admin\/sections(\/\d+(\/delete)?)?$/],
  ['GET', /^\/admin\/cards(\/\d+)?$/],
  ['POST', /^\/admin\/cards(\/bulk|\/\d+(\/status)?)?$/],
];

export const facultyMay = (method: string, path: string) =>
  FACULTY_ALLOWED.some(([m, re]) => m === method && re.test(path.replace(/\/+$/, '')));

/** Admins may use the whole admin area; faculty only the parts listed above. */
export async function requireAdminOrFacultyAllowed(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.redirect('/sign-in?next=' + encodeURIComponent(c.req.path));
  if (isAdmin(user)) return next();
  if (user.role === 'faculty' && facultyMay(c.req.method, c.req.path)) return next();
  return c.text('Not found', 404);
}
