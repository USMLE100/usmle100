import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner } from '../lib/types';
import { requireAdminOrFacultyAllowed } from '../lib/auth';
import { audit } from '../lib/audit';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { CATEGORY } from './play';
import type { FreeRow } from '../lib/viewing';

/**
 * Admin → Free lectures: the owner's hand-picked list. Each entry points at a course lecture, an Evening Questions
 * class or another Bunny video, and is never deleted (unpublishing keeps students' view counts, R043).
 * Admins may add and edit drafts; only the owner publishes or unpublishes (OWNER_ONLY in lib/auth), so nothing
 * becomes free without the owner's explicit choice.
 */
export const freeAdmin = new Hono<AppEnv>();
freeAdmin.use('*', requireAdminOrFacultyAllowed);

const ip = (c: any) => c.req.header('cf-connecting-ip') ?? null;
const back = (msg: string, error = false) => `/admin/free-lectures?${error ? 'error' : 'ok'}=${encodeURIComponent(msg)}`;

freeAdmin.get('/free-lectures', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const [rows, lectures, evenings, stats] = await Promise.all([
    db.prepare('SELECT * FROM free_videos ORDER BY published DESC, sort, id').all<FreeRow>(),
    db.prepare("SELECT l.id, l.day_number, l.title, l.status, l.bunny_video_id, c.name AS cohort FROM lectures l JOIN cohorts c ON c.id = l.cohort_id ORDER BY c.start_date DESC, l.day_number").all<any>(),
    db.prepare('SELECT id, session_date, title, status, bunny_video_id FROM evening_sessions ORDER BY session_date DESC LIMIT 200').all<any>(),
    db.prepare("SELECT item, COUNT(DISTINCT user_id) AS viewers, SUM(counted) AS views FROM view_sessions WHERE kind = 'free' GROUP BY item").all<{ item: string; viewers: number; views: number }>(),
  ]);
  const byItem = new Map(stats.results.map((s) => [s.item, s]));
  const freeSources = new Map(rows.results.map((r) => [r.source, r]));
  const sourceLabel = (src: string) => {
    if (src.startsWith('L:')) {
      const l = lectures.results.find((x: any) => x.id === Number(src.slice(2)));
      return l ? `Course lecture · ${l.cohort} · Day ${l.day_number}` : 'Course lecture (removed)';
    }
    if (src.startsWith('E:')) {
      const e = evenings.results.find((x: any) => x.id === Number(src.slice(2)));
      return e ? `Evening class · ${e.session_date}` : 'Evening class';
    }
    return `Bunny video ${src.slice(2)}`;
  };
  const owner = isOwner(me);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: free lectures" active="admin-free" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Free lectures</h1>
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">
        Videos any signed-in student can watch before enrolling (2 views each), after giving their phone, exam and graduation year. Adding a video here never changes the
        original lecture, and paid lectures never become free on their own. Entries start unpublished; only the owner publishes them.
      </p>

      <section class="card stack">
        <h2 style="margin:0">Your list</h2>
        {rows.results.length === 0 ? (
          <p class="muted" style="margin:0">Nothing yet. Add a video below.</p>
        ) : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Video</th><th scope="col">Status</th><th scope="col">Students</th><th scope="col"></th></tr></thead>
            <tbody>
              {rows.results.map((f) => {
                const st = byItem.get(`F:${f.id}`);
                return (
                  <tr>
                    <td>
                      <form method="post" action={`/admin/free-lectures/${f.id}`} class="stack" style="gap:6px">
                        <input type="text" name="title" value={f.title} required maxlength={160} aria-label="Title" />
                        <input type="text" name="description" value={f.description ?? ''} maxlength={300} placeholder="Short description (optional)" aria-label="Description" />
                        <div class="row" style="gap:6px">
                          <select name="category" aria-label="Type">{Object.entries(CATEGORY).map(([k, v]) => <option value={k} selected={f.category === k}>{v}</option>)}</select>
                          <input type="number" name="sort" value={String(f.sort)} min="0" max="999" style="width:80px" aria-label="Order" />
                          <button class="btn btn-outline btn-sm" type="submit">Save</button>
                        </div>
                        <span class="muted small">{sourceLabel(f.source)}</span>
                      </form>
                    </td>
                    <td>{f.published ? <span class="chip">Published</span> : <span class="chip chip-gray">Not published</span>}</td>
                    <td class="small">{st ? `${st.viewers} watching · ${st.views ?? 0} views used` : '—'}</td>
                    <td class="stack" style="gap:6px">
                      {owner ? (
                        <form method="post" action={`/admin/free-lectures/${f.id}/publish`}>
                          <input type="hidden" name="on" value={f.published ? '0' : '1'} />
                          <button class={'btn btn-sm ' + (f.published ? 'btn-outline' : 'btn-primary')} type="submit">{f.published ? 'Unpublish' : 'Publish'}</button>
                        </form>
                      ) : (
                        <span class="muted small">Only the owner publishes.</span>
                      )}
                      <a class="btn btn-ghost btn-sm" href={`/free-lectures/${f.id}`}>Preview</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Add a video</h2>
        <form method="post" action="/admin/free-lectures" class="stack" style="gap:12px">
          <label class="field">Course lecture
            <select name="lecture"><option value="">—</option>{lectures.results.map((l: any) => <option value={String(l.id)} disabled={freeSources.has(`L:${l.id}`)}>{l.cohort} · Day {l.day_number}: {l.title}{l.bunny_video_id ? '' : ' (no video yet)'}</option>)}</select>
          </label>
          <label class="field">or an Evening Questions class
            <select name="evening"><option value="">—</option>{evenings.results.map((e: any) => <option value={String(e.id)} disabled={freeSources.has(`E:${e.id}`)}>{e.session_date}: {e.title}{e.bunny_video_id ? '' : ' (no video yet)'}</option>)}</select>
          </label>
          <label class="field">or another video already in Bunny (its video ID, e.g. an information video about USMLE100)
            <input type="text" name="bunny" maxlength={64} pattern="[A-Za-z0-9-]+" placeholder="e.g. 0b1c2d3e-…" />
          </label>
          <div class="grid">
            <label class="field">Title shown to students<input type="text" name="title" maxlength={160} placeholder="Leave empty to use the lecture's title" /></label>
            <label class="field">Type<select name="category">{Object.entries(CATEGORY).map(([k, v]) => <option value={k}>{v}</option>)}</select></label>
          </div>
          <label class="field">Length in minutes (Bunny videos only)<input type="number" name="minutes" min="1" max="600" style="max-width:160px" /></label>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Add (unpublished)</button>
        </form>
      </section>

      <section class="card stack">
        <h2 style="margin:0">Who can watch what</h2>
        <p class="muted small" style="margin:0">Every course lecture: Paid = enrolled students of that cohort only (5 views each); Free = also in the published list above; Not live = no student can play it.</p>
        <div class="table-box"><table class="t">
          <thead><tr><th scope="col">Lecture</th><th scope="col">Access</th></tr></thead>
          <tbody>
            {lectures.results.slice(0, 300).map((l: any) => {
              const f = freeSources.get(`L:${l.id}`);
              return (
                <tr>
                  <td class="small">{l.cohort} · Day {l.day_number}: {l.title}</td>
                  <td class="small">{l.status !== 'live' ? 'Not live' : f?.published ? 'Paid + Free' : 'Paid'}{!l.bunny_video_id && ' · no video'}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>
    </PortalLayout>,
  );
});

freeAdmin.post('/free-lectures', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const lec = Number(f.lecture) || 0, eve = Number(f.evening) || 0;
  const bunny = String(f.bunny ?? '').trim();
  const picked = [lec ? 1 : 0, eve ? 1 : 0, bunny ? 1 : 0].reduce((a, b) => a + b, 0);
  if (picked !== 1) return c.redirect(back('Choose exactly one video: a course lecture, an Evening class or a Bunny video ID.', true));
  if (bunny && !/^[A-Za-z0-9-]{6,64}$/.test(bunny)) return c.redirect(back('That doesn’t look like a Bunny video ID.', true));
  let source = '', title = String(f.title ?? '').trim().slice(0, 160);
  if (lec) {
    const l = await db.prepare('SELECT title FROM lectures WHERE id = ?').bind(lec).first<{ title: string }>();
    if (!l) return c.redirect(back('Lecture not found.', true));
    source = `L:${lec}`;
    title ||= l.title;
  } else if (eve) {
    const e = await db.prepare('SELECT title FROM evening_sessions WHERE id = ?').bind(eve).first<{ title: string }>();
    if (!e) return c.redirect(back('Evening class not found.', true));
    source = `E:${eve}`;
    title ||= e.title;
  } else {
    source = `V:${bunny}`;
    if (!title) return c.redirect(back('Give the video a title.', true));
  }
  const category = Object.keys(CATEGORY).includes(String(f.category)) ? String(f.category) : 'educational';
  const minutes = Number(f.minutes);
  const r = await db
    .prepare('INSERT INTO free_videos (source, title, category, duration_seconds, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (source) DO NOTHING')
    .bind(source, title, category, bunny && minutes > 0 ? Math.round(minutes * 60) : null, me.id)
    .run();
  if (!r.meta.changes) return c.redirect(back('That video is already in the list. Publish it from there.', true));
  await audit(db, { actorId: me.id, action: 'free.added', detail: { source, title }, ip: ip(c) });
  return c.redirect(back('Added. It stays unpublished until the owner publishes it.'));
});

freeAdmin.post('/free-lectures/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const f = await c.req.parseBody();
  const title = String(f.title ?? '').trim().slice(0, 160);
  if (!title) return c.redirect(back('Enter a title.', true));
  const category = Object.keys(CATEGORY).includes(String(f.category)) ? String(f.category) : 'educational';
  await c.env.DB.prepare('UPDATE free_videos SET title = ?, description = ?, category = ?, sort = ? WHERE id = ?')
    .bind(title, String(f.description ?? '').trim().slice(0, 300) || null, category, Math.max(0, Math.min(999, Math.floor(Number(f.sort) || 0))), Number(c.req.param('id')))
    .run();
  return c.redirect(back('Saved.'));
});

/** Owner only (OWNER_ONLY). Unpublishing takes free access away at once (R042); view counts are kept (R043). */
freeAdmin.post('/free-lectures/:id{[0-9]+}/publish', async (c) => {
  const me = c.get('user')!;
  const id = Number(c.req.param('id'));
  const on = (await c.req.parseBody()).on === '1';
  await c.env.DB.prepare("UPDATE free_videos SET published = ?, published_at = CASE WHEN ? THEN datetime('now') ELSE published_at END WHERE id = ?").bind(on ? 1 : 0, on ? 1 : 0, id).run();
  await audit(c.env.DB, { actorId: me.id, action: on ? 'free.published' : 'free.unpublished', detail: { id }, ip: ip(c) });
  return c.redirect(back(on ? 'Published: students can watch it now.' : 'Unpublished: free access ended.'));
});
