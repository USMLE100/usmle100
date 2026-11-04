import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner } from '../lib/types';
import { requireAdminOrFacultyAllowed } from '../lib/auth';
import { PortalLayout, Eyebrow } from '../views/layout';
import { currentCohort, dayDate, cohortDay, fmtDate } from '../lib/content';

/**
 * Owner only, read-only (owner, 4 Nov 2026): the launch checks that need live data, on one page, so they can be
 * confirmed without opening several dashboards. Nothing on this page changes anything; the Stripe call only lists
 * Payment Links.
 */
export const launchCheck = new Hono<AppEnv>();
launchCheck.use('*', requireAdminOrFacultyAllowed);

const REQUIRED_OFF = [['2026-11-26', 'Thanksgiving'], ['2026-12-24', 'Christmas Eve'], ['2026-12-25', 'Christmas Day']] as const;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

launchCheck.get('/launch-check', async (c) => {
  const user = c.get('user')!;
  if (!isOwner(user)) return c.notFound();
  c.header('Cache-Control', 'no-store');
  const db = c.env.DB;
  const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const qApproved = await n("SELECT COUNT(*) AS n FROM questions WHERE status = 'approved'");
  const qDraft = await n("SELECT COUNT(*) AS n FROM questions WHERE status = 'draft'");
  const chLive = await n("SELECT COUNT(*) AS n FROM book_chapters WHERE status = 'live' AND file_id IS NOT NULL");
  const chLiveNoFile = await n("SELECT COUNT(*) AS n FROM book_chapters WHERE status = 'live' AND file_id IS NULL");
  const chDraft = await n("SELECT COUNT(*) AS n FROM book_chapters WHERE status = 'draft'");

  const cohort = await currentCohort(db);
  const offRows = cohort ? (await db.prepare('SELECT date, label FROM cohort_days_off WHERE cohort_id = ? ORDER BY date').bind(cohort.id).all<{ date: string; label: string }>()).results : [];
  const today = cohort ? cohortDay(cohort) : 0;
  const lectures = cohort
    ? (await db.prepare('SELECT day_number, title, status, bunny_video_id FROM lectures WHERE cohort_id = ? AND day_number <= ? ORDER BY day_number').bind(cohort.id, Math.max(today, 2)).all<{ day_number: number; title: string; status: string; bunny_video_id: string | null }>()).results
    : [];
  const imports = (await db.prepare("SELECT topic, status, note, start_time, declined_at, approved_at FROM zoom_imports ORDER BY id DESC LIMIT 5").all<any>()).results;
  const qa = await db.prepare("SELECT c.id, c.name, l.id AS lecture_id, l.bunny_video_id FROM cohorts c LEFT JOIN lectures l ON l.cohort_id = c.id WHERE c.name LIKE 'QA test%'").first<any>();
  const qaStudents = qa ? await n(`SELECT COUNT(*) AS n FROM enrollments WHERE cohort_id = ${Number(qa.id)}`) : 0;

  let links: { ok: true; items: { id: string; url: string; created: number }[] } | { ok: false; why: string };
  if (!c.env.STRIPE_SECRET_KEY) links = { ok: false, why: 'Stripe key not set' };
  else {
    try {
      const r = await fetch('https://api.stripe.com/v1/payment_links?active=true&limit=100', { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } });
      const j = (await r.json()) as any;
      links = r.ok ? { ok: true, items: (j.data ?? []).map((x: any) => ({ id: x.id, url: x.url, created: x.created })) } : { ok: false, why: `Stripe answered ${r.status}` };
    } catch {
      links = { ok: false, why: 'Stripe could not be reached' };
    }
  }

  const ok = (b: boolean) => <strong style={b ? 'color:var(--green)' : 'color:#a3402c'}>{b ? 'OK' : 'NEEDS ATTENTION'}</strong>;
  const offOk = REQUIRED_OFF.every(([d]) => offRows.some((r) => r.date === d));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Launch check" active="admin-lectures" user={user}>
      <Eyebrow>Owner · read-only</Eyebrow>
      <h1>Launch check</h1>
      <section class="card stack">
        <h2 style="margin:0">1. Question bank and Course Book {ok(qApproved > 0 && chLive > 0)}</h2>
        <p style="margin:0">Questions students can use (approved): <strong>{qApproved}</strong> · drafts not shown to students: {qDraft}</p>
        <p style="margin:0">Course Book chapters students can open (live, with PDF): <strong>{chLive}</strong> · live without a PDF: {chLiveNoFile} · drafts: {chDraft}</p>
      </section>
      <section class="card stack">
        <h2 style="margin:0">2. {cohort?.name ?? 'No cohort'} holidays {ok(offOk)}</h2>
        {REQUIRED_OFF.map(([d, label]) => <p style="margin:0">{label} ({d}): {offRows.some((r) => r.date === d) ? 'no class ✓' : <strong>missing: classes are scheduled that day</strong>}</p>)}
        <p class="small muted" style="margin:0">All days off: {offRows.map((r) => `${r.date} ${r.label}`).join(' · ') || 'none'}</p>
        {cohort && <p style="margin:0">Today is Day {today}. Day 90: {fmtDate(dayDate(cohort, 90), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · Day 100: {fmtDate(dayDate(cohort, 100), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>}
      </section>
      <section class="card stack">
        <h2 style="margin:0">3. Active Stripe Payment Links {links.ok ? ok(links.items.length === 0) : <strong>{links.why}</strong>}</h2>
        {links.ok && (links.items.length ? <ul class="small" style="margin:0">{links.items.map((l) => <li>{l.url} (created {ymd(new Date(l.created * 1000))}): buyers through this link are not enrolled automatically</li>)}</ul> : <p style="margin:0">None active.</p>)}
      </section>
      <section class="card stack">
        <h2 style="margin:0">4. Lectures so far {ok(lectures.length >= Math.min(today, 90) && lectures.every((l) => l.bunny_video_id))}</h2>
        {Array.from({ length: Math.max(0, Math.min(today, 90)) }, (_, i) => i + 1).map((d) => {
          const l = lectures.find((x) => x.day_number === d);
          return <p style="margin:0">Day {d}: {!l ? <strong>no lecture entry</strong> : !l.bunny_video_id ? <strong>no recording yet</strong> : l.status === 'live' ? 'recording live ✓' : 'recording attached, waiting for your approval'}{l ? ` · ${l.title}` : ''}</p>;
        })}
        <p class="small muted" style="margin:0">Latest Zoom imports: {imports.map((i: any) => `${i.topic} (${i.declined_at ? 'declined' : i.approved_at ? 'approved' : i.status}${i.note ? ': ' + i.note : ''})`).join(' · ') || 'none'}</p>
      </section>
      <section class="card stack">
        <h2 style="margin:0">QA test setup</h2>
        <p style="margin:0">{qa ? `${qa.name}: test lecture ${qa.bunny_video_id ? 'has the test recording' : 'has NO recording'} · ${qaStudents} test student(s)` : 'Not present.'}</p>
      </section>
    </PortalLayout>,
  );
});
