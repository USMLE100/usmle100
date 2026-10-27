import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Enrollment, User } from './types';
import { isAdmin, isOwner, isStaff } from './types';
import { audit } from './audit';

const COOKIE = 'u100_session';
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

/** Sessions end after 30 minutes without activity and 24 hours after sign-in (R088, R089, R090). */
export const IDLE_SECONDS = 30 * 60;
export const MAX_SESSION_SECONDS = 24 * 3600;
/** Owner-only actions need the password re-entered within this many seconds (until passkeys exist). */
export const REAUTH_SECONDS = 15 * 60;
const epoch = () => Math.floor(Date.now() / 1000);

/** Sign in. The cookie lasts only for the browser session; the server ends the session on inactivity or after 24 hours. */
export async function createSession(c: Context<AppEnv>, userId: number, deviceId?: string | null, verifyReason?: string | null) {
  const raw = toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' })[m]!);
  const t = epoch();
  await c.env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, reauth_at, ip, user_agent, country, device_id, verify_pending, verify_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      await sha256Hex(raw),
      userId,
      new Date((t + MAX_SESSION_SECONDS) * 1000).toISOString(),
      t,
      t,
      t,
      c.req.header('cf-connecting-ip') ?? null,
      (c.req.header('user-agent') ?? '').slice(0, 300) || null,
      c.req.header('cf-ipcountry') ?? null,
      deviceId ?? null,
      verifyReason ? 1 : 0,
      verifyReason ?? null,
    )
    .run();
  setCookie(c, COOKIE, raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const raw = getCookie(c, COOKIE);
  if (raw) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(raw)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

/** The current session's timing, for the inactivity warning and owner re-authentication. */
export type SessionInfo = { tokenHash: string; createdAt: number; lastSeenAt: number; reauthAt: number | null; deviceHash: string | null };

/**
 * Loads the signed-in user (if any) and their active enrollment onto the context.
 * A session idle for 30 minutes, or older than 24 hours, is ended here. Requests that are not activity
 * (the inactivity check itself) do not extend it.
 */
export async function loadUser(c: Context<AppEnv>, next: Next) {
  c.set('user', null);
  c.set('enrollment', null);
  const raw = getCookie(c, COOKIE);
  if (raw) {
    const th = await sha256Hex(raw);
    const t = epoch();
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.exam_date, u.exam, u.onboarded_at, u.is_owner, u.status, u.status_reason, u.warnings, u.birth_date,
              u.first_name, u.last_name, u.phone, u.grad_year, u.marketing_opt_in, u.email_verified_at, u.phone_verified_at,
              s.created_at AS s_created, s.last_seen_at AS s_seen, s.reauth_at AS s_reauth, s.device_id AS s_device, s.verify_pending AS s_verify, s.verify_reason AS s_vreason
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
      .bind(th)
      .first<User & { s_created: number | null; s_seen: number | null; s_reauth: number | null; s_device: string | null; s_verify: number | null; s_vreason: string | null }>();
    const created = row?.s_created ?? t;
    const seen = row?.s_seen ?? t;
    if (row && (t - seen > IDLE_SECONDS || t - created > MAX_SESSION_SECONDS)) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run();
      deleteCookie(c, COOKIE, { path: '/' });
      c.set('sessionEnded', t - created > MAX_SESSION_SECONDS ? 'expired' : 'idle');
    } else if (row) {
      const { s_created, s_seen, s_reauth, s_device, s_verify, s_vreason, ...user } = row;
      c.set('user', user as User);
      c.set('session', { tokenHash: th, createdAt: created, lastSeenAt: seen, reauthAt: s_reauth ?? null, deviceHash: s_device ?? null, verifyPending: !!s_verify, verifyReason: s_vreason ?? null });
      // Activity extends the session (written at most once a minute). The status check does not count.
      if (c.req.path !== '/session/status' && t - seen >= 60) {
        await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(t, th).run();
      }
      const enr = await c.env.DB.prepare(
        `SELECT e.id, e.package_id, e.cohort_id, e.status, p.name AS package_name, p.one_on_one_sessions, p.evening_q_months, e.lectures_until
         FROM enrollments e JOIN packages p ON p.id = e.package_id
         WHERE e.user_id = ? AND e.status = 'active' AND e.suspended_at IS NULL ORDER BY e.paid_at DESC LIMIT 1`,
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

const signInUrl = (c: Context<AppEnv>) =>
  '/sign-in?next=' + encodeURIComponent(c.req.path + new URL(c.req.url).search) + (c.get('sessionEnded') ? `&ended=${c.get('sessionEnded')}` : '');

export async function requireUser(c: Context<AppEnv>, next: Next) {
  // Keep the query string, so a payment's return link (…?session_id=) still works after signing in.
  if (!c.get('user')) return c.redirect(signInUrl(c));
  await next();
}

/** Students must have paid. Faculty and admins always get in. */
export async function requireEnrolled(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.redirect(signInUrl(c));
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

/**
 * Changes only the owner may make (R021, R164, R004, R023): admins and roles, prices and site settings,
 * enrollment and access adjustments, reinstating suspended accounts, the emergency lockdown and the agreement.
 * Admins can still open these pages to see them.
 */
const OWNER_ONLY: RegExp[] = [
  /^\/admin\/team$/,
  /^\/admin\/settings$/,
  /^\/admin\/students\/\d+\/(lectures|restore)$/,
  /^\/admin\/book-access(\/remove)?$/,
  /^\/admin\/evening\/access(\/extend|\/remove)?$/,
  /^\/admin\/security\/(reinstate|lockdown)$/,
  /^\/admin\/agreement$/,
  /^\/admin\/views\/(grant|dismiss)$/,
  /^\/admin\/free-lectures\/\d+\/publish$/,
  /^\/admin\/requests\/privacy\/\d+$/,
  /^\/admin\/zoom-imports\/\d+\/approve$/,
  /^\/admin\/enrolling$/,
  /^\/admin\/students\/\d+\/give-program$/,
  /^\/admin\/payments\/fulfil$/,
];
export const ownerOnly = (method: string, path: string) => method === 'POST' && OWNER_ONLY.some((re) => re.test(path.replace(/\/+$/, '')));

/** True when the owner re-entered their password recently enough for an owner-only change. */
export const freshlyConfirmed = (c: Context<AppEnv>) => {
  const s = c.get('session');
  return !!s?.reauthAt && Math.floor(Date.now() / 1000) - s.reauthAt <= REAUTH_SECONDS;
};

/** Admins may use the admin area (owner-only changes need the owner, freshly confirmed); faculty only the parts listed above. */
export async function requireAdminOrFacultyAllowed(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.redirect(signInUrl(c));
  if (ownerOnly(c.req.method, c.req.path)) {
    if (!isAdmin(user)) return c.text('Not found', 404);
    if (!isOwner(user)) {
      await audit(c.env.DB, { actorId: user.id, action: 'owner.denied', detail: { path: c.req.path }, ip: c.req.header('cf-connecting-ip') ?? null });
      return c.text('Only the owner can make this change.', 403);
    }
    if (!freshlyConfirmed(c)) {
      const back = (c.req.header('referer') ?? '').replace(/^https?:\/\/[^/]+/, '') || '/admin/security';
      return c.redirect('/admin/confirm?next=' + encodeURIComponent(back.startsWith('/') && !back.startsWith('//') ? back : '/admin/security'));
    }
    return logged(c, next);
  }
  if (isAdmin(user)) return logged(c, next);
  if (user.role === 'faculty' && facultyMay(c.req.method, c.req.path)) return logged(c, next);
  return c.text('Not found', 404);
}

/** Small, non-secret form fields worth recording with an admin change. */
const LOGGED_FIELDS = ['email', 'user_id', 'role', 'on', 'status', 'months', 'start', 'until', 'reset', 'enrollment_id'];
/** Records every staff change in the security log (R010). The security pages log their own, more detailed entries. */
async function logged(c: Context<AppEnv>, next: Next) {
  await next();
  if (c.req.method !== 'POST' || /^\/admin\/(security|confirm|agreement|views|free-lectures|requests|alerts|flags)(\/|$)/.test(c.req.path) || c.res.status >= 400) return;
  let fields: Record<string, unknown> = {};
  try {
    const f = await c.req.parseBody();
    fields = Object.fromEntries(LOGGED_FIELDS.filter((k) => typeof f[k] === 'string' && f[k] !== '').map((k) => [k, String(f[k]).slice(0, 120)]));
  } catch {}
  await audit(c.env.DB, { actorId: c.get('user')!.id, action: 'admin.post', detail: { path: c.req.path, ...fields }, ip: c.req.header('cf-connecting-ip') ?? null });
}
