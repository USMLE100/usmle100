import type { Env } from './types';
import { sha256Hex } from './auth';

export type Cohort = { id: number; name: string; start_date: string; lecture_days: number; total_days: number };

/**
 * Program days are weekdays only (Monday to Friday). Day 1 is the cohort's start date.
 * Dates are calendar dates (stored as UTC midnight); "today" is taken in New York time.
 */
const DAY_MS = 86400_000;
const isWeekend = (t: number) => {
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
};
const startOf = (cohort: Cohort) => {
  const [y, m, d] = cohort.start_date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Today's calendar date in the program's time zone, as UTC midnight. */
export function todayUtc(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
}

/** Program day of a calendar date: the number of weekdays from Day 1 up to and including it. 0 before the start. */
export function dayOfDate(cohort: Cohort, t: number): number {
  const start = startOf(cohort);
  if (t < start) return 0;
  let n = 0;
  for (let x = start; x <= t; x += DAY_MS) if (!isWeekend(x)) n++;
  return n;
}

/** Program day for today. On a weekend this is the Friday before. */
export function cohortDay(cohort: Cohort, now = new Date()): number {
  return dayOfDate(cohort, todayUtc(now));
}

export const isWeekendToday = (now = new Date()) => isWeekend(todayUtc(now));
export const isWeekendDate = (t: number) => isWeekend(t);

export function dayDate(cohort: Cohort, day: number): Date {
  let t = startOf(cohort);
  while (isWeekend(t)) t += DAY_MS;
  for (let n = 1; n < day; ) {
    t += DAY_MS;
    if (!isWeekend(t)) n++;
  }
  return new Date(t);
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
