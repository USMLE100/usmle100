import type { Context, Next } from 'hono';
import { hasPasskey, passkeysRequired } from './passkeys';
import type { AppEnv } from './types';
import { isOwner, isStaff } from './types';

/**
 * Account-wide gate, run on every request after the user is loaded:
 * - Suspended accounts (R149) see only the public pages and a "suspended" notice.
 * - Emergency lockdown (R023): student areas close; public pages, sign-in, checkout and Stripe keep working.
 * - Warned accounts (R003) see the warning once and must acknowledge it.
 * - Students must sign the current agreement (R012) before using the portal.
 * Staff are exempt from lockdown and the agreement; the owner can never be suspended.
 */
const PUBLIC_EXACT = new Set(['/', '/programs', '/terms', '/privacy', '/refunds', '/sign-in', '/sign-up', '/sign-out', '/reset-password', '/stripe/webhook', '/styles.css', '/favicon.ico', '/webinars', '/forgot']);
const isPublic = (p: string) => PUBLIC_EXACT.has(p) || /\.[a-z0-9]{2,5}$/i.test(p);
const isCheckout = (p: string) => p === '/enroll' || p.startsWith('/enroll/') || p.startsWith('/buy/');
const isSession = (p: string) => p.startsWith('/session/');
/** Requests made by page scripts get a JSON answer the script understands, not a redirect to an HTML page. */
const isApi = (p: string) => p.startsWith('/play/') || p.startsWith('/session/');
const apiOrRedirect = (c: Context<AppEnv>, p: string, url: string, status: 403 | 503 = 403) => (isApi(p) ? c.json({ state: 'account', url }, status) : c.redirect(url));

export async function lockdownOn(db: D1Database) {
  return (await db.prepare("SELECT value FROM settings WHERE key = 'lockdown'").first<{ value: string }>())?.value === '1';
}

/** The agreement students must have signed: the newest material version (or null when none is published). */
export async function requiredAgreement(db: D1Database) {
  return db.prepare('SELECT id FROM agreements WHERE material = 1 ORDER BY id DESC LIMIT 1').first<{ id: number }>();
}

export async function needsAgreement(db: D1Database, userId: number) {
  const req = await requiredAgreement(db);
  if (!req) return false;
  return !(await db.prepare('SELECT 1 FROM agreement_signatures WHERE user_id = ? AND agreement_id >= ?').bind(userId, req.id).first());
}

export async function accountGate(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  const p = c.req.path.replace(/\/+$/, '') || '/';
  if (!user || isPublic(p)) return next();
  // Staff sign-ins wait for the passkey (second step) before anything else opens.
  const sess = c.get('session');
  const pkPath = p.startsWith('/account/passkey') || p === '/sign-out' || isSession(p);
  if (sess?.verifyPending && sess.verifyReason === 'passkey') {
    return pkPath ? next() : apiOrRedirect(c, p, '/account/passkey/sign-in?next=' + encodeURIComponent(c.req.method === 'GET' ? c.req.path : '/dashboard'));
  }
  // Staff without a passkey must set one up before using anything else (owner, admins and faculty).
  if (isStaff(user) && !pkPath && (await passkeysRequired(c.env.DB, user)) && !(await hasPasskey(c.env.DB, user.id))) {
    return apiOrRedirect(c, p, '/account/passkeys');
  }
  // A risky sign-in must pass the extra email/phone check before anything else opens (risk-based verification).
  if (c.get('session')?.verifyPending && !p.startsWith('/account/check-sign-in') && p !== '/sign-out' && !isSession(p) && p !== '/play/release') {
    return apiOrRedirect(c, p, '/account/check-sign-in');
  }

  if (user.status === 'suspended' && !isOwner(user)) {
    if (p === '/account/suspended') return next();
    return isSession(p) ? c.json({ ended: 'suspended' }, 403) : apiOrRedirect(c, p, '/account/suspended');
  }
  if (isStaff(user)) return next();

  if (await lockdownOn(c.env.DB)) {
    if (isCheckout(p) || p === '/account/unavailable') return next();
    return isSession(p) ? c.json({ ended: 'lockdown' }, 503) : apiOrRedirect(c, p, '/account/unavailable', 503);
  }
  if (isSession(p) || isCheckout(p)) return next();

  if (user.status === 'warned') {
    if (p === '/account/notice' || p === '/play/release') return next();
    return apiOrRedirect(c, p, '/account/notice');
  }
  if (p !== '/agreement' && p !== '/play/release' && (await needsAgreement(c.env.DB, user.id))) {
    if (isApi(p)) return apiOrRedirect(c, p, '/agreement');
    return c.redirect('/agreement?next=' + encodeURIComponent(c.req.method === 'GET' ? c.req.path : '/dashboard'));
  }
  return next();
}
