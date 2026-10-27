import type { Context, Next } from 'hono';
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
const PUBLIC_EXACT = new Set(['/', '/programs', '/terms', '/privacy', '/refunds', '/sign-in', '/sign-up', '/sign-out', '/reset-password', '/stripe/webhook', '/styles.css', '/favicon.ico']);
const isPublic = (p: string) => PUBLIC_EXACT.has(p) || /\.[a-z0-9]{2,5}$/i.test(p);
const isCheckout = (p: string) => p === '/enroll' || p.startsWith('/enroll/') || p.startsWith('/buy/');
const isSession = (p: string) => p.startsWith('/session/');

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

  if (user.status === 'suspended' && !isOwner(user)) {
    if (p === '/account/suspended') return next();
    return isSession(p) ? c.json({ ended: 'suspended' }, 403) : c.redirect('/account/suspended');
  }
  if (isStaff(user)) return next();

  if (await lockdownOn(c.env.DB)) {
    if (isCheckout(p) || p === '/account/unavailable') return next();
    return isSession(p) ? c.json({ ended: 'lockdown' }, 503) : c.redirect('/account/unavailable');
  }
  if (isSession(p) || isCheckout(p)) return next();

  if (user.status === 'warned') {
    if (p === '/account/notice') return next();
    return c.redirect('/account/notice');
  }
  if (p !== '/agreement' && (await needsAgreement(c.env.DB, user.id))) {
    return c.redirect('/agreement?next=' + encodeURIComponent(c.req.method === 'GET' ? c.req.path : '/dashboard'));
  }
  return next();
}
