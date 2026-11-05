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

// Typed variants (trailing slash, no hyphen) go to the page instead of "not found".
launchCheck.get('/launch-check/', (c) => c.redirect('/admin/launch-check'));
launchCheck.get('/launchcheck', (c) => c.redirect('/admin/launch-check'));

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
  const qaItem = qa?.lecture_id ? `L:${Number(qa.lecture_id)}` : '';
  const qaViews = qaItem ? (await db.prepare('SELECT id, user_id, created_at, started_at, last_beat_at, expires_at, duration, watched_seconds, counted, counted_reason, diag FROM view_sessions WHERE item = ? ORDER BY created_at').bind(qaItem).all<any>()).results : [];
  const qaUsed = qaItem ? (await db.prepare("SELECT s.user_id, SUM(s.counted) AS used, (SELECT COALESCE(SUM(extra), 0) FROM view_grants g WHERE g.user_id = s.user_id AND g.item = ?1) AS extra FROM view_sessions s WHERE s.item = ?1 GROUP BY s.user_id").bind(qaItem).all<any>()).results : [];
  const qaLen = qa?.lecture_id ? (await db.prepare('SELECT duration_seconds AS d FROM lectures WHERE id = ?').bind(Number(qa.lecture_id)).first<{ d: number | null }>())?.d ?? null : null;
  const t = (e: number | null) => (e ? new Date(e * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—');

  // Stripe's Payment Link objects carry no creation date: show the link and its product name only.
  let links: { ok: true; items: { id: string; url: string; name: string }[] } | { ok: false; why: string };
  if (!c.env.STRIPE_SECRET_KEY) links = { ok: false, why: 'Stripe key not set' };
  else {
    try {
      const r = await fetch('https://api.stripe.com/v1/payment_links?active=true&limit=100', { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } });
      const j = (await r.json()) as any;
      links = r.ok ? { ok: true, items: (j.data ?? []).map((x: any) => ({ id: String(x.id ?? ''), url: String(x.url ?? ''), name: String(x.metadata?.name ?? x.line_items?.data?.[0]?.description ?? '') })) } : { ok: false, why: `Stripe answered ${r.status}` };
    } catch {
      links = { ok: false, why: 'Stripe could not be reached' };
    }
  }

  const ok = (b: boolean) => <strong style={b ? 'color:var(--green)' : 'color:#a3402c'}>{b ? 'OK' : 'NEEDS ATTENTION'}</strong>;
  const offOk = REQUIRED_OFF.every(([d]) => offRows.some((r) => r.date === d));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Launch check" active="admin-launch" user={user}>
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
        <a class="btn btn-outline btn-sm" href="/admin/payment-links" style="align-self:flex-start">Open payment link audit (read-only)</a>
        {links.ok && (links.items.length ? <ul class="small" style="margin:0">{links.items.map((l) => <li>{l.url}{l.name ? ` (${l.name})` : ''}: buyers through this link are not enrolled automatically</li>)}</ul> : <p style="margin:0">None active.</p>)}
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
        {qa?.lecture_id && (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Student</th><th scope="col">Viewing</th><th scope="col">Opened</th><th scope="col">Playback began</th><th scope="col">Last progress</th><th scope="col">24 h ends</th><th scope="col">Watched</th><th scope="col">View used?</th></tr></thead>
            <tbody>{qaViews.map((v: any) => (
              <><tr><td>ID {v.user_id}</td><td>{v.id}</td><td>{t(v.created_at)}</td><td>{t(v.started_at)}</td><td>{t(v.last_beat_at)}</td><td>{t(v.expires_at)}</td>
                <td>{Math.round(v.watched_seconds)} s of {v.duration ? `${Math.round(v.duration)} s (${Math.round((100 * v.watched_seconds) / v.duration)}%)` : 'unknown length'}</td>
                <td>{v.counted ? `yes (${v.counted_reason === 'expired' ? '24 h ended' : '65% reached'})` : 'no'}</td></tr>
              {v.diag && <tr><td colSpan={8} class="small muted">Player: {v.diag}</td></tr>}</>
            ))}</tbody>
          </table></div>
        )}
        {qa?.lecture_id && <p class="small muted" style="margin:0">Lecture length on file: {qaLen ?? 'not yet known'} s. Views used per student: {qaUsed.map((u: any) => `ID ${u.user_id}: ${u.used} of ${2 + (u.extra ?? 0)}`).join(' · ') || 'none'}.</p>}
      </section>
    </PortalLayout>,
  );
});

/**
 * Owner only, read-only (owner, 5 Nov 2026): what each active Payment Link sells and who paid through it, matched to
 * site accounts by email, so link buyers can be checked for access by hand. Payment Link checkouts carry no site
 * reference, so the site never enrolls them automatically; this page only reports. Only GET requests reach Stripe.
 */
launchCheck.get('/payment-links', async (c) => {
  const user = c.get('user')!;
  if (!isOwner(user)) return c.notFound();
  c.header('Cache-Control', 'no-store');
  const db = c.env.DB;
  const key = c.env.STRIPE_SECRET_KEY;
  const H = { headers: { Authorization: `Bearer ${key}` } };
  const usd = (cents: number | null | undefined) => (cents == null ? '?' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  const day = (t: number) => new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  let error = '';
  let links: any[] = [];
  if (!key) error = 'Stripe key not set';
  else {
    try {
      const r = await fetch('https://api.stripe.com/v1/payment_links?active=true&limit=100&expand[]=data.line_items', H);
      if (r.ok) links = ((await r.json()) as any).data ?? [];
      else error = `Stripe answered ${r.status}`;
    } catch {
      error = 'Stripe could not be reached';
    }
  }
  const rows: { link: any; price: string; after: string; sessions: any[]; more: boolean; err?: string }[] = [];
  for (const l of links) {
    const li = l.line_items?.data?.[0];
    const pr = li?.price;
    const price = pr ? `${usd(pr.unit_amount)}${pr.recurring ? ` every ${pr.recurring.interval_count > 1 ? pr.recurring.interval_count + ' ' : ''}${pr.recurring.interval}` : ' one-time'}${li.description ? ' · ' + li.description : ''}` : 'price not shown';
    const ac = l.after_completion;
    const after = ac?.type === 'redirect' ? `redirects to ${String(ac.redirect?.url ?? '')}` : 'Stripe confirmation page';
    let sessions: any[] = [], more = false, err: string | undefined;
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions?payment_link=${encodeURIComponent(l.id)}&status=complete&limit=100&expand[]=data.subscription`, H);
      if (r.ok) {
        const j = (await r.json()) as any;
        sessions = j.data ?? [];
        more = !!j.has_more;
      } else err = `Stripe answered ${r.status}`;
    } catch {
      err = 'Stripe could not be reached';
    }
    rows.push({ link: l, price, after, sessions, more, err });
  }
  // What each buyer has on the site, by email. Read-only.
  const access = async (email: string) => {
    const u = email ? await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').bind(email).first<{ id: number }>() : null;
    if (!u) return { id: null as number | null, has: 'no site account with this email' };
    const progs = (await db.prepare("SELECT package_id, status, amount_cents, note FROM enrollments WHERE user_id = ? AND status IN ('active','refunded','cancelled') ORDER BY id").bind(u.id).all<any>()).results;
    const ev = (await db.prepare('SELECT COALESCE(SUM(months), 0) AS m FROM evening_subscriptions WHERE user_id = ?').bind(u.id).first<{ m: number }>())?.m ?? 0;
    const book = !!(await db.prepare('SELECT 1 FROM book_access WHERE user_id = ?').bind(u.id).first());
    const parts = [
      ...progs.map((e: any) => `program ${e.package_id} (${e.status}${e.amount_cents ? ', ' + usd(e.amount_cents) : ''}${e.note ? ', ' + String(e.note).slice(0, 60) : ''})`),
      ev ? `Evening Questions: ${ev} month(s) given` : '',
      book ? 'Course Book' : '',
    ].filter(Boolean);
    return { id: u.id, has: parts.join(' · ') || 'account exists, no access given' };
  };
  const detail: Record<string, { id: number | null; has: string }> = {};
  for (const r of rows) for (const s of r.sessions) {
    const em = String(s.customer_details?.email ?? s.customer_email ?? '');
    if (!(em in detail)) detail[em] = await access(em);
  }
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Payment link audit" active="admin-launch" user={user} wide>
      <Eyebrow>Owner · read-only</Eyebrow>
      <h1>Payment link audit</h1>
      <p class="muted">Payments made through Stripe Payment Links are not matched to a site account automatically. This page lists every completed payment per active link and what that buyer currently has on the site. Nothing here changes Stripe or the site.</p>
      {error && <p><strong>{error}</strong></p>}
      {rows.map((r) => (
        <section class="card stack">
          <h2 style="margin:0">{r.price}</h2>
          <p class="small" style="margin:0">Link ID <code>{r.link.id}</code> · {r.link.url} · after payment: {r.after}{r.link.metadata?.name ? ` · ${r.link.metadata.name}` : ''}</p>
          {r.err ? <p><strong>{r.err}</strong></p> : r.sessions.length === 0 ? <p class="small muted" style="margin:0">No completed payments.</p> : (
            <div class="table-box"><table class="t">
              <thead><tr><th scope="col">Paid</th><th scope="col">Buyer</th><th scope="col">Amount</th><th scope="col">Stripe</th><th scope="col">Site account</th><th scope="col">Has on the site now</th></tr></thead>
              <tbody>{r.sessions.map((s: any) => {
                const em = String(s.customer_details?.email ?? s.customer_email ?? '');
                const d = detail[em] ?? { id: null, has: '' };
                const sub = s.subscription && typeof s.subscription === 'object' ? `subscription ${s.subscription.status}` : s.mode;
                return <tr><td class="small">{day(s.created)}</td><td class="small">{s.customer_details?.name ?? ''} {em}</td><td class="small">{usd(s.amount_total)} ({s.payment_status})</td><td class="small">{sub} · {s.id.slice(0, 14)}…</td><td class="small">{d.id ? `ID ${d.id}` : '—'}</td><td class="small">{d.has}</td></tr>;
              })}</tbody>
            </table></div>
          )}
          {r.more && <p class="small muted" style="margin:0">Showing the latest 100 payments only.</p>}
        </section>
      ))}
    </PortalLayout>,
  );
});
