import type { User } from './types';
import { isStaff } from './types';
import { todayUtc, ymdToUtc } from './content';

export type EveningSession = { id: number; session_date: string; title: string; zoom_url: string | null; bunny_video_id: string | null; status: string; live_at: string | null };

/** One month of Evening Questions = the next 12 evening classes from the start date. */
export const CLASSES_PER_MONTH = 12;
/** Days to finish watching after the month's 12th recording goes up. */
export const GRACE_DAYS = 2;

export const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => ymdOf(ymdToUtc(ymd) + n * 86400_000);
export const todayYmd = () => ymdOf(todayUtc());
/** New York date a recording went live ("2026-11-02 23:10:00" is stored in UTC). */
const liveYmd = (s: { live_at: string | null }) => (s.live_at ? ymdOf(todayUtc(new Date(s.live_at.replace(' ', 'T') + 'Z'))) : null);

type Sess = Pick<EveningSession, 'id' | 'session_date' | 'status' | 'live_at'>;
export type Sub = { start: string; months: number };

export type Block = {
  month: number; // 1-based
  months: number;
  start: string; // first day of this month
  sessions: Sess[]; // its classes so far (up to 12)
  end: string | null; // last day to watch; null until the 12th recording is up
};

/**
 * Split a subscription into its months. Month 1 starts on the start date; each later month starts the day after
 * the previous month's 12th class. A month ends GRACE_DAYS after its 12th recording went live.
 */
export function blocksFor(sub: Sub, sessions: Sess[]): Block[] {
  const mine = sessions.filter((s) => s.session_date >= sub.start).slice(0, CLASSES_PER_MONTH * sub.months);
  const blocks: Block[] = [];
  for (let k = 0; k < sub.months; k++) {
    const prev = blocks[k - 1];
    const start = k === 0 ? sub.start : prev && prev.sessions.length === CLASSES_PER_MONTH ? addDays(prev.sessions[CLASSES_PER_MONTH - 1].session_date, 1) : null;
    if (!start) break; // The previous month hasn't had its 12 classes yet.
    const ss = mine.slice(k * CLASSES_PER_MONTH, (k + 1) * CLASSES_PER_MONTH);
    const last = ss.length === CLASSES_PER_MONTH ? ss[CLASSES_PER_MONTH - 1] : null;
    const lastLive = last ? liveYmd(last) : null;
    const end = last && lastLive ? addDays(lastLive > last.session_date ? lastLive : last.session_date, GRACE_DAYS) : null;
    blocks.push({ month: k + 1, months: sub.months, start, sessions: ss, end });
  }
  return blocks;
}

const isActive = (b: Block, today: string) => b.start <= today && (b.end === null || today <= b.end);

/** Where a subscription stands today. */
export function subStatus(sub: Sub, sessions: Sess[], today = todayYmd()) {
  const blocks = blocksFor(sub, sessions);
  const active = blocks.filter((b) => isActive(b, today));
  const lastBlock = blocks[blocks.length - 1];
  const finished = blocks.length === sub.months && !!lastBlock?.end && today > lastBlock.end;
  const pending = sub.start > today;
  return { blocks, active, finished, pending };
}

export type EveningAccess =
  | { staff: true }
  | { staff: false; visible: Set<number>; current: Block };

async function subsFor(db: D1Database, userId: number): Promise<(Sub & { id?: number })[]> {
  const manual = (await db.prepare('SELECT id, start_date AS start, months FROM evening_subscriptions WHERE user_id = ? ORDER BY start_date').bind(userId).all<Sub & { id: number }>()).results;
  // Months included with Companion, Complete and MAX start on the later of payment and the cohort's Day 1.
  const pkg = (
    await db
      .prepare(
        `SELECT substr(COALESCE(e.paid_at, e.created_at), 1, 10) AS paid, p.evening_q_months AS months, c.start_date
         FROM enrollments e JOIN packages p ON p.id = e.package_id LEFT JOIN cohorts c ON c.id = e.cohort_id
         WHERE e.user_id = ? AND e.status = 'active' AND p.evening_q_months > 0`,
      )
      .bind(userId)
      .all<{ paid: string; months: number; start_date: string | null }>()
  ).results.map((r) => ({ start: r.start_date && r.start_date > r.paid ? r.start_date : r.paid, months: r.months }));
  return [...manual, ...pkg];
}

export const allSessions = async (db: D1Database) =>
  (await db.prepare('SELECT id, session_date, status, live_at FROM evening_sessions ORDER BY session_date').all<Sess>()).results;

/** What this person may watch today, or null for no access. */
export async function eveningAccess(db: D1Database, user: User): Promise<EveningAccess | null> {
  if (isStaff(user)) return { staff: true };
  const subs = await subsFor(db, user.id);
  if (!subs.length) return null;
  const sessions = await allSessions(db);
  const today = todayYmd();
  const active = subs.flatMap((s) => subStatus(s, sessions, today).active);
  if (!active.length) return null;
  const visible = new Set(active.flatMap((b) => b.sessions.map((s) => s.id)));
  const current = active.sort((a, b) => (a.start < b.start ? 1 : -1))[0];
  return { staff: false, visible, current };
}

/** First day of a month that has been paid for but not started yet, if any. */
export async function nextStart(db: D1Database, userId: number) {
  return (await db.prepare('SELECT MIN(start_date) AS d FROM evening_subscriptions WHERE user_id = ? AND start_date > ?').bind(userId, todayYmd()).first<{ d: string | null }>())?.d ?? null;
}

/**
 * Give months to a student. If their latest subscription is still running (or hasn't started),
 * the months are added to it, so they follow straight on; otherwise a new one starts on `start`.
 */
export async function giveEveningMonths(db: D1Database, userId: number, start: string, months: number, note: string | null) {
  const latest = await db.prepare('SELECT id, start_date AS start, months FROM evening_subscriptions WHERE user_id = ? ORDER BY start_date DESC, id DESC LIMIT 1').bind(userId).first<Sub & { id: number }>();
  if (latest && !subStatus(latest, await allSessions(db)).finished) {
    await db.prepare('UPDATE evening_subscriptions SET months = months + ?, note = COALESCE(?, note) WHERE id = ?').bind(months, note, latest.id).run();
  } else {
    await db.prepare('INSERT INTO evening_subscriptions (user_id, start_date, months, note) VALUES (?, ?, ?, ?)').bind(userId, start, months, note).run();
  }
}
