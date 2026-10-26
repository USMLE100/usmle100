import { todayUtc } from './content';

/**
 * Flash cards: faculty-written, scheduled with Leitner boxes.
 * A card reaches a student once they have watched the lecture it comes from (cards with no lecture are open to all).
 * Box n is next due after BOX_DAYS[n] days. "Again" goes back to box 1, "Good" moves up one box, "Easy" two.
 */
export const BOX_DAYS = [0, 1, 3, 7, 16, 35, 90];
/** New cards introduced per day, so a backlog arrives in batches. */
export const NEW_PER_DAY = 20;

export const today = () => new Date(todayUtc()).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

export type Card = { id: number; front: string; back: string; subject_id: number | null; section_id: number | null; lecture_id: number | null; lecture_title: string | null };

/** Cards this student can see: live, and either not tied to a lecture or tied to one they've watched. */
const OPEN = `f.status = 'live' AND (f.lecture_id IS NULL OR EXISTS (
  SELECT 1 FROM lecture_progress p WHERE p.lecture_id = f.lecture_id AND p.user_id = ?1 AND p.completed_at IS NOT NULL))`;

/** Today's queue: cards that are due, then up to the day's allowance of new ones. */
export async function dueQueue(db: D1Database, userId: number) {
  const t = today();
  const [due, introducedToday] = await Promise.all([
    db
      .prepare(
        `SELECT f.id, f.front, f.back, f.subject_id, f.section_id, f.lecture_id, l.title AS lecture_title
         FROM flashcard_reviews r JOIN flashcards f ON f.id = r.card_id LEFT JOIN lectures l ON l.id = f.lecture_id
         WHERE r.user_id = ?1 AND r.due_on <= ?2 AND ${OPEN} ORDER BY r.due_on, f.id`,
      )
      .bind(userId, t)
      .all<Card>(),
    db.prepare("SELECT COUNT(DISTINCT card_id) AS n FROM flashcard_log WHERE user_id = ? AND reviewed_at >= ? AND rating = 'first'").bind(userId, t).first<{ n: number }>(),
  ]);
  const room = Math.max(0, NEW_PER_DAY - (introducedToday?.n ?? 0));
  const fresh = room
    ? (
        await db
          .prepare(
            `SELECT f.id, f.front, f.back, f.subject_id, f.section_id, f.lecture_id, l.title AS lecture_title
             FROM flashcards f LEFT JOIN lectures l ON l.id = f.lecture_id
             WHERE ${OPEN} AND NOT EXISTS (SELECT 1 FROM flashcard_reviews r WHERE r.card_id = f.id AND r.user_id = ?1)
             ORDER BY COALESCE(l.day_number, 0), f.id LIMIT ?2`,
          )
          .bind(userId, room)
          .all<Card>()
      ).results
    : [];
  return [...due.results, ...fresh];
}

/** All cards open to this student in a section, subject or lecture (topic practice). */
export async function cardsIn(db: D1Database, userId: number, by: { section?: number; lecture?: number }) {
  const where = by.section ? 'AND f.section_id = ?2' : by.lecture ? 'AND f.lecture_id = ?2' : '';
  return (
    await db
      .prepare(
        `SELECT f.id, f.front, f.back, f.subject_id, f.section_id, f.lecture_id, l.title AS lecture_title
         FROM flashcards f LEFT JOIN lectures l ON l.id = f.lecture_id WHERE ${OPEN} ${where} ORDER BY f.id`,
      )
      .bind(userId, by.section ?? by.lecture ?? null)
      .all<Card>()
  ).results;
}

export async function cardOpen(db: D1Database, userId: number, cardId: number) {
  return db.prepare(`SELECT f.id FROM flashcards f WHERE f.id = ?2 AND ${OPEN}`).bind(userId, cardId).first();
}

export type Rating = 'again' | 'good' | 'easy';

export async function rate(db: D1Database, userId: number, cardId: number, rating: Rating) {
  const t = today();
  const cur = await db.prepare('SELECT box, reps, lapses FROM flashcard_reviews WHERE user_id = ? AND card_id = ?').bind(userId, cardId).first<{ box: number; reps: number; lapses: number }>();
  const box = rating === 'again' ? 1 : Math.min(BOX_DAYS.length - 1, (cur?.box ?? 0) + (rating === 'easy' ? 2 : 1));
  const due = addDays(t, BOX_DAYS[box]);
  await db.batch([
    db
      .prepare(
        `INSERT INTO flashcard_reviews (user_id, card_id, box, due_on, reps, lapses, last_reviewed_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, datetime('now'))
         ON CONFLICT (user_id, card_id) DO UPDATE SET box = ?3, due_on = ?4, reps = reps + 1, lapses = lapses + ?5, last_reviewed_at = datetime('now')`,
      )
      .bind(userId, cardId, box, due, rating === 'again' ? 1 : 0),
    db.prepare('INSERT INTO flashcard_log (user_id, card_id, rating) VALUES (?, ?, ?)').bind(userId, cardId, cur ? rating : 'first'),
  ]);
  return due;
}

/** For the Review page: how many are due today and when the next ones arrive. */
export async function queueSummary(db: D1Database, userId: number) {
  const q = await dueQueue(db, userId);
  const next = await db.prepare('SELECT MIN(due_on) AS d FROM flashcard_reviews WHERE user_id = ? AND due_on > ?').bind(userId, today()).first<{ d: string | null }>();
  return { due: q.length, next: next?.d ?? null };
}
