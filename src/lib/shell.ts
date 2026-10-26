import type { Shell } from './types';
import { studyStreak } from './activity';
import { getSettings } from './settings';

/** Streak, lecture progress and contact email for the portal top bar and menu. */
export async function loadShell(db: D1Database, userId: number, cohortId: number | null): Promise<Shell> {
  const cohort = await db
    .prepare(cohortId ? 'SELECT id, lecture_days FROM cohorts WHERE id = ?' : 'SELECT id, lecture_days FROM cohorts ORDER BY start_date DESC LIMIT 1')
    .bind(...(cohortId ? [cohortId] : []))
    .first<{ id: number; lecture_days: number }>();
  const [done, streak, settings] = await Promise.all([
    cohort
      ? db
          .prepare('SELECT COUNT(*) AS n FROM lecture_progress p JOIN lectures l ON l.id = p.lecture_id WHERE p.user_id = ? AND l.cohort_id = ? AND p.completed_at IS NOT NULL')
          .bind(userId, cohort.id)
          .first<{ n: number }>()
      : Promise.resolve(null),
    studyStreak(db, userId),
    getSettings(db),
  ]);
  return { streak, lecturesDone: done?.n ?? 0, lecturesTotal: cohort?.lecture_days ?? 0, contact: settings.contact_email, terms: !!settings.terms_text, privacy: !!settings.privacy_text };
}
