import { todayUtc } from './content';

/**
 * Study activity built only from what the site already records:
 * - a lecture marked as watched (lecture_progress.completed_at)
 * - a question answered (test_items.answered_at)
 * Dates are New York calendar days.
 *
 * Streak rule (approved): a day counts when the student watches a lecture or answers at least 10 questions.
 * Today's goal (approved): today's lecture (on class days) plus 20 questions.
 */
export const STREAK_MIN_QUESTIONS = 10;
export const GOAL_QUESTIONS = 20;

const DAY = 86400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
/** D1 stores UTC as "YYYY-MM-DD HH:MM:SS"; return the New York calendar day. */
export const nyDay = (utc: string) => ymd(todayUtc(new Date(utc.replace(' ', 'T') + 'Z')));

export type DayCount = { lectures: number; questions: number };

export async function activityByDay(db: D1Database, userId: number, days = 400) {
  const since = new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace('T', ' ');
  const [lec, qs] = await Promise.all([
    db.prepare('SELECT completed_at AS at FROM lecture_progress WHERE user_id = ? AND completed_at >= ?').bind(userId, since).all<{ at: string }>(),
    db
      .prepare('SELECT ti.answered_at AS at FROM test_items ti JOIN tests t ON t.id = ti.test_id WHERE t.user_id = ? AND ti.answered_at >= ?')
      .bind(userId, since)
      .all<{ at: string }>(),
  ]);
  const map = new Map<string, DayCount>();
  const bump = (at: string, k: keyof DayCount) => {
    const d = nyDay(at);
    const v = map.get(d) ?? { lectures: 0, questions: 0 };
    v[k]++;
    map.set(d, v);
  };
  for (const r of lec.results) bump(r.at, 'lectures');
  for (const r of qs.results) bump(r.at, 'questions');
  return map;
}

const counts = (v?: DayCount) => !!v && (v.lectures > 0 || v.questions >= STREAK_MIN_QUESTIONS);
/** A day keeps the streak alive if it counts, or a streak freeze covers it. */
const keeps = (map: Map<string, DayCount>, frozen: Set<string>, ymdStr: string) => counts(map.get(ymdStr)) || frozen.has(ymdStr);

/** Consecutive study days ending today; if today doesn't count yet, the streak from yesterday is still alive. */
export function streakFrom(map: Map<string, DayCount>, frozen: Set<string> = new Set()) {
  let t = todayUtc();
  if (!keeps(map, frozen, ymd(t))) t -= DAY;
  let n = 0;
  while (keeps(map, frozen, ymd(t))) {
    n++;
    t -= DAY;
  }
  return n;
}

/** The longest run of study days in the period covered by `map`. */
export function longestStreak(map: Map<string, DayCount>, frozen: Set<string> = new Set(), days = 400) {
  let best = 0;
  let run = 0;
  for (let t = todayUtc() - days * DAY; t <= todayUtc(); t += DAY) {
    run = keeps(map, frozen, ymd(t)) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Study days that continue a streak (the day before also counted). Each earns streak XP. */
export function streakDays(map: Map<string, DayCount>, frozen: Set<string> = new Set(), days = 400) {
  let n = 0;
  for (let t = todayUtc() - days * DAY + DAY; t <= todayUtc(); t += DAY) {
    if (counts(map.get(ymd(t))) && keeps(map, frozen, ymd(t - DAY))) n++;
  }
  return n;
}

export const frozenDays = async (db: D1Database, userId: number) =>
  new Set((await db.prepare('SELECT day FROM streak_freezes WHERE user_id = ?').bind(userId).all<{ day: string }>()).results.map((r) => r.day));

export async function studyStreak(db: D1Database, userId: number) {
  const [map, frozen] = await Promise.all([activityByDay(db, userId, 400), frozenDays(db, userId)]);
  return streakFrom(map, frozen);
}

export const ymdOfDay = ymd;
export const DAY_MS = DAY;

export type ActivityItem = { kind: 'lecture' | 'test'; at: string; title: string; detail: string; href: string };

/** The most recent things the student did. */
export async function latestActivity(db: D1Database, userId: number, limit = 5): Promise<ActivityItem[]> {
  const [lec, tests] = await Promise.all([
    db
      .prepare(
        `SELECT p.completed_at AS at, l.id, l.day_number, l.title FROM lecture_progress p JOIN lectures l ON l.id = p.lecture_id
         WHERE p.user_id = ? AND p.completed_at IS NOT NULL ORDER BY p.completed_at DESC LIMIT ?`,
      )
      .bind(userId, limit)
      .all<{ at: string; id: number; day_number: number; title: string }>(),
    db
      .prepare(
        `SELECT t.id, t.mode, t.finished_at AS at, COUNT(ti.position) AS n, SUM(CASE WHEN ti.is_correct = 1 THEN 1 ELSE 0 END) AS ok
         FROM tests t JOIN test_items ti ON ti.test_id = t.id
         WHERE t.user_id = ? AND t.finished_at IS NOT NULL GROUP BY t.id ORDER BY t.finished_at DESC LIMIT ?`,
      )
      .bind(userId, limit)
      .all<{ id: number; mode: string; at: string; n: number; ok: number }>(),
  ]);
  const items: ActivityItem[] = [
    ...lec.results.map((r) => ({ kind: 'lecture' as const, at: r.at, title: r.title, detail: `Watched · Day ${r.day_number}`, href: `/lectures/${r.id}` })),
    ...tests.results.map((r) => ({
      kind: 'test' as const,
      at: r.at,
      title: `${r.mode === 'timed' ? 'Timed' : r.mode === 'untimed' ? 'Untimed' : r.mode === 'warmup' ? 'Warmup' : 'Tutor'} test · ${r.n} question${r.n === 1 ? '' : 's'}`,
      detail: `${r.n ? Math.round(((r.ok ?? 0) / r.n) * 100) : 0}% correct`,
      href: `/tests/${r.id}/results`,
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

/** "2 hours ago" style label for an activity time. */
export function ago(utc: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(utc.replace(' ', 'T') + 'Z')) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Questions answered today (New York day). */
export function questionsToday(map: Map<string, DayCount>) {
  return map.get(ymd(todayUtc()))?.questions ?? 0;
}
