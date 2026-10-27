import { cohortDay, currentCohort, dayDate, fmtDate, type Cohort } from './content';

/**
 * Which cohort a new purchase joins (owner: "students enrolled in the correct cohort associated with their purchase,
 * not silently assigned to the wrong class"). The owner picks the cohort now enrolling; otherwise the most recently
 * scheduled one. It is shown before payment, saved with the pending enrollment, and the payment activates exactly it.
 * Late joining is allowed until the owner's "enrollment closes after Day N" (default: until the last lecture day).
 */
export type Enrolling = { cohort: Cohort; day: number; closeDay: number; closed: boolean; startLabel: string };

export async function enrollingCohort(db: D1Database): Promise<Enrolling | null> {
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('enrolling_cohort_id', 'enroll_close_day')").all<{ key: string; value: string }>()).results;
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? '';
  const pinned = Number(get('enrolling_cohort_id')) || null;
  const cohort = await currentCohort(db, pinned);
  if (!cohort) return null;
  const day = cohortDay(cohort);
  const setting = Number(get('enroll_close_day'));
  const closeDay = setting >= 1 && setting <= cohort.lecture_days ? setting : cohort.lecture_days;
  return {
    cohort,
    day,
    closeDay,
    closed: day > closeDay,
    startLabel: fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  };
}

/** One sentence for the checkout pages. */
export function enrollingLine(e: Enrolling) {
  if (e.closed) return `Enrollment for ${e.cohort.name} has closed. Please contact us about the next cohort.`;
  if (e.day < 1) return `You’ll join ${e.cohort.name}. Day 1 is ${e.startLabel}.`;
  return `You’ll join ${e.cohort.name}, which started on ${e.startLabel} and is on Day ${e.day} of ${e.cohort.lecture_days}. All earlier lecture recordings are included.`;
}
