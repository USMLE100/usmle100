import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { requireStaff } from '../lib/auth';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { currentCohort, dayDate, fmtDate, LETTERS, ymdToUtc } from '../lib/content';
import { parseCsv, toCsv, TEMPLATE_HEADERS } from '../lib/csv';
import { getSettings, isHttpUrl, SETTING_FIELDS } from '../lib/settings';
import { meetingIdList, syncImports } from '../lib/zoom';

export const admin = new Hono<AppEnv>();
admin.use('*', requireStaff);

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
  const imports = (await c.env.DB.prepare('SELECT * FROM zoom_imports ORDER BY id DESC LIMIT 10').all<any>()).results;
  const meetingIds = (await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'zoom_meeting_ids'").first<{ value: string }>())?.value ?? '';
  const webhookUrl = new URL('/zoom/webhook', c.env.SITE_URL || c.req.url).toString();
  return c.html(
    <PortalLayout title="Admin: lectures" active="admin-lectures" user={user}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Lectures</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {!cohort ? (
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
            <ul class="small" style="margin:0;padding-left:18px">
              <li>Bunny connection: {c.env.BUNNY_API_KEY ? <strong>connected</strong> : <span class="chip chip-rust">add BUNNY_API_KEY in Cloudflare</span>}</li>
              <li>Zoom connection: {c.env.ZOOM_WEBHOOK_SECRET ? <strong>connected</strong> : <span class="chip chip-rust">add ZOOM_WEBHOOK_SECRET in Cloudflare</span>}</li>
              <li>Address for the Zoom app: <code style="word-break:break-all">{webhookUrl}</code></li>
            </ul>
            <form method="post" action="/admin/zoom-settings" class="row" style="align-items:flex-end">
              <label class="field" style="flex:1 1 260px">Class Zoom meeting ID(s)
                <input type="text" name="zoom_meeting_ids" value={meetingIds} placeholder="123 4567 8901" inputmode="numeric" />
              </label>
              <button class="btn btn-outline" type="submit">Save</button>
            </form>
            <p class="muted small">{meetingIdList(meetingIds).length ? 'Only recordings of these meetings are imported, and they go live on their own.' : 'Until you add your class meeting ID, every cloud recording is imported but waits for you to tick Live.'}</p>
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
                            ) : i.status !== 'failed' ? (
                              <form method="post" action={`/admin/zoom-imports/${i.id}/assign`} class="row" style="gap:8px">
                                <label class="field" style="max-width:110px">Use as Day
                                  <input type="number" name="day" min="1" max={String(cohort.lecture_days)} required />
                                </label>
                                <button class="btn btn-ghost" type="submit">Attach</button>
                              </form>
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
                      <form method="post" action="/admin/days-off/remove">
                        <input type="hidden" name="date" value={ymd} />
                        <button class="btn btn-ghost" type="submit">Remove</button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p class="muted">None yet.</p>
            )}
            <form method="post" action="/admin/days-off" class="row" style="align-items:flex-end">
              <label class="field" style="flex:1 1 160px">Date<input type="date" name="date" required /></label>
              <label class="field" style="flex:2 1 200px">Reason<input type="text" name="label" placeholder="Holiday" maxlength={60} /></label>
              <button class="btn btn-outline" type="submit">Add day off</button>
            </form>
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
  await db.prepare("UPDATE zoom_imports SET lecture_id = ?, auto_live = 1, note = NULL, updated_at = datetime('now') WHERE id = ?").bind(lec.id, imp.id).run();
  return c.redirect('/admin/lectures?ok=1#zoom');
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
