import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isAdmin } from '../lib/types';
import { requireAdminOrFacultyAllowed } from '../lib/auth';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { currentCohort, dayDate, defaultLecturesUntil, fmtDate, LECTURE_DAYS_AFTER_END, LETTERS, todayUtc, ymdToUtc, type Cohort } from '../lib/content';
import { parseCsv, toCsv, TEMPLATE_HEADERS } from '../lib/csv';
import { getSettings, isHttpUrl, SETTING_FIELDS } from '../lib/settings';
import { meetingIdList, syncImports } from '../lib/zoom';
import { allSessions, CLASSES_PER_MONTH, giveEveningMonths, GRACE_DAYS, subStatus, todayYmd } from '../lib/evening';

export const admin = new Hono<AppEnv>();
// Every admin route is admin-only unless faculty are explicitly allowed (see FACULTY_ALLOWED in lib/auth).
admin.use('*', requireAdminOrFacultyAllowed);

type Named = { id: number; name: string };
type Taxonomy = { subjects: Named[]; systems: (Named & { suggested_perf_system_id: number | null })[]; perf: Named[]; disc: Named[]; subjDisc: Map<number, number> };

async function taxonomy(db: D1Database): Promise<Taxonomy> {
  const [a, b, c, d, e] = await Promise.all([
    db.prepare('SELECT id, name FROM subjects ORDER BY sort').all<Named>(),
    db.prepare('SELECT id, name, suggested_perf_system_id FROM systems ORDER BY sort').all<Named & { suggested_perf_system_id: number | null }>(),
    db.prepare('SELECT id, name FROM perf_systems ORDER BY sort').all<Named>(),
    db.prepare('SELECT id, name FROM disciplines ORDER BY sort').all<Named>(),
    db.prepare('SELECT subject_id, discipline_id FROM subject_discipline_suggestions').all<{ subject_id: number; discipline_id: number }>(),
  ]);
  return { subjects: a.results, systems: b.results, perf: c.results, disc: d.results, subjDisc: new Map(e.results.map((r) => [r.subject_id, r.discipline_id])) };
}

// ---------- Cohorts and lectures ----------

admin.get('/lectures', async (c) => {
  const user = c.get('user')!;
  const cohort = await currentCohort(c.env.DB);
  const subjects = (await c.env.DB.prepare('SELECT id, name FROM subjects ORDER BY sort').all<Named>()).results;
  const lectures = cohort
    ? (await c.env.DB.prepare('SELECT * FROM lectures WHERE cohort_id = ? ORDER BY day_number').bind(cohort.id).all<any>()).results
    : [];
  const nextDay = (lectures.at(-1)?.day_number ?? 0) + 1;
  try {
    await syncImports(c.env);
  } catch (e) {
    console.error('sync imports', e);
  }
  const imports = (
    await c.env.DB.prepare('SELECT i.*, e.session_date AS evening_date FROM zoom_imports i LEFT JOIN evening_sessions e ON e.id = i.evening_session_id ORDER BY i.id DESC LIMIT 10').all<any>()
  ).results;
  const meetingIds = (await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'zoom_meeting_ids'").first<{ value: string }>())?.value ?? '';
  const webhookUrl = new URL('/zoom/webhook', c.env.SITE_URL || c.req.url).toString();
  const adminUser = isAdmin(user);
  return c.html(
    <PortalLayout title="Admin: lectures" active="admin-lectures" user={user}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Lectures</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {!cohort && !adminUser ? (
        <p class="muted">No cohort yet. An admin needs to create one.</p>
      ) : !cohort ? (
        <form method="post" action="/admin/cohorts" class="card">
          <h2>Start your first cohort</h2>
          <p class="muted">Classes run Monday to Friday. Days 1–90 are lectures and days 91–100 are the exam window, all on weekdays. Pick a Monday for Day 1.</p>
          <label class="field">Cohort name<input type="text" name="name" required placeholder="Winter 2026" /></label>
          <label class="field">Day 1 date<input type="date" name="start_date" required /></label>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Create cohort</button>
        </form>
      ) : (
        <>
          <p class="muted">{cohort.name} · Day 1 is {fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · last lecture (Day {cohort.lecture_days}) {fmtDate(dayDate(cohort, cohort.lecture_days), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · exam window ends {fmtDate(dayDate(cohort, cohort.total_days), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
          <section class="card" id="zoom">
            <h2>Automatic Zoom import</h2>
            <p class="muted small">When a class recording finishes in your Zoom cloud, it is copied to Bunny and attached to that day’s lecture. It goes live for students when Bunny has finished preparing it, usually 10–30 minutes later.</p>
            {adminUser && <>
            <ul class="small" style="margin:0;padding-left:18px">
              <li>Bunny connection: {c.env.BUNNY_API_KEY ? <strong>connected</strong> : <span class="chip chip-rust">add BUNNY_API_KEY in Cloudflare</span>}</li>
              <li>Zoom connection: {c.env.ZOOM_WEBHOOK_SECRET ? <strong>connected</strong> : <span class="chip chip-rust">add ZOOM_WEBHOOK_SECRET in Cloudflare</span>}</li>
              <li>Address for the Zoom app: <code style="word-break:break-all">{webhookUrl}</code></li>
            </ul>
            <form method="post" action="/admin/zoom-settings" class="row" style="align-items:flex-end">
              <label class="field" style="flex:1 1 260px">Lecture Zoom meeting ID (the 90 lectures)
                <input type="text" name="zoom_meeting_ids" value={meetingIds} placeholder="123 4567 8901" inputmode="numeric" />
              </label>
              <button class="btn btn-outline" type="submit">Save</button>
            </form>
            <p class="muted small">{meetingIdList(meetingIds).length ? 'Recordings of this meeting become that day’s lecture and go live on their own. Other meetings are ignored, except the Evening Questions meeting.' : 'Add your lecture meeting ID so lectures go live on their own.'} <a href="/admin/evening">Evening Questions meeting →</a></p>
            </>}
            {imports.length > 0 && (
              <div class="table-box">
                <table class="t">
                  <thead><tr><th scope="col">Recording</th><th scope="col">Status</th><th scope="col">Day</th></tr></thead>
                  <tbody>
                    {imports.map((i: any) => {
                      const lec = lectures.find((l: any) => l.id === i.lecture_id);
                      return (
                        <tr>
                          <td>{i.topic}<br /><span class="muted small">{i.start_time ? new Date(i.start_time).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span>{i.note && <><br /><span class="small">{i.note}</span></>}</td>
                          <td>{i.status === 'ready' ? <span class="chip">Ready</span> : i.status === 'failed' ? <span class="chip chip-rust">Failed</span> : <span class="chip chip-sand">{i.status === 'fetching' ? 'Copying from Zoom' : 'Bunny is preparing it'}</span>}</td>
                          <td>
                            {lec ? (
                              <>Day {lec.day_number}</>
                            ) : i.evening_date ? (
                              <>Evening · {fmtDate(new Date(i.evening_date + 'T00:00:00Z'))}</>
                            ) : i.status !== 'failed' ? (
                              <div class="stack" style="gap:6px">
                                <form method="post" action={`/admin/zoom-imports/${i.id}/assign`} class="row" style="gap:8px">
                                  <label class="field" style="max-width:110px">Use as Day
                                    <input type="number" name="day" min="1" max={String(cohort.lecture_days)} required />
                                  </label>
                                  <button class="btn btn-ghost" type="submit">Attach</button>
                                </form>
                                <form method="post" action={`/admin/zoom-imports/${i.id}/assign-evening`}>
                                  <button class="btn btn-ghost" type="submit">Use as evening class</button>
                                </form>
                              </div>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section class="card">
            <h2>Days off</h2>
            <p class="muted small">No class on these days. They are skipped like weekends, so later days move forward. Lectures already added keep their day number.</p>
            {cohort.daysOff?.size ? (
              <ul style="margin:0;padding:0;list-style:none" class="stack">
                {[...cohort.daysOff.entries()].sort((a, b) => a[0] - b[0]).map(([t, label]) => {
                  const ymd = new Date(t).toISOString().slice(0, 10);
                  return (
                    <li class="row between" style="border-top:1px solid var(--line-soft);padding-top:10px">
                      <span><strong>{fmtDate(new Date(t), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</strong> · {label}</span>
                      {adminUser && (
                        <form method="post" action="/admin/days-off/remove">
                          <input type="hidden" name="date" value={ymd} />
                          <button class="btn btn-ghost" type="submit">Remove</button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p class="muted">None yet.</p>
            )}
            {adminUser && <form method="post" action="/admin/days-off" class="row" style="align-items:flex-end">
              <label class="field" style="flex:1 1 160px">Date<input type="date" name="date" required /></label>
              <label class="field" style="flex:2 1 200px">Reason<input type="text" name="label" placeholder="Holiday" maxlength={60} /></label>
              <button class="btn btn-outline" type="submit">Add day off</button>
            </form>}
          </section>
          <form method="post" action="/admin/lectures" class="card">
            <h2>Add Day {nextDay} · {fmtDate(dayDate(cohort, nextDay))}</h2>
            <input type="hidden" name="day_number" value={String(nextDay)} />
            <div class="grid">
              <label class="field">Lecture title<input type="text" name="title" required placeholder="Microbiology Session 4" /></label>
              <label class="field">Subject
                <select name="subject_id"><option value="">Choose…</option>{subjects.map((s) => <option value={String(s.id)}>{s.name}</option>)}</select>
              </label>
              <label class="field">Zoom recording link<input type="url" name="zoom_url" placeholder="https://zoom.us/rec/share/…" /></label>
              <label class="field">Bunny video ID<input type="text" name="bunny_video_id" placeholder="Paste after uploading to Bunny" /></label>
            </div>
            <label class="check"><input type="checkbox" name="live" value="1" /> Show to students now (needs a Bunny video ID)</label>
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">Add as Day {nextDay}</button>
          </form>
          <div class="table-box">
            <table class="t">
              <thead><tr><th scope="col">Day</th><th scope="col">Date</th><th scope="col">Lecture</th><th scope="col">Status</th><th scope="col">Update</th></tr></thead>
              <tbody>
                {lectures.map((l: any) => (
                  <tr>
                    <td><strong>Day {l.day_number}</strong></td>
                    <td class="muted">{fmtDate(dayDate(cohort, l.day_number))}</td>
                    <td>{l.title}{l.zoom_url && <><br /><a class="small" href={l.zoom_url} rel="noopener">Zoom recording</a></>}</td>
                    <td>{l.status === 'live' ? <span class="chip">Live for students</span> : <span class="chip chip-gray">Not live</span>}</td>
                    <td>
                      <form method="post" action={`/admin/lectures/${l.id}`} class="row" style="gap:8px">
                        <input type="text" name="title" value={l.title} required aria-label={`Title for day ${l.day_number}`} style="max-width:220px" />
                        <input type="text" name="bunny_video_id" value={l.bunny_video_id ?? ''} placeholder="Bunny video ID" aria-label={`Bunny video ID for day ${l.day_number}`} style="max-width:220px" />
                        <label class="check"><input type="checkbox" name="live" value="1" checked={l.status === 'live'} /> Live</label>
                        <button class="btn btn-ghost" type="submit">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PortalLayout>,
  );
});

admin.post('/cohorts', async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? '').trim();
  const start = String(f.start_date ?? '');
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return c.redirect('/admin/lectures');
  await c.env.DB.prepare('INSERT INTO cohorts (name, start_date) VALUES (?, ?)').bind(name, start).run();
  return c.redirect('/admin/lectures?ok=1');
});

admin.post('/lectures', async (c) => {
  const f = await c.req.parseBody();
  const cohort = await currentCohort(c.env.DB);
  if (!cohort) return c.redirect('/admin/lectures');
  const vid = String(f.bunny_video_id ?? '').trim() || null;
  await c.env.DB.prepare('INSERT INTO lectures (cohort_id, day_number, title, zoom_url, bunny_video_id, subject_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(cohort.id, Number(f.day_number), String(f.title ?? '').trim(), String(f.zoom_url ?? '').trim() || null, vid, Number(f.subject_id) || null, f.live && vid ? 'live' : 'processing')
    .run();
  return c.redirect('/admin/lectures?ok=1');
});

admin.post('/lectures/:id', async (c) => {
  const f = await c.req.parseBody();
  const vid = String(f.bunny_video_id ?? '').trim() || null;
  const title = String(f.title ?? '').trim().slice(0, 160);
  await c.env.DB.prepare('UPDATE lectures SET bunny_video_id = ?, status = ?, title = COALESCE(NULLIF(?, \'\'), title) WHERE id = ?')
    .bind(vid, f.live && vid ? 'live' : 'processing', title, Number(c.req.param('id')))
    .run();
  return c.redirect('/admin/lectures?ok=1');
});

admin.post('/zoom-settings', async (c) => {
  const f = await c.req.parseBody();
  const ids = meetingIdList(String(f.zoom_meeting_ids ?? '')).join(', ');
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('zoom_meeting_ids', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(ids).run();
  return c.redirect('/admin/lectures?ok=1#zoom');
});

/** Attach an imported recording that had no day (e.g. recorded on a weekend) to a lecture day. */
admin.post('/zoom-imports/:id/assign', async (c) => {
  const db = c.env.DB;
  const cohort = await currentCohort(db);
  const f = await c.req.parseBody();
  const day = Number(f.day);
  const imp = await db.prepare('SELECT * FROM zoom_imports WHERE id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!cohort || !imp || !Number.isInteger(day) || day < 1 || day > cohort.lecture_days) return c.redirect('/admin/lectures');
  const ready = imp.status === 'ready' && imp.bunny_video_id;
  let lec = await db.prepare('SELECT id FROM lectures WHERE cohort_id = ? AND day_number = ?').bind(cohort.id, day).first<{ id: number }>();
  if (lec) {
    await db.prepare('UPDATE lectures SET bunny_video_id = ?, status = ? WHERE id = ?').bind(imp.bunny_video_id, ready ? 'live' : 'processing', lec.id).run();
  } else {
    const r = await db.prepare('INSERT INTO lectures (cohort_id, day_number, title, zoom_url, bunny_video_id, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(cohort.id, day, imp.topic || `Day ${day} lecture`, imp.share_url, imp.bunny_video_id, ready ? 'live' : 'processing').run();
    lec = { id: Number(r.meta.last_row_id) };
  }
  await db.prepare("UPDATE zoom_imports SET lecture_id = ?, evening_session_id = NULL, auto_live = 1, note = NULL, updated_at = datetime('now') WHERE id = ?").bind(lec.id, imp.id).run();
  return c.redirect('/admin/lectures?ok=1#zoom');
});

/** Attach an imported recording to the Evening Questions session of the day it was recorded. */
admin.post('/zoom-imports/:id/assign-evening', async (c) => {
  const db = c.env.DB;
  const imp = await db.prepare('SELECT * FROM zoom_imports WHERE id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!imp) return c.redirect('/admin/lectures');
  const date = new Date(todayUtc(new Date(imp.start_time || Date.now()))).toISOString().slice(0, 10);
  const ready = imp.status === 'ready' && imp.bunny_video_id;
  let ev = await db.prepare('SELECT id FROM evening_sessions WHERE session_date = ?').bind(date).first<{ id: number }>();
  if (ev) {
    await db.prepare("UPDATE evening_sessions SET bunny_video_id = ?, status = ?, live_at = CASE WHEN ?2 = 'live' THEN COALESCE(live_at, datetime('now')) END WHERE id = ?").bind(imp.bunny_video_id, ready ? 'live' : 'processing', ev.id).run();
  } else {
    const label = fmtDate(new Date(date + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' });
    const r = await db.prepare("INSERT INTO evening_sessions (session_date, title, zoom_url, bunny_video_id, status, live_at) VALUES (?, ?, ?, ?, ?5, CASE WHEN ?5 = 'live' THEN datetime('now') END)")
      .bind(date, `Evening Questions · ${label}`, imp.share_url, imp.bunny_video_id, ready ? 'live' : 'processing').run();
    ev = { id: Number(r.meta.last_row_id) };
  }
  await db.prepare("UPDATE zoom_imports SET evening_session_id = ?, lecture_id = NULL, auto_live = 1, note = NULL, updated_at = datetime('now') WHERE id = ?").bind(ev.id, imp.id).run();
  return c.redirect('/admin/evening?ok=1');
});

// ---------- Team (admin only): who is faculty or admin ----------

admin.get('/team', async (c) => {
  const me = c.get('user')!;
  const staff = (await c.env.DB.prepare("SELECT id, name, email, role, created_at FROM users WHERE role IN ('admin', 'faculty') ORDER BY role, name COLLATE NOCASE").all<any>()).results;
  return c.html(
    <PortalLayout title="Admin: team" active="admin-team" user={me}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Team</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">
        New accounts are always students. Only an admin can make someone faculty or admin here.{' '}
        <strong>Faculty</strong> can write and approve questions and manage lecture and Evening Questions recordings.{' '}
        <strong>Admins</strong> can also change prices, settings, the schedule, student access and this team.
      </p>
      <form method="post" action="/admin/team" class="card row" style="align-items:flex-end">
        <label class="field" style="flex:2 1 240px">Email of an existing account<input type="email" name="email" required /></label>
        <label class="field" style="flex:1 1 160px">Role
          <select name="role"><option value="faculty">Faculty</option><option value="admin">Admin</option><option value="student">Student (remove access)</option></select>
        </label>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Since</th></tr></thead>
          <tbody>
            {staff.map((u: any) => (
              <tr>
                <td>{u.name}{u.id === me.id && ' (you)'}<br /><span class="muted small">{u.email}</span></td>
                <td>{u.role === 'admin' ? <span class="chip">Admin</span> : <span class="chip chip-sand">Faculty</span>}</td>
                <td class="muted small">{String(u.created_at).slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PortalLayout>,
  );
});

admin.post('/team', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '').trim().toLowerCase();
  const role = String(f.role ?? '');
  const bad = (m: string) => c.redirect('/admin/team?error=' + encodeURIComponent(m));
  if (!['student', 'faculty', 'admin'].includes(role)) return bad('Pick a role.');
  const u = await c.env.DB.prepare('SELECT id, role FROM users WHERE email = ?').bind(email).first<{ id: number; role: string }>();
  if (!u) return bad(`No account uses ${email}. They need to create one first.`);
  if (u.role === 'admin' && role !== 'admin') {
    const admins = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>())?.n ?? 0;
    if (admins <= 1) return bad('There must always be at least one admin. Make someone else an admin first.');
  }
  // Only change the role if it is still what we read, so two admins acting at once cannot remove the last admin.
  await c.env.DB.prepare("UPDATE users SET role = ? WHERE id = ? AND role = ? AND (? = 'admin' OR role <> 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)")
    .bind(role, u.id, u.role, role).run();
  return c.redirect('/admin/team?ok=1');
});

// ---------- Students: lecture access ----------

admin.get('/students', async (c) => {
  const db = c.env.DB;
  const rows = (
    await db.prepare(
      `SELECT e.id, e.cohort_id, e.lectures_until, e.paid_at, u.name, u.email, p.name AS package_name
       FROM enrollments e JOIN users u ON u.id = e.user_id JOIN packages p ON p.id = e.package_id
       WHERE e.status = 'active' ORDER BY u.name COLLATE NOCASE`,
    ).all<any>()
  ).results;
  const cohorts = new Map<number, Cohort>();
  for (const id of new Set(rows.map((r: any) => r.cohort_id).filter(Boolean))) {
    const co = await currentCohort(db, id as number);
    if (co) cohorts.set(id as number, co);
  }
  const fallback = await currentCohort(db);
  const today = new Date(todayUtc()).toISOString().slice(0, 10);
  const long = (d: string) => fmtDate(new Date(d + 'T00:00:00Z'), { month: 'short', day: 'numeric', year: 'numeric' });
  return c.html(
    <PortalLayout title="Admin: students" active="admin-students" user={c.get('user')!}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Students</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      <p class="muted">Lecture recordings stay open until {LECTURE_DAYS_AFTER_END} days after a cohort’s last day (Day 100). To give one student more time, change their date and tap Save.</p>
      {!rows.length ? (
        <p class="muted">No paid students yet.</p>
      ) : (
        <div class="table-box">
          <table class="t">
            <thead><tr><th scope="col">Student</th><th scope="col">Program</th><th scope="col">Lectures until</th><th scope="col">Extend access</th></tr></thead>
            <tbody>
              {rows.map((r: any) => {
                const co = cohorts.get(r.cohort_id) ?? fallback;
                const def = co ? defaultLecturesUntil(co) : null;
                const until = r.lectures_until || def;
                return (
                  <tr>
                    <td>{r.name}<br /><span class="muted small">{r.email}</span></td>
                    <td>{r.package_name}<br /><span class="muted small">{co?.name ?? 'No cohort'}</span></td>
                    <td>
                      {until ? (until < today ? <span class="chip chip-gray">Ended {long(until)}</span> : long(until)) : '—'}
                      {r.lectures_until && <><br /><span class="chip chip-sand">Extended</span></>}
                    </td>
                    <td>
                      <form method="post" action={`/admin/students/${r.id}/lectures`} class="row" style="gap:8px">
                        <input type="date" name="until" value={until ?? ''} required aria-label={`Lectures until for ${r.name}`} style="max-width:170px" />
                        <button class="btn btn-outline" type="submit">Save</button>
                        {r.lectures_until && <button class="btn btn-ghost" type="submit" name="reset" value="1">Back to {def ? long(def) : 'default'}</button>}
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PortalLayout>,
  );
});

admin.post('/students/:id/lectures', async (c) => {
  const f = await c.req.parseBody();
  const until = String(f.until ?? '');
  let value = f.reset ? null : /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : undefined;
  if (value) {
    // Saving the cohort's normal date is the same as no extension.
    const e = await c.env.DB.prepare('SELECT cohort_id FROM enrollments WHERE id = ?').bind(Number(c.req.param('id'))).first<{ cohort_id: number | null }>();
    const co = await currentCohort(c.env.DB, e?.cohort_id);
    if (co && defaultLecturesUntil(co) === value) value = null;
  }
  if (value !== undefined) await c.env.DB.prepare('UPDATE enrollments SET lectures_until = ? WHERE id = ?').bind(value, Number(c.req.param('id'))).run();
  return c.redirect('/admin/students?ok=1');
});

// ---------- Evening Questions ----------

admin.get('/evening', async (c) => {
  const db = c.env.DB;
  const sessions = (await db.prepare('SELECT * FROM evening_sessions ORDER BY session_date DESC LIMIT 200').all<any>()).results;
  const today = todayYmd();
  // One row per student with months given by hand: where they are in their 12-class months.
  const allS = await allSessions(db);
  const grants = (
    await db.prepare('SELECT s.user_id, s.start_date, s.months, s.note, u.email, u.name FROM evening_subscriptions s JOIN users u ON u.id = s.user_id ORDER BY s.start_date DESC, s.id DESC').all<any>()
  ).results
    .filter((g: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.user_id === g.user_id) === i) // latest per student
    .map((g: any) => ({ ...g, st: subStatus({ start: g.start_date, months: g.months }, allS, today) }));
  const ids = (await db.prepare("SELECT value FROM settings WHERE key = 'zoom_evening_meeting_ids'").first<{ value: string }>())?.value ?? '';
  const adminUser = isAdmin(c.get('user'));
  return c.html(
    <PortalLayout title="Admin: Evening Questions" active="admin-evening" user={c.get('user')!}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Evening Questions</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      {adminUser && <>
      <section class="card">
        <h2>Zoom meeting</h2>
        <p class="muted small">Cloud recordings of this meeting are copied to Bunny and posted here by date, separate from the 90 lectures. They go live on their own.</p>
        <form method="post" action="/admin/evening/settings" class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 260px">Evening Questions Zoom meeting ID
            <input type="text" name="ids" value={ids} placeholder="844 8312 4634" inputmode="numeric" />
          </label>
          <button class="btn btn-outline" type="submit">Save</button>
        </form>
      </section>
      <section class="card">
        <h2>Who can watch</h2>
        <p class="muted small">One month = the next <strong>{CLASSES_PER_MONTH} evening classes</strong> from the start date. Students see only their month’s classes, and lose them <strong>{GRACE_DAYS} days after the 12th recording goes up</strong>. Another month for someone who still has one continues with the next {CLASSES_PER_MONTH} classes. Companion, Complete and MAX students get 4 months this way automatically.</p>
        <form method="post" action="/admin/evening/access" class="row" style="align-items:flex-end">
          <label class="field" style="flex:2 1 220px">Student email (they must have an account)<input type="email" name="email" required /></label>
          <label class="field" style="flex:1 1 150px">Starts<input type="date" name="start" required value={today} /></label>
          <label class="field" style="flex:0 1 110px">Months<input type="number" name="months" min="1" max="12" value="1" required /></label>
          <label class="field" style="flex:2 1 180px">Note (optional)<input type="text" name="note" maxlength={80} placeholder="Paid Nov by Zelle" /></label>
          <button class="btn btn-primary" type="submit">Give access</button>
        </form>
        {grants.length > 0 && (
          <div class="table-box">
            <table class="t">
              <thead><tr><th scope="col">Student</th><th scope="col">Current month</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
              <tbody>
                {grants.map((g: any) => (
                  <tr>
                    <td>{g.name}<br /><span class="muted small">{g.email}{g.note ? ` · ${g.note}` : ''}</span></td>
                    <td>
                      {(() => {
                        const short = (d: string) => fmtDate(new Date(d + 'T00:00:00Z'), { month: 'short', day: 'numeric' });
                        const cur = g.st.active.sort((x: any, y: any) => (x.start < y.start ? 1 : -1))[0];
                        if (g.st.pending) return <span class="chip chip-sand">Starts {short(g.start_date)}</span>;
                        if (cur)
                          return (
                            <>
                              Month {cur.month} of {g.months} · class {cur.sessions.length} of {CLASSES_PER_MONTH}
                              <br /><span class="muted small">{cur.end ? `Can watch until ${short(cur.end)}` : `Started ${short(cur.start)}`}</span>
                            </>
                          );
                        const last = g.st.blocks[g.st.blocks.length - 1];
                        return <span class="chip chip-gray">Ended{last?.end ? ` ${short(last.end)}` : ''}</span>;
                      })()}
                    </td>
                    <td class="row" style="gap:6px">
                      <form method="post" action="/admin/evening/access/extend">
                        <input type="hidden" name="user_id" value={String(g.user_id)} />
                        <button class="btn btn-outline" type="submit">+1 month</button>
                      </form>
                      <form method="post" action="/admin/evening/access/remove">
                        <input type="hidden" name="user_id" value={String(g.user_id)} />
                        <button class="btn btn-ghost" type="submit">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>}
      <form method="post" action="/admin/evening/sessions" class="card">
        <h2>Add a session by hand</h2>
        <p class="muted small">Only needed for recordings that did not come in from Zoom automatically.</p>
        <div class="grid">
          <label class="field">Date<input type="date" name="date" required /></label>
          <label class="field">Title<input type="text" name="title" placeholder="Evening Questions · Cardiology" /></label>
          <label class="field">Bunny video ID<input type="text" name="bunny_video_id" /></label>
        </div>
        <button class="btn btn-outline" type="submit" style="align-self:flex-start">Add session</button>
      </form>
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Update</th></tr></thead>
          <tbody>
            {sessions.map((e: any) => (
              <tr>
                <td><strong>{fmtDate(new Date(e.session_date + 'T00:00:00Z'), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</strong></td>
                <td>{e.status === 'live' ? <span class="chip">Live for students</span> : <span class="chip chip-gray">Not live</span>}</td>
                <td>
                  <form method="post" action={`/admin/evening/sessions/${e.id}`} class="row" style="gap:8px">
                    <input type="text" name="title" value={e.title} required aria-label="Title" style="max-width:240px" />
                    <input type="text" name="bunny_video_id" value={e.bunny_video_id ?? ''} placeholder="Bunny video ID" aria-label="Bunny video ID" style="max-width:200px" />
                    <label class="check"><input type="checkbox" name="live" value="1" checked={e.status === 'live'} /> Live</label>
                    <button class="btn btn-ghost" type="submit">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!sessions.length && <p class="muted">No evening recordings yet.</p>}
    </PortalLayout>,
  );
});

admin.post('/evening/settings', async (c) => {
  const f = await c.req.parseBody();
  const ids = meetingIdList(String(f.ids ?? '')).join(', ');
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('zoom_evening_meeting_ids', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(ids).run();
  return c.redirect('/admin/evening?ok=1');
});

admin.post('/evening/access', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '').trim().toLowerCase();
  const start = String(f.start ?? '');
  const months = Math.min(12, Math.max(1, Math.floor(Number(f.months) || 1)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return c.redirect('/admin/evening?error=' + encodeURIComponent('Pick a start date.'));
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?').bind(email).first<{ id: number }>();
  if (!u) return c.redirect('/admin/evening?error=' + encodeURIComponent(`No account uses ${email}. Ask them to create one first.`));
  await giveEveningMonths(c.env.DB, u.id, start, months, String(f.note ?? '').trim().slice(0, 80) || null);
  return c.redirect('/admin/evening?ok=1');
});

admin.post('/evening/access/extend', async (c) => {
  const f = await c.req.parseBody();
  await giveEveningMonths(c.env.DB, Number(f.user_id), todayYmd(), 1, null);
  return c.redirect('/admin/evening?ok=1');
});

admin.post('/evening/access/remove', async (c) => {
  const f = await c.req.parseBody();
  await c.env.DB.prepare('DELETE FROM evening_subscriptions WHERE user_id = ?').bind(Number(f.user_id)).run();
  return c.redirect('/admin/evening?ok=1');
});

admin.post('/evening/sessions', async (c) => {
  const f = await c.req.parseBody();
  const date = String(f.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/admin/evening');
  const vid = String(f.bunny_video_id ?? '').trim() || null;
  const title = String(f.title ?? '').trim().slice(0, 160) || `Evening Questions · ${fmtDate(new Date(date + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' })}`;
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO evening_sessions (session_date, title, bunny_video_id, status, live_at) VALUES (?, ?, ?, ?4, CASE WHEN ?4 = 'live' THEN datetime('now') END)").bind(date, title, vid, vid ? 'live' : 'processing').run();
  if (!r.meta.changes) return c.redirect('/admin/evening?error=' + encodeURIComponent('That date already has a session. Edit it in the list below.'));
  return c.redirect('/admin/evening?ok=1');
});

admin.post('/evening/sessions/:id', async (c) => {
  const f = await c.req.parseBody();
  const vid = String(f.bunny_video_id ?? '').trim() || null;
  const title = String(f.title ?? '').trim().slice(0, 160);
  await c.env.DB.prepare("UPDATE evening_sessions SET bunny_video_id = ?1, status = ?2, title = COALESCE(NULLIF(?3, ''), title), live_at = CASE WHEN ?2 = 'live' THEN COALESCE(live_at, datetime('now')) END WHERE id = ?4")
    .bind(vid, f.live && vid ? 'live' : 'processing', title, Number(c.req.param('id'))).run();
  return c.redirect('/admin/evening?ok=1');
});

// ---------- Questions ----------

admin.get('/questions', async (c) => {
  const user = c.get('user')!;
  const status = ['draft', 'approved', 'retired'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'draft';
  const counts = (await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM questions GROUP BY status').all<{ status: string; n: number }>()).results;
  const n = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;
  const rows = (
    await c.env.DB.prepare(
      `SELECT q.id, q.stem, s.name AS subject, y.name AS system, d.name AS discipline, p.name AS perf
       FROM questions q LEFT JOIN subjects s ON s.id = q.subject_id LEFT JOIN systems y ON y.id = q.system_id
       LEFT JOIN disciplines d ON d.id = q.discipline_id LEFT JOIN perf_systems p ON p.id = q.perf_system_id
       WHERE q.status = ? ORDER BY q.id LIMIT 200`,
    ).bind(status).all<any>()
  ).results;
  return c.html(
    <PortalLayout title="Admin: questions" active="admin-questions" user={user}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Questions</h1>
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      <div class="row">
        <a class="btn btn-primary" href="/admin/questions/new">Write a question</a>
        <a class="btn btn-outline" href="/admin/questions/import">Import a spreadsheet</a>
      </div>
      <nav class="row" aria-label="Filter by status">
        {['draft', 'approved', 'retired'].map((s) => (
          <a class={'btn ' + (s === status ? 'btn-primary' : 'btn-ghost')} href={`/admin/questions?status=${s}`}>{s === 'draft' ? 'To approve' : s[0].toUpperCase() + s.slice(1)} · {n(s)}</a>
        ))}
      </nav>
      <p class="muted small">Only approved questions reach students. Check every question’s tags before approving: the system and discipline decide where it counts on the Performance page.</p>
      {rows.length ? (
        <form method="post" action="/admin/questions/bulk" class="stack">
          <div class="table-box">
            <table class="t">
              <thead><tr><th scope="col"><span class="sr">Select</span></th><th scope="col">#</th><th scope="col">Question</th><th scope="col">Tags</th></tr></thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr>
                    <td><input type="checkbox" name="id" value={String(r.id)} aria-label={`Select question ${r.id}`} /></td>
                    <td><a href={`/admin/questions/${r.id}`}>{r.id}</a></td>
                    <td><a href={`/admin/questions/${r.id}`} style="color:inherit;text-decoration:none">{String(r.stem).slice(0, 140)}{String(r.stem).length > 140 ? '…' : ''}</a></td>
                    <td class="small">
                      {[r.subject, r.system].filter(Boolean).join(' · ') || <span class="chip chip-rust">Untagged</span>}
                      <br /><span class="muted">{[r.perf, r.discipline].filter(Boolean).join(' · ') || 'No reporting tags'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="row">
            {status !== 'approved' && <button class="btn btn-primary" name="action" value="approve" type="submit">Approve selected</button>}
            {status !== 'retired' && <button class="btn btn-ghost" name="action" value="retire" type="submit">Retire selected</button>}
            {status !== 'draft' && <button class="btn btn-ghost" name="action" value="draft" type="submit">Move back to drafts</button>}
          </div>
        </form>
      ) : (
        <p class="muted">No questions here yet.</p>
      )}
    </PortalLayout>,
  );
});

admin.post('/questions/bulk', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody({ all: true });
  const ids = (Array.isArray(f.id) ? f.id : f.id ? [f.id] : []).map(Number).filter(Number.isInteger);
  const action = String(f.action);
  const status = action === 'approve' ? 'approved' : action === 'retire' ? 'retired' : 'draft';
  if (ids.length) {
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare('UPDATE questions SET status = ?, approved_by = ? WHERE id = ?').bind(status, status === 'approved' ? user.id : null, id)));
  }
  return c.redirect(`/admin/questions?status=${status}&ok=` + encodeURIComponent(`${ids.length} question(s) updated.`));
});

function QuestionForm(props: { q?: any; tax: Taxonomy; action: string }) {
  const q = props.q ?? {};
  const choices: string[] = q.choices_json ? JSON.parse(q.choices_json) : [];
  const wrong: Record<string, string> = q.wrong_explanations_json ? JSON.parse(q.wrong_explanations_json) : {};
  const Sel = (p: { name: string; label: string; items: Named[]; value?: number | null }) => (
    <label class="field">{p.label}
      <select name={p.name}><option value="">Choose…</option>{p.items.map((i) => <option value={String(i.id)} selected={p.value === i.id}>{i.name}</option>)}</select>
    </label>
  );
  return (
    <form method="post" action={props.action} class="stack">
      <section class="card">
        <label class="field">Question stem<textarea name="stem" required rows={8}>{q.stem ?? ''}</textarea></label>
        {Array.from({ length: 8 }, (_, i) => (
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">
            <label class="field">Choice {LETTERS[i]}<input type="text" name={`choice_${i}`} value={choices[i] ?? ''} /></label>
            <label class="field">Why {LETTERS[i]} is wrong (optional)<input type="text" name={`wrong_${i}`} value={wrong[String(i)] ?? ''} /></label>
          </div>
        ))}
        <label class="field" style="max-width:200px">Correct answer
          <select name="correct" required>{Array.from({ length: 8 }, (_, i) => <option value={String(i)} selected={q.correct_index === i}>{LETTERS[i]}</option>)}</select>
        </label>
        <label class="field">Explanation<textarea name="explanation" required rows={8}>{q.explanation ?? ''}</textarea></label>
        <label class="field">Bottom line (optional)<textarea name="bottom_line" rows={3}>{q.bottom_line ?? ''}</textarea></label>
      </section>
      <section class="card">
        <h2>Tags</h2>
        <div class="grid">
          <Sel name="subject_id" label="Subject (test builder)" items={props.tax.subjects} value={q.subject_id} />
          <Sel name="system_id" label="System (test builder)" items={props.tax.systems} value={q.system_id} />
          <Sel name="perf_system_id" label="Performance system (reporting)" items={props.tax.perf} value={q.perf_system_id} />
          <Sel name="discipline_id" label="Discipline (reporting)" items={props.tax.disc} value={q.discipline_id} />
        </div>
        <p class="muted small">Leave the two reporting tags empty to use the suggested ones for that subject and system. Check them before approving.</p>
      </section>
      <div class="row">
        <button class="btn btn-primary" type="submit" name="status" value="draft">Save as draft</button>
        <button class="btn btn-outline" type="submit" name="status" value="approved">Save and approve</button>
      </div>
    </form>
  );
}

function readQuestionForm(f: Record<string, any>, tax: Taxonomy) {
  const choices: string[] = [];
  const wrong: Record<string, string> = {};
  for (let i = 0; i < 8; i++) {
    const ch = String(f[`choice_${i}`] ?? '').trim();
    if (ch) {
      choices.push(ch);
      const w = String(f[`wrong_${i}`] ?? '').trim();
      if (w) wrong[String(choices.length - 1)] = w;
    }
  }
  const correct = Number(f.correct);
  const subject = Number(f.subject_id) || null;
  const system = Number(f.system_id) || null;
  const perf = Number(f.perf_system_id) || (system ? tax.systems.find((s) => s.id === system)?.suggested_perf_system_id ?? null : null);
  const disc = Number(f.discipline_id) || (subject ? tax.subjDisc.get(subject) ?? null : null);
  const error = !String(f.stem ?? '').trim() ? 'The question needs a stem.' : choices.length < 2 ? 'Add at least two answer choices.' : !(correct >= 0 && correct < choices.length) ? 'The correct answer must be one of the filled-in choices.' : !String(f.explanation ?? '').trim() ? 'Add an explanation.' : null;
  return {
    error,
    values: [String(f.stem).trim(), JSON.stringify(choices), correct, String(f.explanation ?? '').trim(), Object.keys(wrong).length ? JSON.stringify(wrong) : null, String(f.bottom_line ?? '').trim() || null, subject, system, perf, disc],
  };
}

admin.get('/questions/new', async (c) => {
  const tax = await taxonomy(c.env.DB);
  return c.html(
    <PortalLayout title="Write a question" active="admin-questions" user={c.get('user')!}>
      <Eyebrow>Admin · Questions</Eyebrow>
      <h1>Write a question</h1>
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <QuestionForm tax={tax} action="/admin/questions/new" />
    </PortalLayout>,
  );
});

admin.post('/questions/new', async (c) => {
  const user = c.get('user')!;
  const tax = await taxonomy(c.env.DB);
  const f = await c.req.parseBody();
  const { error, values } = readQuestionForm(f, tax);
  if (error) return c.redirect('/admin/questions/new?error=' + encodeURIComponent(error));
  const status = f.status === 'approved' ? 'approved' : 'draft';
  await c.env.DB.prepare(
    `INSERT INTO questions (stem, choices_json, correct_index, explanation, wrong_explanations_json, bottom_line, subject_id, system_id, perf_system_id, discipline_id, status, author_id, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(...values, status, user.id, status === 'approved' ? user.id : null).run();
  return c.redirect(`/admin/questions?status=${status}&ok=` + encodeURIComponent('Question saved.'));
});

admin.get('/questions/template.csv', (c) => {
  const example = ['A 48-year-old man presents with …', 'Option one', 'Option two', 'Option three', 'Option four', 'Option five', '', '', '', 'C', 'The correct answer is C because …', 'One-sentence takeaway', 'Biochemistry', 'Nervous System', '', '', '3'];
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="usmle100-question-template.csv"');
  return c.body(toCsv([TEMPLATE_HEADERS, example]));
});

admin.get('/questions/import', async (c) => {
  const tax = await taxonomy(c.env.DB);
  return c.html(
    <PortalLayout title="Import questions" active="admin-questions" user={c.get('user')!}>
      <Eyebrow>Admin · Questions</Eyebrow>
      <h1>Import a spreadsheet</h1>
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card">
        <p>Fill in the template in Google Sheets or Excel, then download it as a CSV file and upload it here. Every imported question starts as a draft for faculty to check and approve.</p>
        <a class="btn btn-outline" href="/admin/questions/template.csv" style="align-self:flex-start">Download the template</a>
        <p class="muted small"><strong>correct</strong> is a letter (A–H). <strong>subject</strong> and <strong>system</strong> must match the names below exactly. <strong>discipline</strong> and <strong>perf_system</strong> are optional; blank means “use the suggestion”. <strong>lecture_day</strong> links the question to that day’s lecture.</p>
      </section>
      <form method="post" action="/admin/questions/import" enctype="multipart/form-data" class="card">
        <label class="field">CSV file<input type="file" name="file" accept=".csv,text/csv" required /></label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Check and import</button>
      </form>
      <details class="card">
        <summary><strong>Allowed names</strong></summary>
        <p class="small"><strong>Subjects:</strong> {tax.subjects.map((s) => s.name).join(' · ')}</p>
        <p class="small"><strong>Systems:</strong> {tax.systems.map((s) => s.name).join(' · ')}</p>
        <p class="small"><strong>Disciplines:</strong> {tax.disc.map((s) => s.name).join(' · ')}</p>
        <p class="small"><strong>Performance systems:</strong> {tax.perf.map((s) => s.name).join(' · ')}</p>
      </details>
    </PortalLayout>,
  );
});

admin.post('/questions/import', async (c) => {
  const user = c.get('user')!;
  const tax = await taxonomy(c.env.DB);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.redirect('/admin/questions/import?error=' + encodeURIComponent('Choose a CSV file.'));
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return c.redirect('/admin/questions/import?error=' + encodeURIComponent('The file has no question rows.'));
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  for (const req of ['stem', 'choice_a', 'choice_b', 'correct', 'explanation']) {
    if (col(req) < 0) return c.redirect('/admin/questions/import?error=' + encodeURIComponent(`Missing column “${req}”. Start from the template.`));
  }
  const find = (items: Named[], v: string) => (v ? items.find((i) => i.name.toLowerCase() === v.trim().toLowerCase()) ?? 'bad' : null);
  const cohort = await currentCohort(c.env.DB);
  const lectureIds = new Map<number, number>();
  if (cohort) for (const l of (await c.env.DB.prepare('SELECT id, day_number FROM lectures WHERE cohort_id = ?').bind(cohort.id).all<{ id: number; day_number: number }>()).results) lectureIds.set(l.day_number, l.id);

  const errors: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
    const choices = 'abcdefgh'.split('').map((l) => get(`choice_${l}`)).filter(Boolean);
    const correct = LETTERS.indexOf(get('correct').toUpperCase());
    const subj = find(tax.subjects, get('subject'));
    const sys = find(tax.systems, get('system')) as any;
    const disc = find(tax.disc, get('discipline'));
    const perf = find(tax.perf, get('perf_system'));
    const problems = [
      !get('stem') && 'no stem',
      choices.length < 2 && 'fewer than two choices',
      !(correct >= 0 && correct < choices.length) && 'correct answer is not one of the choices',
      !get('explanation') && 'no explanation',
      subj === 'bad' && `unknown subject “${get('subject')}”`,
      sys === 'bad' && `unknown system “${get('system')}”`,
      disc === 'bad' && `unknown discipline “${get('discipline')}”`,
      perf === 'bad' && `unknown performance system “${get('perf_system')}”`,
    ].filter(Boolean);
    if (problems.length) {
      errors.push(`Row ${line}: ${problems.join(', ')}`);
      return;
    }
    const subjectId = (subj as Named | null)?.id ?? null;
    const systemId = (sys as Named | null)?.id ?? null;
    const perfId = (perf as Named | null)?.id ?? (sys ? sys.suggested_perf_system_id : null);
    const discId = (disc as Named | null)?.id ?? (subjectId ? tax.subjDisc.get(subjectId) ?? null : null);
    const day = Number(get('lecture_day'));
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO questions (stem, choices_json, correct_index, explanation, bottom_line, subject_id, system_id, perf_system_id, discipline_id, lecture_id, status, author_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      ).bind(get('stem'), JSON.stringify(choices), correct, get('explanation'), get('bottom_line') || null, subjectId, systemId, perfId, discId, lectureIds.get(day) ?? null, user.id),
    );
  });
  if (errors.length) {
    return c.html(
      <PortalLayout title="Import questions" active="admin-questions" user={user}>
        <Eyebrow>Admin · Questions</Eyebrow>
        <h1>Nothing was imported</h1>
        <Flash kind="error">Fix these {errors.length} row(s) and upload the file again. No questions were saved.</Flash>
        <ul>{errors.slice(0, 100).map((e) => <li>{e}</li>)}</ul>
        <a class="btn btn-ghost" href="/admin/questions/import">Back</a>
      </PortalLayout>,
      400,
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return c.redirect('/admin/questions?status=draft&ok=' + encodeURIComponent(`${stmts.length} question(s) imported as drafts. Check the tags, then approve.`));
});

admin.get('/questions/:id{[0-9]+}', async (c) => {
  const tax = await taxonomy(c.env.DB);
  const q = await c.env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!q) return c.notFound();
  return c.html(
    <PortalLayout title={`Question ${q.id}`} active="admin-questions" user={c.get('user')!}>
      <Eyebrow>Admin · Question {q.id} · {q.status}</Eyebrow>
      <h1>Edit question</h1>
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <QuestionForm q={q} tax={tax} action={`/admin/questions/${q.id}`} />
    </PortalLayout>,
  );
});

admin.post('/questions/:id{[0-9]+}', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const tax = await taxonomy(c.env.DB);
  const f = await c.req.parseBody();
  const { error, values } = readQuestionForm(f, tax);
  if (error) return c.redirect(`/admin/questions/${id}?error=` + encodeURIComponent(error));
  const status = f.status === 'approved' ? 'approved' : 'draft';
  await c.env.DB.prepare(
    `UPDATE questions SET stem = ?, choices_json = ?, correct_index = ?, explanation = ?, wrong_explanations_json = ?, bottom_line = ?,
       subject_id = ?, system_id = ?, perf_system_id = ?, discipline_id = ?, status = ?, approved_by = ? WHERE id = ?`,
  ).bind(...values, status, status === 'approved' ? user.id : null, id).run();
  return c.redirect(`/admin/questions?status=${status}&ok=` + encodeURIComponent('Question saved.'));
});

// ---------- Site settings ----------

admin.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  const pkgs = (await c.env.DB.prepare('SELECT id, name, price_cents FROM packages ORDER BY sort').all<{ id: string; name: string; price_cents: number }>()).results;
  return c.html(
    <PortalLayout title="Site settings" active="admin-settings" user={c.get('user')!}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Site settings</h1>
      {c.req.query('ok') && <Flash>Saved. Changes show on the site straight away.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <form method="post" action="/admin/settings" class="stack">
        <section class="card">
          <h2>Details</h2>
          {SETTING_FIELDS.map((f) => (
            <label class="field">
              {f.label}
              <input type={f.type} name={f.key} value={settings[f.key]} />
              <span class="muted small" style="font-weight:500">{f.hint}</span>
            </label>
          ))}
        </section>
        <section class="card">
          <h2>Package prices</h2>
          <p class="muted small">One-time price in US dollars. New checkouts use the new price straight away; students who already paid are not affected.</p>
          {pkgs.map((p) => (
            <label class="field" style="max-width:320px">
              {p.name}
              <input type="number" name={`price_${p.id}`} min="1" step="1" value={String(Math.round(p.price_cents / 100))} required />
            </label>
          ))}
        </section>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save settings</button>
      </form>
    </PortalLayout>,
  );
});

admin.post('/settings', async (c) => {
  const f = await c.req.parseBody();
  const bad = (msg: string) => c.redirect('/admin/settings?error=' + encodeURIComponent(msg));
  const values: Record<string, string> = {};
  for (const field of SETTING_FIELDS) {
    const v = String(f[field.key] ?? '').trim().slice(0, 300);
    if (field.type === 'url' && v && !isHttpUrl(v)) return bad(`${field.label} must start with https://`);
    if (field.type === 'email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return bad('Enter a valid contact email.');
    values[field.key] = v;
  }
  const pkgs = (await c.env.DB.prepare('SELECT id FROM packages').all<{ id: string }>()).results;
  const prices: [string, number][] = [];
  for (const p of pkgs) {
    const dollars = Number(f[`price_${p.id}`]);
    if (!Number.isFinite(dollars) || dollars < 1 || dollars > 100000) return bad('Each price must be a whole number of dollars.');
    prices.push([p.id, Math.round(dollars) * 100]);
  }
  await c.env.DB.batch([
    ...Object.entries(values).map(([k, v]) =>
      c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(k, v),
    ),
    ...prices.map(([id, cents]) => c.env.DB.prepare('UPDATE packages SET price_cents = ? WHERE id = ?').bind(cents, id)),
  ]);
  return c.redirect('/admin/settings?ok=1');
});

// ---------- Days off ----------

admin.post('/days-off', async (c) => {
  const cohort = await currentCohort(c.env.DB);
  const f = await c.req.parseBody();
  const date = String(f.date ?? '');
  if (!cohort || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(ymdToUtc(date))) return c.redirect('/admin/lectures');
  await c.env.DB.prepare('INSERT INTO cohort_days_off (cohort_id, date, label) VALUES (?, ?, ?) ON CONFLICT (cohort_id, date) DO UPDATE SET label = excluded.label')
    .bind(cohort.id, date, String(f.label ?? '').trim().slice(0, 60) || 'Holiday')
    .run();
  return c.redirect('/admin/lectures?ok=1');
});

admin.post('/days-off/remove', async (c) => {
  const cohort = await currentCohort(c.env.DB);
  const f = await c.req.parseBody();
  if (cohort) await c.env.DB.prepare('DELETE FROM cohort_days_off WHERE cohort_id = ? AND date = ?').bind(cohort.id, String(f.date ?? '')).run();
  return c.redirect('/admin/lectures?ok=1');
});
