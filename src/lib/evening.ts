import type { User } from './types';
import { isStaff } from './types';
import { todayUtc, ymdToUtc } from './content';

export type EveningSession = { id: number; session_date: string; title: string; zoom_url: string | null; bunny_video_id: string | null; status: string };

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

function addMonths(t: number, months: number) {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/**
 * Who can watch Evening Questions recordings:
 * staff always; students whose package includes Evening Q's, for that many months from the later of
 * payment and their cohort's Day 1; and anyone given access by hand until a date.
 * Returns the last day of access (YYYY-MM-DD), or null when there is none.
 */
export async function eveningAccessUntil(db: D1Database, user: User): Promise<string | null> {
  if (isStaff(user)) return '9999-12-31';
  const today = todayUtc();
  let best: number | null = null;
  const manual = await db.prepare('SELECT until_date FROM evening_access WHERE user_id = ?').bind(user.id).first<{ until_date: string }>();
  if (manual) best = ymdToUtc(manual.until_date);
  const { results } = await db
    .prepare(
      `SELECT COALESCE(e.paid_at, e.created_at) AS paid, p.evening_q_months AS months, c.start_date
       FROM enrollments e JOIN packages p ON p.id = e.package_id LEFT JOIN cohorts c ON c.id = e.cohort_id
       WHERE e.user_id = ? AND e.status = 'active' AND p.evening_q_months > 0`,
    )
    .bind(user.id)
    .all<{ paid: string; months: number; start_date: string | null }>();
  for (const r of results) {
    const paid = ymdToUtc(String(r.paid).slice(0, 10));
    const start = r.start_date ? Math.max(paid, ymdToUtc(r.start_date)) : paid;
    const end = addMonths(start, r.months);
    if (best === null || end > best) best = end;
  }
  return best !== null && best >= today ? ymd(best) : null;
}
