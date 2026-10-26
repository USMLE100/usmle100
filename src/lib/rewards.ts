import type { IconName } from '../views/icons';
import { activityByDay, frozenDays, longestStreak, streakDays, streakFrom, ymdOfDay, DAY_MS } from './activity';
import { todayUtc } from './content';

/**
 * Streaks & Milestones (V12 pages 81–87). Every number comes from recorded activity.
 * XP: 10 per completed lecture and 15 per study day that continues a streak. A level is every 60 XP.
 */
export const XP_PER_LECTURE = 10;
export const XP_PER_STREAK_DAY = 15;
export const XP_PER_LEVEL = 60;
/** Streak freezes each student has (V12 shows 2). */
export const FREEZES = 2;

export type Badge = { key: string; name: string; desc: string; icon: IconName; pct: number; earned: boolean };

export async function rewards(db: D1Database, userId: number, cohort: { id: number; lecture_days: number; total_days: number } | null, day100Reached: boolean) {
  const [map, frozen, lec, minutes, subj, evening, tutoring, book, cards, qs] = await Promise.all([
    activityByDay(db, userId, 400),
    frozenDays(db, userId),
    cohort
      ? db.prepare('SELECT COUNT(*) AS n FROM lecture_progress p JOIN lectures l ON l.id = p.lecture_id WHERE p.user_id = ? AND l.cohort_id = ? AND p.completed_at IS NOT NULL').bind(userId, cohort.id).first<{ n: number }>()
      : null,
    db
      .prepare('SELECT COALESCE(SUM(l.duration_seconds), 0) AS s FROM lecture_progress p JOIN lectures l ON l.id = p.lecture_id WHERE p.user_id = ? AND p.completed_at IS NOT NULL')
      .bind(userId)
      .first<{ s: number }>(),
    cohort
      ? db
          .prepare(
            `SELECT l.subject_id, COUNT(*) AS total, SUM(CASE WHEN p.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS done
             FROM lectures l LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?
             WHERE l.cohort_id = ? AND l.status = 'live' AND l.subject_id IS NOT NULL GROUP BY l.subject_id`,
          )
          .bind(userId, cohort.id)
          .all<{ subject_id: number; total: number; done: number }>()
      : null,
    db.prepare('SELECT COUNT(*) AS n FROM evening_progress WHERE user_id = ?').bind(userId).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM tutoring_sessions WHERE user_id = ?').bind(userId).first<{ n: number }>(),
    db
      .prepare("SELECT (SELECT COUNT(*) FROM book_chapters WHERE status = 'live') AS total, (SELECT COUNT(*) FROM book_reads r JOIN book_chapters c ON c.id = r.chapter_id WHERE r.user_id = ? AND c.status = 'live') AS read")
      .bind(userId)
      .first<{ total: number; read: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM flashcard_log WHERE user_id = ?').bind(userId).first<{ n: number }>(),
    db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(ti.is_correct), 0) AS ok FROM test_items ti JOIN tests t ON t.id = ti.test_id WHERE t.user_id = ? AND ti.chosen_index IS NOT NULL')
      .bind(userId)
      .first<{ n: number; ok: number }>(),
  ]);
  const lectures = lec?.n ?? 0;
  const total = cohort?.lecture_days ?? 90;
  const streak = streakFrom(map, frozen);
  const longest = longestStreak(map, frozen);
  const xp = lectures * XP_PER_LECTURE + streakDays(map, frozen) * XP_PER_STREAK_DAY;
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const bestSubject = Math.max(0, ...(subj?.results ?? []).map((s) => (s.total ? s.done / s.total : 0)));
  const answered = qs?.n ?? 0;
  const accuracy = answered ? (qs!.ok / answered) * 100 : 0;
  const pct = (v: number, of: number) => Math.max(0, Math.min(100, Math.floor((v / of) * 100)));
  const b = (key: string, name: string, desc: string, icon: IconName, p: number): Badge => ({ key, name, desc, icon, pct: p, earned: p >= 100 });
  const list: Badge[] = [
    b('first', 'The First Step', 'Complete your first USMLE100 lecture', 'play', pct(lectures, 1)),
    b('fire7', 'On Fire', 'Maintain a 7-day study streak', 'fire', pct(longest, 7)),
    b('fire30', 'Unstoppable', 'Maintain a 30-day study streak', 'fire', pct(longest, 30)),
    b('legend', 'Legendary 100', 'Complete all 100 days of the program', 'premium', lectures >= total && day100Reached ? 100 : Math.min(99, pct(lectures, total))),
    b('half', 'Halfway Hero', 'Complete 50% of the course', 'flag', pct(lectures, Math.ceil(total / 2))),
    b('subject', 'Subject Conqueror', 'Complete every lesson in one subject', 'check_circle', Math.floor(bestSubject * 100)),
    b('night', 'Night Scholar', 'Watch your first Evening Questions class', 'nights', pct(evening?.n ?? 0, 1)),
    b('warrior', 'Question Warrior', 'Complete 12 Evening Questions classes', 'shield', pct(evening?.n ?? 0, 12)),
    b('mentor1', 'Mentor’s Apprentice', 'Complete your first one-on-one tutoring session', 'person', pct(tutoring?.n ?? 0, 1)),
    b('mentor10', 'Mentorship Master', 'Complete 10 one-on-one tutoring sessions', 'school', pct(tutoring?.n ?? 0, 10)),
    b('book', 'Cover to Cover', 'Complete the USMLE100 Book', 'book', book?.total ? pct(book.read, book.total) : 0),
    b('memory', 'Memory Machine', 'Review 500 flashcards', 'cards', pct(cards?.n ?? 0, 500)),
    b('qbank', 'QBank Conqueror', 'Complete 1,000 practice questions', 'quiz', pct(answered, 1000)),
    b('maker', 'Think Like the Test Maker', 'Achieve at least 80% accuracy across 100 practice questions', 'trophy', answered < 100 ? pct(answered, 100) / 2 : accuracy >= 80 ? 100 : 50 + Math.floor(pct(accuracy, 80) / 2)),
  ];
  const others = list.filter((x) => x.earned).length;
  list.push(b('max', 'USMLE100 MAX Scholar', 'Earn every other milestone across all USMLE100 learning modalities', 'star', pct(others, list.length)));
  const earned = list.filter((x) => x.earned).length;

  // A freeze can cover yesterday when it was missed and the day before kept the streak going.
  const yesterday = ymdOfDay(todayUtc() - DAY_MS);
  const before = ymdOfDay(todayUtc() - 2 * DAY_MS);
  const counts = (d: string) => { const v = map.get(d); return !!v && (v.lectures > 0 || v.questions >= 10); };
  const freezesLeft = Math.max(0, FREEZES - frozen.size);
  const canFreeze = freezesLeft > 0 && !counts(yesterday) && !frozen.has(yesterday) && (counts(before) || frozen.has(before));
  return {
    streak, longest, xp, level, toNext: level * XP_PER_LEVEL - xp, levelPct: Math.floor(((xp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100),
    lectures, total, minutes: Math.round((minutes?.s ?? 0) / 60), badges: list, earned, freezesLeft, canFreeze, freezeDay: yesterday,
  };
}
