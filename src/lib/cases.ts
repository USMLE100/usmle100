/**
 * Appeals and view-credit disputes: deadlines and the effects of the owner's decision.
 * - View disputes: decision target 2 business days; 12 hours once an exam within 48 hours is verified
 *   (whichever is earlier), never extending the original target.
 * - Appeals: the student gets an update at least every 5 business days; an appeal reopened with material
 *   new evidence gets a decision target of 3 business days.
 * - A granted appeal reinstates the account and extends each affected paid enrollment by the exact time it was
 *   restricted (access is date-based, so part days round up in the student's favour). An enrollment that ran out
 *   during the restriction gets back the time it had left when the restriction began. Never twice per case.
 * - A granted view dispute restores one view of that video, once per case.
 */
import { currentCohort, defaultLecturesUntil } from './content';

const DAY = 86400_000;

/** Adds business days (Monday to Friday) to a moment. */
export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setTime(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export const iso = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
export const parseIso = (s: string) => new Date(s.replace(' ', 'T') + 'Z');

export function initialDue(kind: 'appeal' | 'view-dispute', newEvidence: boolean, now = new Date()) {
  if (kind === 'view-dispute') return addBusinessDays(now, 2);
  return addBusinessDays(now, newEvidence ? 3 : 5);
}

/** Expedited target once the exam date is verified: 12 hours, or the existing target if that is sooner. */
export function expeditedDue(currentDue: string, now = new Date()) {
  const twelve = new Date(now.getTime() + 12 * 3600_000);
  const cur = parseIso(currentDue);
  return twelve < cur ? twelve : cur;
}

/** True when an exam date (YYYY-MM-DD) is within the next 48 hours (or today). */
export function examWithin48h(examDate: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return false;
  const t = Date.parse(examDate + 'T23:59:59Z');
  return t >= now.getTime() - DAY && t - now.getTime() <= 48 * 3600_000 + DAY;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const endOfDay = (s: string) => Date.parse(s + 'T23:59:59Z');

/**
 * Extends the student's paid enrollments for the time between `restrictedFrom` and now. Returns what was given.
 * Safe to call twice: the UNIQUE (case_id, enrollment_id) record stops a second extension.
 */
export async function compensate(db: D1Database, caseId: number, userId: number, restrictedFrom: Date, now = new Date()) {
  const seconds = Math.max(0, Math.round((now.getTime() - restrictedFrom.getTime()) / 1000));
  if (seconds === 0) return [];
  const enrs = (
    await db.prepare("SELECT id, cohort_id, lectures_until FROM enrollments WHERE user_id = ? AND status = 'active'").bind(userId).all<{ id: number; cohort_id: number | null; lectures_until: string | null }>()
  ).results;
  const given: { enrollmentId: number; oldUntil: string; newUntil: string }[] = [];
  for (const e of enrs) {
    const cohort = await currentCohort(db, e.cohort_id);
    if (!cohort) continue;
    const oldUntil = e.lectures_until || defaultLecturesUntil(cohort);
    const oldEnd = endOfDay(oldUntil);
    // Only time when this enrollment was still running counts.
    if (oldEnd <= restrictedFrom.getTime()) continue;
    const newEnd =
      oldEnd < now.getTime()
        ? now.getTime() + (oldEnd - restrictedFrom.getTime()) // ran out during the restriction: give back what was left
        : oldEnd + Math.min(seconds * 1000, now.getTime() - restrictedFrom.getTime());
    const newUntil = ymd(newEnd); // access lasts to the end of that day, so part days round up
    const r = await db
      .prepare('INSERT INTO compensations (case_id, user_id, enrollment_id, restricted_seconds, old_until, new_until) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (case_id, enrollment_id) DO NOTHING')
      .bind(caseId, userId, e.id, seconds, oldUntil, newUntil)
      .run();
    if (!r.meta.changes) continue;
    await db.prepare('UPDATE enrollments SET lectures_until = ? WHERE id = ?').bind(newUntil, e.id).run();
    given.push({ enrollmentId: e.id, oldUntil, newUntil });
  }
  return given;
}

/** Every few minutes: overdue cases raise one warning for staff (warnings are also emailed to the owner). */
export async function escalateCases(db: D1Database) {
  const due = (
    await db.prepare("SELECT id, kind, user_id FROM cases WHERE status <> 'decided' AND escalated_at IS NULL AND due_at < ?").bind(iso(new Date())).all<{ id: number; kind: string; user_id: number }>()
  ).results;
  for (const c of due) {
    await db.batch([
      db.prepare("UPDATE cases SET escalated_at = datetime('now') WHERE id = ?").bind(c.id),
      db
        .prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'case-overdue', ?, ?)")
        .bind(c.user_id, `${c.kind === 'appeal' ? 'Appeal' : 'View dispute'} #${c.id} is past its target. Please review it in Admin → Appeals and disputes.`),
    ]);
  }
  return due.length;
}
