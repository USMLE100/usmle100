import type { Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { cohortDay, defaultLecturesUntil, fmtDate, todayUtc, ymdToUtc, type Cohort } from '../lib/content';
import { PortalLayout, PageHead } from './layout';


/** Students can watch lectures until 60 days after Day 100, or the date an admin set for them. Null = still allowed. */
export async function lecturesEndedOn(c: Context<AppEnv>, cohort: Cohort | null): Promise<string | null> {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  if (isStaff(user) || !enr || !cohort) return null;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  const today = new Date(todayUtc()).toISOString().slice(0, 10);
  return today > until ? until : null;
}

/**
 * After the 90 lecture days, remind students when their lecture recordings close.
 * Shown from Day 91 until access ends; not shown to staff.
 */
export function lectureNotice(c: Context<AppEnv>, cohort: Cohort | null) {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  if (isStaff(user) || !enr || !cohort || cohortDay(cohort) <= cohort.lecture_days) return null;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  const daysLeft = Math.round((ymdToUtc(until) - todayUtc()) / 86400_000) + 1;
  return daysLeft >= 1 ? { until, daysLeft } : null;
}

export function LectureNotice(props: { n: { until: string; daysLeft: number } | null }) {
  if (!props.n) return null;
  const date = fmtDate(new Date(props.n.until + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const soon = props.n.daysLeft <= 14;
  return (
    <p class={'flash ' + (soon ? 'flash-error' : 'flash-ok')} role="status">
      You’ve finished the 90 days of lectures. Your lecture recordings stay available until <strong>{date}</strong>
      {soon ? <> — only <strong>{props.n.daysLeft} day{props.n.daysLeft === 1 ? '' : 's'} left</strong>.</> : '.'} After that they close.
    </p>
  );
}

export function lecturesEndedPage(c: Context<AppEnv>, until: string, email: string) {
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Lectures" active="lectures" user={c.get('user')!}>
      <PageHead eyebrow="Study" title="Lectures" />
      <section class="card">
        <p>
          Your access to the lecture recordings ended on {fmtDate(new Date(until + 'T00:00:00Z'), { month: 'long', day: 'numeric', year: 'numeric' })}.
          {email && <> To ask for more time, email <a href={`mailto:${email}?subject=${encodeURIComponent('USMLE100: more time for lectures')}`}>{email}</a>.</>}
        </p>
      </section>
    </PortalLayout>,
  );
}

