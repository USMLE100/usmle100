import type { Context, Next } from 'hono';
import type { AppEnv } from './types';
import { isStaff } from './types';
import { rateHit } from './ratelimit';
import { audit } from './audit';

/**
 * Anti-scraping for the question bank, flash cards and the Course Book (owner decision: strict rate limits,
 * graduated responses, free capabilities). Normal studying never comes close: a full day of questions is a few
 * hundred pages. Going over a limit first slows the student down (a short wait page); the first time each day it is
 * also flagged for an administrator to review. Staff are not limited.
 */
type Rule = { name: string; perMinute: number; perDay: number; flag: string };

export const RULES = {
  qbank: { name: 'question', perMinute: 40, perDay: 1500, flag: 'qbank_scraping' },
  cards: { name: 'flash card', perMinute: 60, perDay: 2500, flag: 'cards_scraping' },
  book: { name: 'Course Book', perMinute: 6, perDay: 120, flag: 'book_scraping' },
} satisfies Record<string, Rule>;

export function throttle(rule: Rule) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get('user');
    if (!user || isStaff(user) || c.req.method !== 'GET') return next();
    const db = c.env.DB;
    const t = Math.floor(Date.now() / 1000);
    const minuteOk = await rateHit(db, `${rule.flag}:m:${user.id}`, rule.perMinute, 60);
    const dayOk = await rateHit(db, `${rule.flag}:d:${user.id}`, rule.perDay, 86400);
    if (minuteOk && dayOk) return next();
    // Flag once per day per kind.
    if (await rateHit(db, `${rule.flag}:flagged:${user.id}`, 1, 86400)) {
      await db.batch([
        db.prepare('INSERT INTO security_flags (user_id, kind, detail) VALUES (?, ?, ?)').bind(user.id, rule.flag, JSON.stringify({ path: c.req.path, limit: minuteOk ? 'day' : 'minute', at: t })),
        db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', ?, ?, ?)").bind(rule.flag, user.id, `Unusually fast ${rule.name} paging: review whether this looks like copying.`),
      ]);
      await audit(db, { actorId: user.id, action: 'abuse.throttled', targetUserId: user.id, detail: { kind: rule.flag, path: c.req.path }, ip: c.req.header('cf-connecting-ip') ?? null });
    }
    c.header('Retry-After', dayOk ? '60' : '3600');
    return c.html(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Please slow down</title><link rel="stylesheet" href="/styles.css"><main class="wrap page" style="max-width:560px;padding-top:64px"><h1>Please slow down</h1><p>You’re opening ${rule.name} pages faster than anyone studies. ${dayOk ? 'Please wait a minute and try again.' : 'You’ve reached today’s limit; it resets within 24 hours.'}</p><p class="muted small">Copying USMLE100 materials is not allowed. If this is a mistake, contact USMLE100.</p><p><a class="btn btn-primary" href="/dashboard">Back to the portal</a></p></main>`,
      429,
    );
  };
}
