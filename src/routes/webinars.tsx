import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { requireAdminOrFacultyAllowed, requireUser } from '../lib/auth';
import { audit } from '../lib/audit';
import { PublicLayout, PortalLayout, PageHead, Eyebrow, Flash } from '../views/layout';
import { Icon } from '../views/icons';
import { profileComplete } from '../lib/viewing';
import { toCsv } from '../lib/csv';
import { isHttpUrl } from '../lib/settings';

/**
 * Live webinars (owner: "share live webinars on this website, but to see them they must register and provide
 * at least this information"). The list is public; registering uses the student's existing account (no forms to
 * fill in again) once their phone, exam and graduation year are on file; only registered students get the link.
 * Recordings are offered afterwards through Free Lectures, which the owner publishes.
 */
export const webinars = new Hono<AppEnv>();
export const webinarAdmin = new Hono<AppEnv>();
webinarAdmin.use('*', requireAdminOrFacultyAllowed);

type Webinar = { id: number; title: string; description: string | null; starts_at: string; duration_minutes: number; join_url: string | null; status: string };

const et = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
const upcoming = (db: D1Database) =>
  db
    .prepare("SELECT * FROM webinars WHERE status = 'scheduled' AND datetime(starts_at, '+' || duration_minutes || ' minutes') > datetime('now') ORDER BY starts_at")
    .all<Webinar>()
    .then((r) => r.results);

webinars.get('/webinars', async (c) => {
  const user = c.get('user');
  const list = await upcoming(c.env.DB);
  const mine = user
    ? new Set((await c.env.DB.prepare('SELECT webinar_id FROM webinar_registrations WHERE user_id = ?').bind(user.id).all<{ webinar_id: number }>()).results.map((r) => r.webinar_id))
    : new Set<number>();
  const body = (
    <>
      {list.length === 0 ? (
        <section class="card"><p class="muted" style="margin:0">No webinars are scheduled right now. Check back soon.</p></section>
      ) : (
        <div class="stack">
          {list.map((w) => (
            <section class="card stack" style="gap:8px">
              <div class="eyebrow">{et(w.starts_at)} · {w.duration_minutes} min</div>
              <h2 style="margin:0">{w.title}</h2>
              {w.description && <p style="margin:0">{w.description}</p>}
              {mine.has(w.id) ? (
                <a class="btn btn-primary" href={`/webinars/${w.id}`} style="align-self:flex-start">You’re registered: details</a>
              ) : user ? (
                <a class="btn btn-primary" href={`/webinars/${w.id}`} style="align-self:flex-start">Register</a>
              ) : (
                <a class="btn btn-primary" href={`/sign-up?next=${encodeURIComponent('/webinars/' + w.id)}`} style="align-self:flex-start">Create a free account to register</a>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
  if (user)
    return c.html(
      <PortalLayout shell={c.get('shell')} title="Live webinars" active="webinars" user={user}>
        <PageHead eyebrow="Free" title="Live webinars" sub="Free live sessions with USMLE100 faculty. Register to get the link." />
        {body}
      </PortalLayout>,
    );
  return c.html(
    <PublicLayout title="Live webinars" user={null}>
      <main class="wrap page stack" style="max-width:820px;padding-top:32px;padding-bottom:64px">
        <Eyebrow>Free</Eyebrow>
        <h1>Live webinars</h1>
        <p class="muted">Free live sessions with USMLE100 faculty. Create a free account to register and get the link. Already have one? <a href="/sign-in?next=/webinars">Sign in</a>.</p>
        {body}
      </main>
    </PublicLayout>,
  );
});

webinars.get('/webinars/:id{[0-9]+}', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const w = await db.prepare('SELECT * FROM webinars WHERE id = ?').bind(Number(c.req.param('id'))).first<Webinar>();
  if (!w) return c.notFound();
  const registered = !!(await db.prepare('SELECT 1 FROM webinar_registrations WHERE webinar_id = ? AND user_id = ?').bind(w.id, user.id).first());
  const done = Date.parse(w.starts_at) + w.duration_minutes * 60_000 < Date.now();
  return c.html(
    <PortalLayout shell={c.get('shell')} title={w.title} active="webinars" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/webinars">Live webinars</a><Icon name="chevron_right" size={16} />{w.title}</nav>
      <Eyebrow>{et(w.starts_at)} · {w.duration_minutes} min</Eyebrow>
      <h1>{w.title}</h1>
      {c.req.query('ok') && <Flash>You’re registered.</Flash>}
      {w.description && <p>{w.description}</p>}
      {w.status === 'cancelled' ? (
        <Flash kind="error">This webinar was cancelled.</Flash>
      ) : done ? (
        <section class="card"><p style="margin:0">This webinar has ended. If a recording is shared, it will appear in <a href="/free-lectures">Free lectures</a>.</p></section>
      ) : registered ? (
        <section class="card stack">
          <p style="margin:0">You’re registered. Join with the link below at the start time.</p>
          {w.join_url ? <a class="btn btn-primary" href={w.join_url} rel="noopener noreferrer" target="_blank" style="align-self:flex-start"><Icon name="videocam" size={18} />Join the webinar</a> : <p class="muted small" style="margin:0">The link will appear here before it starts.</p>}
          <p class="muted small" style="margin:0">The link is for you only. Please don’t share or record the session.</p>
        </section>
      ) : !isStaff(user) && !profileComplete(user) ? (
        <section class="card stack"><p style="margin:0">To register, please add your phone number, the exam you’re preparing for and your graduation year.</p><a class="btn btn-primary" href={`/account?next=/webinars/${w.id}`} style="align-self:flex-start">Complete my details</a></section>
      ) : (
        <form method="post" action={`/webinars/${w.id}/register`}><button class="btn btn-primary" type="submit">Register with my USMLE100 account</button></form>
      )}
    </PortalLayout>,
  );
});

webinars.post('/webinars/:id{[0-9]+}/register', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const w = await db.prepare("SELECT id FROM webinars WHERE id = ? AND status = 'scheduled'").bind(id).first();
  if (!w) return c.notFound();
  if (!isStaff(user) && !profileComplete(user)) return c.redirect(`/account?next=/webinars/${id}`);
  await db.prepare('INSERT OR IGNORE INTO webinar_registrations (webinar_id, user_id) VALUES (?, ?)').bind(id, user.id).run();
  return c.redirect(`/webinars/${id}?ok=1`);
});

// ---------- Admin ----------

webinarAdmin.get('/webinars', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const rows = (
    await c.env.DB.prepare('SELECT w.*, (SELECT COUNT(*) FROM webinar_registrations r WHERE r.webinar_id = w.id) AS registered FROM webinars w ORDER BY starts_at DESC LIMIT 100').all<Webinar & { registered: number }>()
  ).results;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: webinars" active="admin-webinars" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Live webinars</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">Webinars are listed publicly at /webinars. Students register with their account; only they see the join link. Afterwards, add the recording in <a href="/admin/free-lectures">Free lectures</a> (by its Bunny video ID) and publish it.</p>
      <form method="post" action="/admin/webinars" class="card stack" style="gap:12px">
        <h2 style="margin:0">Schedule a webinar</h2>
        <label class="field">Title<input type="text" name="title" required maxlength={160} /></label>
        <label class="field">Description<textarea name="description" rows={3} maxlength={1000}></textarea></label>
        <div class="grid">
          <label class="field">Starts (New York time)<input type="datetime-local" name="starts" required /></label>
          <label class="field">Length (minutes)<input type="number" name="minutes" min="15" max="480" value="60" required /></label>
        </div>
        <label class="field">Join link (Zoom)<input type="url" name="join_url" placeholder="https://us02web.zoom.us/j/…" /></label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Schedule</button>
      </form>
      <div class="table-box"><table class="t">
        <thead><tr><th scope="col">Webinar</th><th scope="col">When</th><th scope="col">Registered</th><th scope="col"></th></tr></thead>
        <tbody>
          {rows.map((w) => (
            <tr>
              <td>{w.title}{w.status === 'cancelled' && <> <span class="chip chip-gray">Cancelled</span></>}</td>
              <td class="small">{et(w.starts_at)}</td>
              <td>{w.registered} {w.registered > 0 && <a class="small" href={`/admin/webinars/${w.id}/attendees.csv`}>CSV</a>}</td>
              <td class="stack" style="gap:6px">
                <form method="post" action={`/admin/webinars/${w.id}/link`} class="row" style="gap:6px"><input type="url" name="join_url" value={w.join_url ?? ''} placeholder="Join link" aria-label="Join link" /><button class="btn btn-ghost btn-sm" type="submit">Save link</button></form>
                {w.status === 'scheduled' && <form method="post" action={`/admin/webinars/${w.id}/cancel`}><button class="btn btn-ghost btn-sm" type="submit">Cancel</button></form>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </PortalLayout>,
  );
});

/** A New York wall-clock time ("2026-11-12T19:00") as a UTC ISO string. */
export function nyToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const guess = Date.parse(local + ':00Z');
  if (!Number.isFinite(guess)) return null;
  // Offset of New York at that moment (handles daylight saving).
  const ny = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess + (utc.getTime() - ny.getTime())).toISOString();
}

webinarAdmin.post('/webinars', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const f = await c.req.parseBody();
  const title = String(f.title ?? '').trim().slice(0, 160);
  const starts = nyToIso(String(f.starts ?? ''));
  const minutes = Math.min(480, Math.max(15, Math.floor(Number(f.minutes) || 60)));
  const link = String(f.join_url ?? '').trim();
  if (!title || !starts) return c.redirect('/admin/webinars?error=' + encodeURIComponent('Enter a title and start time.'));
  if (link && !isHttpUrl(link)) return c.redirect('/admin/webinars?error=' + encodeURIComponent('The join link must start with https://'));
  await c.env.DB.prepare('INSERT INTO webinars (title, description, starts_at, duration_minutes, join_url, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(title, String(f.description ?? '').trim().slice(0, 1000) || null, starts, minutes, link || null, me.id)
    .run();
  return c.redirect('/admin/webinars?ok=1');
});

webinarAdmin.post('/webinars/:id{[0-9]+}/link', async (c) => {
  if (c.get('user')!.role !== 'admin') return c.text('Not found', 404);
  const link = String((await c.req.parseBody()).join_url ?? '').trim();
  if (link && !isHttpUrl(link)) return c.redirect('/admin/webinars?error=' + encodeURIComponent('The join link must start with https://'));
  await c.env.DB.prepare('UPDATE webinars SET join_url = ? WHERE id = ?').bind(link || null, Number(c.req.param('id'))).run();
  return c.redirect('/admin/webinars?ok=1');
});

webinarAdmin.post('/webinars/:id{[0-9]+}/cancel', async (c) => {
  if (c.get('user')!.role !== 'admin') return c.text('Not found', 404);
  await c.env.DB.prepare("UPDATE webinars SET status = 'cancelled' WHERE id = ?").bind(Number(c.req.param('id'))).run();
  return c.redirect('/admin/webinars?ok=1');
});

/** Attendee list for follow-up (admin only: it holds personal data). */
webinarAdmin.get('/webinars/:id{[0-9]+}/attendees.csv', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const id = Number(c.req.param('id'));
  const rows = (
    await c.env.DB.prepare(
      `SELECT u.first_name, u.last_name, u.email, u.phone, u.exam, u.grad_year, u.marketing_opt_in, r.registered_at
       FROM webinar_registrations r JOIN users u ON u.id = r.user_id WHERE r.webinar_id = ? ORDER BY r.registered_at`,
    )
      .bind(id)
      .all<any>()
  ).results;
  await audit(c.env.DB, { actorId: me.id, action: 'export.webinar_attendees', detail: { webinar: id, rows: rows.length }, ip: c.req.header('cf-connecting-ip') ?? null });
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="webinar-${id}-attendees.csv"`);
  c.header('Cache-Control', 'no-store');
  return c.body(
    toCsv([
      ['First name', 'Last name', 'Email', 'Phone', 'Exam', 'Graduation year', 'Marketing opt-in', 'Registered'],
      ...rows.map((r: any) => [r.first_name, r.last_name, r.email, r.phone, r.exam, r.grad_year, r.marketing_opt_in ? 'yes' : 'no', r.registered_at]),
    ]),
  );
});
