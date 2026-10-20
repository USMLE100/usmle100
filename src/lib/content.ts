import type { Env } from './types';
import { sha256Hex } from './auth';

export type Cohort = { id: number; name: string; start_date: string; lecture_days: number; total_days: number };

/** Day number (1-based) of `today` within a cohort, using the student's calendar date. */
export function cohortDay(cohort: Cohort, today = new Date()): number {
  const [y, m, d] = cohort.start_date.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((now - start) / 86400_000) + 1;
}

export function dayDate(cohort: Cohort, day: number): Date {
  const [y, m, d] = cohort.start_date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + day - 1));
}

export function fmtDate(dt: Date, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return dt.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

export async function currentCohort(db: D1Database, cohortId?: number | null) {
  if (cohortId) {
    const c = await db.prepare('SELECT * FROM cohorts WHERE id = ?').bind(cohortId).first<Cohort>();
    if (c) return c;
  }
  return db.prepare('SELECT * FROM cohorts ORDER BY start_date DESC LIMIT 1').first<Cohort>();
}

/**
 * Bunny Stream embed URL with token authentication:
 * token = SHA256_HEX(token_security_key + video_id + expiration).
 * Links expire, so a copied URL stops working.
 */
export async function bunnyEmbedUrl(env: Env, videoId: string, ttlSeconds = 4 * 3600) {
  if (!env.BUNNY_LIBRARY_ID) return null;
  const base = `https://iframe.mediadelivery.net/embed/${env.BUNNY_LIBRARY_ID}/${encodeURIComponent(videoId)}`;
  if (!env.BUNNY_TOKEN_KEY) return base;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await sha256Hex(env.BUNNY_TOKEN_KEY + videoId + expires);
  return `${base}?token=${token}&expires=${expires}`;
}

export const LETTERS = 'ABCDEFGHIJ';

export function money(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
