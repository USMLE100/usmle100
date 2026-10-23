import type { User } from './types';
import { isStaff } from './types';
import { todayUtc, ymdToUtc } from './content';

export type EveningSession = { id: number; session_date: string; title: string; zoom_url: string | null; bunny_video_id: string | null; status: string };

/** One paid month of Evening Questions: 32 days, so the last class of the month can still be watched. */
export const EVENING_MONTH_DAYS = 32;

const DAY = 86400_000;
export const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => ymdOf(ymdToUtc(ymd) + n * DAY);
export const todayYmd = () => ymdOf(todayUtc());

/** A student's current Evening Questions month: they see recordings dated from `start` to `end`, until `end`. */
export type EveningWindow = { start: string; end: string; staff?: boolean };

/**
 * Staff see everything. Students see only the recordings made during their current 32-day month:
 * - months given by hand (monthly buyers), stored in evening_periods;
 * - months included in their package (Companion, Complete, MAX), counted in 32-day blocks from the
 *   later of payment and their cohort's Day 1.
 * Returns null when they have no month running today.
 */
export async function eveningWindow(db: D1Database, user: User): Promise<EveningWindow | null> {
  if (isStaff(user)) return { start: '0000-01-01', end: '9999-12-31', staff: true };
  const today = todayYmd();
  const found: EveningWindow[] = [];
  const manual = await db
    .prepare('SELECT start_date, end_date FROM evening_periods WHERE user_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC LIMIT 1')
    .bind(user.id, today, today)
    .first<{ start_date: string; end_date: string }>();
  if (manual) found.push({ start: manual.start_date, end: manual.end_date });
  const { results } = await db
    .prepare(
      `SELECT COALESCE(e.paid_at, e.created_at) AS paid, p.evening_q_months AS months, c.start_date
       FROM enrollments e JOIN packages p ON p.id = e.package_id LEFT JOIN cohorts c ON c.id = e.cohort_id
       WHERE e.user_id = ? AND e.status = 'active' AND p.evening_q_months > 0`,
    )
    .bind(user.id)
    .all<{ paid: string; months: number; start_date: string | null }>();
  for (const r of results) {
    const paid = String(r.paid).slice(0, 10);
    const first = r.start_date && r.start_date > paid ? r.start_date : paid;
    const k = Math.floor((ymdToUtc(today) - ymdToUtc(first)) / (EVENING_MONTH_DAYS * DAY));
    if (k >= 0 && k < r.months) {
      const start = addDays(first, k * EVENING_MONTH_DAYS);
      found.push({ start, end: addDays(start, EVENING_MONTH_DAYS - 1) });
    }
  }
  if (!found.length) return null;
  // If two months overlap today, use the one that started most recently.
  return found.sort((a, b) => (a.start < b.start ? 1 : -1))[0];
}

/** The next month someone is given starts the day after their last month ends, or on `start` if they have none running. */
export async function addEveningMonths(db: D1Database, userId: number, start: string, months: number, note: string | null) {
  const last = await db.prepare('SELECT MAX(end_date) AS end_date FROM evening_periods WHERE user_id = ?').bind(userId).first<{ end_date: string | null }>();
  let from = last?.end_date && last.end_date >= addDays(start, -1) ? addDays(last.end_date, 1) : start;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < months; i++) {
    const end = addDays(from, EVENING_MONTH_DAYS - 1);
    stmts.push(db.prepare('INSERT INTO evening_periods (user_id, start_date, end_date, note) VALUES (?, ?, ?, ?)').bind(userId, from, end, note));
    from = addDays(end, 1);
  }
  await db.batch(stmts);
}
