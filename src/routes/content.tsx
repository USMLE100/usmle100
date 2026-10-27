import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isAdmin } from '../lib/types';
import { PortalLayout, PageHead, Flash } from '../views/layout';
import { Icon } from '../views/icons';
import { currentCohort, fmtDate } from '../lib/content';
import { clock } from '../lib/catalog';
import { deleteFile, MB, readUpload, saveFile, sniff, fmtSize } from '../lib/files';
import { BOOK_PACKAGES } from '../lib/book';

/**
 * Admin screens for Phase 2 content. Mounted at /admin after the main admin router, so its access rule applies:
 * admin-only unless listed in FACULTY_ALLOWED (lib/auth). Faculty may manage sections, lecture details and flash cards.
 */
export const content = new Hono<AppEnv>();

type Named = { id: number; name: string };
type Sec = { id: number; subject_id: number | null; title: string; sort: number; lectures: number };
const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const back = (path: string, msg?: string, err = false) => path + (msg ? `${path.includes('?') ? '&' : '?'}${err ? 'error' : 'ok'}=${encodeURIComponent(msg)}` : '');

async function subjectsAndSections(db: D1Database) {
  const [s, sec] = await Promise.all([
    db.prepare('SELECT id, name FROM subjects ORDER BY sort').all<Named>(),
    db.prepare('SELECT s.id, s.subject_id, s.title, s.sort, (SELECT COUNT(*) FROM lectures l WHERE l.section_id = s.id) AS lectures FROM sections s ORDER BY s.sort, s.id').all<Sec>(),
  ]);
  return { subjects: s.results, sections: sec.results };
}

const SectionSelect = (p: { sections: Sec[]; subjects: Named[]; value: number | null; name?: string }) => (
  <select name={p.name ?? 'section_id'}>
    <option value="">No section</option>
    {p.subjects.map((s) => {
      const list = p.sections.filter((x) => x.subject_id === s.id);
      return list.length ? <optgroup label={s.name}>{list.map((x) => <option value={String(x.id)} selected={p.value === x.id}>{x.title}</option>)}</optgroup> : null;
    })}
    {p.sections.some((x) => !x.subject_id) && <optgroup label="No subject">{p.sections.filter((x) => !x.subject_id).map((x) => <option value={String(x.id)} selected={p.value === x.id}>{x.title}</option>)}</optgroup>}
  </select>
);
const SubjectSelect = (p: { subjects: Named[]; value: number | null; required?: boolean }) => (
  <select name="subject_id" required={p.required}>
    <option value="">{p.required ? 'Choose…' : 'No subject'}</option>
    {p.subjects.map((s) => <option value={String(s.id)} selected={p.value === s.id}>{s.name}</option>)}
  </select>
);
const Msgs = (p: { ok?: string; error?: string }) => <>{p.ok && <Flash>{p.ok}</Flash>}{p.error && <Flash kind="error">{p.error}</Flash>}</>;

// ---------- Sections (topics) ----------

content.get('/sections', async (c) => {
  const { subjects, sections } = await subjectsAndSections(c.env.DB);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: sections" active="admin-sections" user={c.get('user')!}>
      <PageHead eyebrow="Admin" title="Topics & sections" sub="Group each subject’s lectures into sections. Students see them in Lectures, Path, Workbench and Topics. Put a lecture in a section from its Details page in Admin → Lectures." />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <form method="post" action="/admin/sections" class="card">
        <h2>Add a section</h2>
        <div class="grid">
          <label class="field">Subject<SubjectSelect subjects={subjects} value={null} required /></label>
          <label class="field">Section title<input type="text" name="title" required maxlength={120} placeholder="Diagnostic Test Performance" /></label>
        </div>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start"><Icon name="add" size={18} />Add section</button>
      </form>
      {subjects.filter((s) => sections.some((x) => x.subject_id === s.id)).map((s) => (
        <section class="card">
          <h2>{s.name}</h2>
          {sections.filter((x) => x.subject_id === s.id).map((x) => (
            <div class="admin-row">
              <form method="post" action={`/admin/sections/${x.id}`} class="row" style="gap:8px;flex:1">
                <input type="number" name="sort" value={String(x.sort)} aria-label={`Order of ${x.title}`} style="width:76px" />
                <input type="text" name="title" value={x.title} required maxlength={120} aria-label="Section title" style="flex:1 1 200px" />
                <span class="muted small">{x.lectures} lecture{x.lectures === 1 ? '' : 's'}</span>
                <button class="btn btn-ghost btn-sm" type="submit">Save</button>
              </form>
              <form method="post" action={`/admin/sections/${x.id}/delete`}>
                <button class="icon-btn" type="submit" aria-label={`Delete section ${x.title}`} title="Delete (lectures stay, without a section)"><Icon name="delete" size={20} /></button>
              </form>
            </div>
          ))}
        </section>
      ))}
      {!sections.length && <p class="muted">No sections yet.</p>}
    </PortalLayout>,
  );
});

content.post('/sections', async (c) => {
  const f = await c.req.parseBody();
  const title = str(f.title, 120);
  const subject = num(f.subject_id);
  if (!title || !subject) return c.redirect(back('/admin/sections', 'Choose a subject and enter a title.', true));
  const top = (await c.env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM sections WHERE subject_id = ?').bind(subject).first<{ s: number }>())?.s ?? 0;
  await c.env.DB.prepare('INSERT INTO sections (subject_id, title, sort) VALUES (?, ?, ?)').bind(subject, title, top + 1).run();
  return c.redirect(back('/admin/sections', 'Section added.'));
});

content.post('/sections/:id{[0-9]+}', async (c) => {
  const f = await c.req.parseBody();
  const title = str(f.title, 120);
  if (title) await c.env.DB.prepare('UPDATE sections SET title = ?, sort = ? WHERE id = ?').bind(title, Number(f.sort) || 0, Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/sections', 'Saved.'));
});

content.post('/sections/:id{[0-9]+}/delete', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE lectures SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('UPDATE flashcards SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('UPDATE book_chapters SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('UPDATE notes SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('UPDATE threads SET section_id = NULL WHERE section_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sections WHERE id = ?').bind(id),
  ]);
  return c.redirect(back('/admin/sections', 'Section deleted. Its lectures are still there, without a section.'));
});

// ---------- Lecture details ----------

content.get('/lectures/:id{[0-9]+}', async (c) => {
  const l = await c.env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!l) return c.notFound();
  const { subjects, sections } = await subjectsAndSections(c.env.DB);
  const qs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE lecture_id = ? AND status = 'approved'").bind(l.id).first<{ n: number }>();
  const cards = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM flashcards WHERE lecture_id = ? AND status = 'live'").bind(l.id).first<{ n: number }>();
  return c.html(
    <PortalLayout shell={c.get('shell')} title={`Admin: Day ${l.day_number}`} active="admin-lectures" user={c.get('user')!}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/admin/lectures">Lectures admin</a><Icon name="chevron_right" size={16} />Day {l.day_number}</nav>
      <PageHead eyebrow={`Day ${l.day_number}`} title={l.title} />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <form method="post" action={`/admin/lectures/${l.id}/details`} class="card">
        <label class="field">Title<input type="text" name="title" value={l.title} required maxlength={160} /></label>
        <div class="grid">
          <label class="field">Subject<SubjectSelect subjects={subjects} value={l.subject_id} /></label>
          <label class="field">Section<SectionSelect sections={sections} subjects={subjects} value={l.section_id} /></label>
        </div>
        <label class="field">
          Learning objectives
          <textarea name="objectives" rows={5} maxlength={3000} placeholder={'Explain sensitivity and specificity and apply it to a question stem.\nRecognise when sensitivity and specificity is being tested.'}>{l.objectives ?? ''}</textarea>
          <span class="muted small" style="font-weight:500">One per line. Shown as “By the end of this lecture you should be able to…”.</span>
        </label>
        <label class="field" style="max-width:280px">
          Length in minutes
          <input type="number" name="minutes" min="0" max="600" value={l.duration_seconds ? String(Math.round(l.duration_seconds / 60)) : ''} placeholder="From Bunny" />
          <span class="muted small" style="font-weight:500">{l.duration_seconds ? `Now ${clock(l.duration_seconds)}.` : 'Filled in from Bunny automatically once the video is ready.'} Leave empty to use Bunny’s length.</span>
        </label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save details</button>
      </form>
      {c.get('user')!.role === 'admin' && (
        <form method="post" action={`/admin/lectures/${l.id}/free`} class="card stack" style="gap:10px">
          <h2 style="margin:0;font-size:18px">Free preview</h2>
          <p class="muted small" style="margin:0">
            {l.is_free
              ? 'This lecture is a free preview: any signed-in student can watch it 2 times at /free-lectures.'
              : 'Make this lecture a free preview so any signed-in student can watch it 2 times, before enrolling.'}{' '}
            Removing it takes free access away at once; students who have it in their program keep their paid views. View counts are kept if you add it back.
          </p>
          <input type="hidden" name="free" value={l.is_free ? '0' : '1'} />
          <button class={'btn ' + (l.is_free ? 'btn-outline' : 'btn-primary')} type="submit" style="align-self:flex-start">{l.is_free ? 'Remove from free lectures' : 'Make it a free lecture'}</button>
        </form>
      )}
      <section class="card">
        <p class="small">{qs?.n ?? 0} approved question{qs?.n === 1 ? '' : 's'} and {cards?.n ?? 0} flash card{cards?.n === 1 ? '' : 's'} are linked to this lecture. <a href={`/admin/cards?lecture=${l.id}`}>Flash cards →</a></p>
      </section>
    </PortalLayout>,
  );
});

content.post('/lectures/:id{[0-9]+}/details', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const title = str(f.title, 160);
  const minutes = Number(f.minutes);
  if (!title) return c.redirect(back(`/admin/lectures/${id}`, 'Enter a title.', true));
  await c.env.DB.prepare('UPDATE lectures SET title = ?, subject_id = ?, section_id = ?, objectives = ?, duration_seconds = ? WHERE id = ?')
    .bind(title, num(f.subject_id), num(f.section_id), str(f.objectives, 3000) || null, minutes > 0 ? Math.round(minutes * 60) : null, id)
    .run();
  return c.redirect(back(`/admin/lectures/${id}`, 'Saved.'));
});

/** Admins choose the free preview lectures (R041); removal revokes free access immediately (R042). */
content.post('/lectures/:id{[0-9]+}/free', async (c) => {
  const id = Number(c.req.param('id'));
  const on = (await c.req.parseBody()).free === '1';
  await c.env.DB.prepare('UPDATE lectures SET is_free = ? WHERE id = ?').bind(on ? 1 : 0, id).run();
  return c.redirect(back(`/admin/lectures/${id}`, on ? 'It is now a free lecture.' : 'Removed from free lectures.'));
});

// ---------- Flash cards ----------

type CardRow = { id: number; front: string; back: string; subject_id: number | null; section_id: number | null; lecture_id: number | null; status: string; lecture: string | null; day: number | null; section: string | null };

async function lectureOptions(db: D1Database) {
  const cohort = await currentCohort(db);
  return cohort ? (await db.prepare('SELECT id, day_number, title FROM lectures WHERE cohort_id = ? ORDER BY day_number').bind(cohort.id).all<{ id: number; day_number: number; title: string }>()).results : [];
}
const LectureSelect = (p: { lectures: { id: number; day_number: number; title: string }[]; value: number | null }) => (
  <select name="lecture_id">
    <option value="">No lecture (open to everyone)</option>
    {p.lectures.map((l) => <option value={String(l.id)} selected={p.value === l.id}>Day {l.day_number} · {l.title}</option>)}
  </select>
);

content.get('/cards', async (c) => {
  const db = c.env.DB;
  const lecture = num(c.req.query('lecture'));
  const section = num(c.req.query('section'));
  const show = c.req.query('show') === 'retired' ? 'retired' : 'live';
  const [{ subjects, sections }, lectures, rows] = await Promise.all([
    subjectsAndSections(db),
    lectureOptions(db),
    db
      .prepare(
        `SELECT f.*, l.title AS lecture, l.day_number AS day, s.title AS section FROM flashcards f
         LEFT JOIN lectures l ON l.id = f.lecture_id LEFT JOIN sections s ON s.id = f.section_id
         WHERE f.status = ? AND (? IS NULL OR f.lecture_id = ?) AND (? IS NULL OR f.section_id = ?) ORDER BY f.id DESC LIMIT 300`,
      )
      .bind(show, lecture, lecture, section, section)
      .all<CardRow>(),
  ]);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: flash cards" active="admin-cards" user={c.get('user')!} wide>
      <PageHead eyebrow="Admin" title="Flash cards" sub="Cards are written by faculty. A card linked to a lecture reaches each student after they watch that lecture; cards with no lecture are open to everyone." />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <form method="post" action="/admin/cards" class="card">
        <h2>Write a card</h2>
        <label class="field">Front (question)<textarea name="front" rows={2} required maxlength={500}></textarea></label>
        <label class="field">Back (answer)<textarea name="back" rows={3} required maxlength={1500}></textarea></label>
        <div class="grid">
          <label class="field">Lecture<LectureSelect lectures={lectures} value={lecture} /></label>
          <label class="field">Section<SectionSelect sections={sections} subjects={subjects} value={section} /></label>
          <label class="field">Subject<SubjectSelect subjects={subjects} value={null} /></label>
        </div>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start"><Icon name="add" size={18} />Add card</button>
      </form>
      <details class="card">
        <summary class="row between" style="cursor:pointer"><h2>Add many at once</h2><Icon name="down" /></summary>
        <form method="post" action="/admin/cards/bulk" class="stack">
          <p class="muted small">One card per line: the front, then <code>|</code>, then the back. For example <code>What does a true positive mean? | The person has the disease and tested positive.</code></p>
          <label class="field">Cards<textarea name="lines" rows={8} required maxlength={100000}></textarea></label>
          <div class="grid">
            <label class="field">Lecture<LectureSelect lectures={lectures} value={lecture} /></label>
            <label class="field">Section<SectionSelect sections={sections} subjects={subjects} value={section} /></label>
            <label class="field">Subject<SubjectSelect subjects={subjects} value={null} /></label>
          </div>
          <button class="btn btn-outline" type="submit" style="align-self:flex-start">Add all</button>
        </form>
      </details>
      <div class="row">
        <a class={'btn btn-sm ' + (show === 'live' ? 'btn-primary' : 'btn-outline')} href="/admin/cards">Live</a>
        <a class={'btn btn-sm ' + (show === 'retired' ? 'btn-primary' : 'btn-outline')} href="/admin/cards?show=retired">Retired</a>
        {(lecture || section) && <a class="btn btn-ghost btn-sm" href="/admin/cards">Show all</a>}
      </div>
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Front</th><th scope="col">Back</th><th scope="col">From</th><th scope="col"></th></tr></thead>
          <tbody>
            {rows.results.map((r) => (
              <tr>
                <td>{r.front}</td>
                <td class="muted">{r.back}</td>
                <td class="small">{r.day ? `Day ${r.day}` : ''}{r.section ? `${r.day ? ' · ' : ''}${r.section}` : ''}</td>
                <td><a class="btn btn-ghost btn-sm" href={`/admin/cards/${r.id}`}>Edit</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.results.length && <p class="muted">No cards here yet.</p>}
    </PortalLayout>,
  );
});

async function cardFields(f: Record<string, unknown>, db: D1Database) {
  let lecture = num(f.lecture_id);
  let section = num(f.section_id);
  let subject = num(f.subject_id);
  // A card linked to a lecture takes its section and subject unless they were chosen.
  if (lecture) {
    const l = await db.prepare('SELECT section_id, subject_id FROM lectures WHERE id = ?').bind(lecture).first<{ section_id: number | null; subject_id: number | null }>();
    if (!l) lecture = null;
    else {
      section ??= l.section_id;
      subject ??= l.subject_id;
    }
  }
  if (section && !subject) subject = (await db.prepare('SELECT subject_id FROM sections WHERE id = ?').bind(section).first<{ subject_id: number | null }>())?.subject_id ?? null;
  return { lecture, section, subject };
}

content.post('/cards', async (c) => {
  const f = await c.req.parseBody();
  const front = str(f.front, 500);
  const backText = str(f.back, 1500);
  if (!front || !backText) return c.redirect(back('/admin/cards', 'Write both sides of the card.', true));
  const k = await cardFields(f, c.env.DB);
  await c.env.DB.prepare('INSERT INTO flashcards (front, back, subject_id, section_id, lecture_id, author_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(front, backText, k.subject, k.section, k.lecture, c.get('user')!.id)
    .run();
  return c.redirect(back(`/admin/cards${k.lecture ? `?lecture=${k.lecture}` : ''}`, 'Card added.'));
});

content.post('/cards/bulk', async (c) => {
  const f = await c.req.parseBody();
  const k = await cardFields(f, c.env.DB);
  const lines = String(f.lines ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const cards = lines.map((l) => l.split('|')).filter((p) => p.length >= 2 && p[0].trim() && p.slice(1).join('|').trim());
  if (!cards.length) return c.redirect(back('/admin/cards', 'No cards found. Put “ | ” between the front and the back.', true));
  if (cards.length > 500) return c.redirect(back('/admin/cards', 'Add at most 500 cards at a time.', true));
  const uid = c.get('user')!.id;
  await c.env.DB.batch(
    cards.map((p) =>
      c.env.DB.prepare('INSERT INTO flashcards (front, back, subject_id, section_id, lecture_id, author_id) VALUES (?, ?, ?, ?, ?, ?)').bind(
        p[0].trim().slice(0, 500), p.slice(1).join('|').trim().slice(0, 1500), k.subject, k.section, k.lecture, uid,
      ),
    ),
  );
  const skipped = lines.length - cards.length;
  return c.redirect(back('/admin/cards', `${cards.length} card${cards.length === 1 ? '' : 's'} added.${skipped ? ` ${skipped} line${skipped === 1 ? '' : 's'} skipped (no “|”).` : ''}`));
});

content.get('/cards/:id{[0-9]+}', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM flashcards WHERE id = ?').bind(Number(c.req.param('id'))).first<CardRow>();
  if (!r) return c.notFound();
  const [{ subjects, sections }, lectures] = await Promise.all([subjectsAndSections(c.env.DB), lectureOptions(c.env.DB)]);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: edit card" active="admin-cards" user={c.get('user')!}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/admin/cards">Flash cards</a><Icon name="chevron_right" size={16} />Card {r.id}</nav>
      <PageHead title="Edit card" />
      <form method="post" action={`/admin/cards/${r.id}`} class="card">
        <label class="field">Front<textarea name="front" rows={2} required maxlength={500}>{r.front}</textarea></label>
        <label class="field">Back<textarea name="back" rows={3} required maxlength={1500}>{r.back}</textarea></label>
        <div class="grid">
          <label class="field">Lecture<LectureSelect lectures={lectures} value={r.lecture_id} /></label>
          <label class="field">Section<SectionSelect sections={sections} subjects={subjects} value={r.section_id} /></label>
          <label class="field">Subject<SubjectSelect subjects={subjects} value={r.subject_id} /></label>
        </div>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save card</button>
      </form>
      <form method="post" action={`/admin/cards/${r.id}/status`}>
        <input type="hidden" name="status" value={r.status === 'live' ? 'retired' : 'live'} />
        <button class="btn btn-outline" type="submit">{r.status === 'live' ? 'Retire this card (students stop seeing it)' : 'Make this card live again'}</button>
      </form>
    </PortalLayout>,
  );
});

content.post('/cards/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const front = str(f.front, 500);
  const backText = str(f.back, 1500);
  if (!front || !backText) return c.redirect(`/admin/cards/${id}`);
  const k = await cardFields(f, c.env.DB);
  await c.env.DB.prepare('UPDATE flashcards SET front = ?, back = ?, subject_id = ?, section_id = ?, lecture_id = ? WHERE id = ?').bind(front, backText, k.subject, k.section, k.lecture, id).run();
  return c.redirect(back('/admin/cards', 'Card saved.'));
});

content.post('/cards/:id{[0-9]+}/status', async (c) => {
  const f = await c.req.parseBody();
  const status = f.status === 'retired' ? 'retired' : 'live';
  await c.env.DB.prepare('UPDATE flashcards SET status = ? WHERE id = ?').bind(status, Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/cards', status === 'retired' ? 'Card retired.' : 'Card is live again.'));
});

// ---------- Course Book (admin only) ----------

const BOOK_MAX = 40 * MB;

content.get('/book', async (c) => {
  const db = c.env.DB;
  const [rows, grants] = await Promise.all([
    db.prepare('SELECT c.*, s.name AS subject, f.name AS file_name, f.size AS file_size FROM book_chapters c LEFT JOIN subjects s ON s.id = c.subject_id LEFT JOIN files f ON f.id = c.file_id ORDER BY c.number, c.id').all<any>(),
    db.prepare('SELECT a.user_id, a.note, a.created_at, u.name, u.email FROM book_access a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC').all<any>(),
  ]);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: Course Book" active="admin-book" user={c.get('user')!} wide>
      <PageHead eyebrow="Admin" title="USMLE100 Course Book" sub="Chapters with their PDF handouts. Companion, Complete and MAX students get the book. Give it to anyone else (the $199 Course Book on its own) below." />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <a class="btn btn-primary" href="/admin/book/new" style="align-self:flex-start"><Icon name="upload" size={18} />Add a chapter</a>
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Chapter</th><th scope="col">PDF</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
          <tbody>
            {rows.results.map((r: any) => (
              <tr>
                <td><strong>{r.number}. {r.title}</strong><br /><span class="muted small">{r.subject ?? 'No subject'}{r.pages ? ` · ${r.pages} pages` : ''}</span></td>
                <td class="small">{r.file_name ? <>{r.file_name}<br /><span class="muted">{fmtSize(r.file_size)}</span></> : <span class="chip chip-rust">No PDF</span>}</td>
                <td>{r.status === 'live' ? <span class="chip">Live</span> : <span class="chip chip-gray">Draft</span>}</td>
                <td><a class="btn btn-ghost btn-sm" href={`/admin/book/${r.id}`}>Edit</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.results.length && <p class="muted">No chapters yet.</p>}
      <section class="card">
        <h2>Give the Course Book to a student</h2>
        <p class="muted small">For students who bought the Course Book on its own. Students on {BOOK_PACKAGES.join(', ')} already have it.</p>
        <form method="post" action="/admin/book-access" class="row" style="align-items:flex-end">
          <label class="field" style="flex:2 1 220px">Student email (they must have an account)<input type="email" name="email" required /></label>
          <label class="field" style="flex:1 1 160px">Note (optional)<input type="text" name="note" maxlength={120} placeholder="Paid by Zelle" /></label>
          <button class="btn btn-primary" type="submit">Give access</button>
        </form>
        {grants.results.length > 0 && (
          <ul class="plain-list">
            {grants.results.map((g: any) => (
              <li class="row between">
                <span><strong>{g.name}</strong> <span class="muted small">{g.email}{g.note ? ` · ${g.note}` : ''}</span></span>
                <form method="post" action="/admin/book-access/remove"><input type="hidden" name="user_id" value={String(g.user_id)} /><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalLayout>,
  );
});

async function chapterForm(c: any, ch: any | null) {
  const { subjects, sections } = await subjectsAndSections(c.env.DB);
  const next = ch ? ch.number : ((await c.env.DB.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM book_chapters').first()) as { n: number }).n + 1;
  return c.html(
    <PortalLayout shell={c.get('shell')} title={ch ? 'Admin: edit chapter' : 'Admin: new chapter'} active="admin-book" user={c.get('user')!}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/admin/book">Course Book</a><Icon name="chevron_right" size={16} />{ch ? `Chapter ${ch.number}` : 'New chapter'}</nav>
      <PageHead title={ch ? ch.title : 'Add a chapter'} />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <form method="post" action={ch ? `/admin/book/${ch.id}` : '/admin/book'} enctype="multipart/form-data" class="card">
        <div class="grid">
          <label class="field" style="max-width:160px">Chapter number<input type="number" name="number" min="1" max="999" required value={String(next)} /></label>
          <label class="field">Title<input type="text" name="title" required maxlength={200} value={ch?.title ?? ''} /></label>
        </div>
        <div class="grid">
          <label class="field">Subject<SubjectSelect subjects={subjects} value={ch?.subject_id ?? null} /></label>
          <label class="field">Section (optional)<SectionSelect sections={sections} subjects={subjects} value={ch?.section_id ?? null} /></label>
          <label class="field">Author<input type="text" name="author" maxlength={120} value={ch?.author ?? ''} placeholder="Dr. Haider Khan, MD" /></label>
          <label class="field">Pages<input type="number" name="pages" min="1" max="5000" value={ch?.pages ? String(ch.pages) : ''} /></label>
        </div>
        <label class="field">Short description (on the library card)<textarea name="description" rows={3} maxlength={800}>{ch?.description ?? ''}</textarea></label>
        <label class="field">Chapter summary<textarea name="summary" rows={4} maxlength={3000}>{ch?.summary ?? ''}</textarea></label>
        <label class="field">Topics covered<textarea name="topics" rows={4} maxlength={2000} placeholder={'Sensitivity & Specificity\nPPV & NPV'}>{ch?.topics ?? ''}</textarea><span class="muted small" style="font-weight:500">One per line.</span></label>
        <label class="field">{ch?.file_id ? 'Replace the PDF' : 'PDF'}<input type="file" name="pdf" accept="application/pdf,.pdf" /><span class="muted small" style="font-weight:500">PDF only, up to {BOOK_MAX / MB} MB.{ch?.file_name ? ` Now: ${ch.file_name}.` : ''}</span></label>
        <label class="check"><input type="checkbox" name="live" value="1" checked={ch?.status === 'live'} /> Show to students</label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">{ch ? 'Save chapter' : 'Add chapter'}</button>
      </form>
      {ch && (
        <form method="post" action={`/admin/book/${ch.id}/delete`}>
          <button class="btn btn-ghost" type="submit"><Icon name="delete" size={18} />Delete this chapter and its PDF</button>
        </form>
      )}
    </PortalLayout>,
  );
}

content.get('/book/new', (c) => chapterForm(c, null));
content.get('/book/:id{[0-9]+}', async (c) => {
  const ch = await c.env.DB.prepare('SELECT c.*, f.name AS file_name FROM book_chapters c LEFT JOIN files f ON f.id = c.file_id WHERE c.id = ?').bind(Number(c.req.param('id'))).first();
  return ch ? chapterForm(c, ch) : c.notFound();
});

async function saveChapter(c: any, id: number | null) {
  const f = await c.req.parseBody();
  const db: D1Database = c.env.DB;
  const here = id ? `/admin/book/${id}` : '/admin/book/new';
  const title = str(f.title, 200);
  if (!title) return c.redirect(back(here, 'Enter a title.', true));
  const up = await readUpload(f.pdf, BOOK_MAX);
  if (up && 'error' in up) return c.redirect(back(here, up.error, true));
  let fileId: number | null = null;
  if (up) {
    if (sniff(up.data.subarray(0, 16), up.name, 'pdf') !== 'application/pdf') return c.redirect(back(here, 'That file is not a PDF.', true));
    fileId = await saveFile(db, c.get('user')!.id, up.name, 'application/pdf', up.data);
  }
  const vals = [Number(f.number) || 1, title, num(f.subject_id), num(f.section_id), str(f.description, 800) || null, str(f.summary, 3000) || null, str(f.topics, 2000) || null, str(f.author, 120) || null, num(f.pages)];
  if (id) {
    const old = await db.prepare('SELECT file_id FROM book_chapters WHERE id = ?').bind(id).first<{ file_id: number | null }>();
    const keep = fileId ?? old?.file_id ?? null;
    await db.prepare('UPDATE book_chapters SET number = ?, title = ?, subject_id = ?, section_id = ?, description = ?, summary = ?, topics = ?, author = ?, pages = ?, file_id = ?, status = ? WHERE id = ?')
      .bind(...vals, keep, f.live && keep ? 'live' : 'draft', id)
      .run();
    if (fileId && old?.file_id) await deleteFile(db, old.file_id);
  } else {
    const r = await db.prepare('INSERT INTO book_chapters (number, title, subject_id, section_id, description, summary, topics, author, pages, file_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(...vals, fileId, f.live && fileId ? 'live' : 'draft')
      .run();
    id = Number(r.meta.last_row_id);
  }
  const live = (await db.prepare('SELECT status FROM book_chapters WHERE id = ?').bind(id).first<{ status: string }>())?.status === 'live';
  return c.redirect(back(`/admin/book/${id}`, f.live && !live ? 'Saved as a draft: add a PDF before showing it to students.' : 'Saved.', !!(f.live && !live)));
}

content.post('/book', (c) => saveChapter(c, null));
content.post('/book/:id{[0-9]+}', (c) => saveChapter(c, Number(c.req.param('id'))));
content.post('/book/:id{[0-9]+}/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const ch = await c.env.DB.prepare('SELECT file_id FROM book_chapters WHERE id = ?').bind(id).first<{ file_id: number | null }>();
  await c.env.DB.prepare('DELETE FROM book_chapters WHERE id = ?').bind(id).run();
  await deleteFile(c.env.DB, ch?.file_id);
  return c.redirect(back('/admin/book', 'Chapter deleted.'));
});

content.post('/book-access', async (c) => {
  const f = await c.req.parseBody();
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(str(f.email).toLowerCase()).first<{ id: number }>();
  if (!u) return c.redirect(back('/admin/book', 'No account with that email. Ask the student to create one first.', true));
  await c.env.DB.prepare('INSERT INTO book_access (user_id, note, granted_by) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET note = excluded.note')
    .bind(u.id, str(f.note, 120) || null, c.get('user')!.id)
    .run();
  return c.redirect(back('/admin/book', 'Course Book given.'));
});

content.post('/book-access/remove', async (c) => {
  const f = await c.req.parseBody();
  await c.env.DB.prepare('DELETE FROM book_access WHERE user_id = ?').bind(Number(f.user_id)).run();
  return c.redirect(back('/admin/book', 'Access removed.'));
});

// ---------- One-on-one sessions held (admin only) ----------

content.get('/tutoring', async (c) => {
  const rows = (
    await c.env.DB.prepare(
      `SELECT t.*, u.name, u.email,
         (SELECT p.one_on_one_sessions FROM enrollments e JOIN packages p ON p.id = e.package_id WHERE e.user_id = t.user_id AND e.status = 'active' ORDER BY e.paid_at DESC LIMIT 1) AS included,
         (SELECT COUNT(*) FROM tutoring_sessions x WHERE x.user_id = t.user_id) AS used
       FROM tutoring_sessions t JOIN users u ON u.id = t.user_id ORDER BY t.held_on DESC, t.id DESC LIMIT 200`,
    ).all<any>()
  ).results;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: tutoring sessions" active="admin-tutoring" user={c.get('user')!}>
      <PageHead eyebrow="Admin" title="One-on-one sessions" sub="Record each session after it happens. Students see how many they have used, and it counts toward their milestones." />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <form method="post" action="/admin/tutoring" class="card">
        <div class="grid">
          <label class="field">Student email<input type="email" name="email" required /></label>
          <label class="field">Date<input type="date" name="held_on" required value={new Date().toISOString().slice(0, 10)} /></label>
          <label class="field">Minutes<input type="number" name="minutes" min="15" max="240" value="60" /></label>
        </div>
        <label class="field">Note (optional, staff only)<input type="text" name="note" maxlength={200} placeholder="Cardio physiology, NBME 27 review" /></label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Record session</button>
      </form>
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Date</th><th scope="col">Student</th><th scope="col">Used</th><th scope="col"></th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr>
                <td>{fmtDate(new Date(r.held_on + 'T00:00:00Z'), { month: 'short', day: 'numeric', year: 'numeric' })}<br /><span class="muted small">{r.minutes} min</span></td>
                <td>{r.name}<br /><span class="muted small">{r.email}{r.note ? ` · ${r.note}` : ''}</span></td>
                <td>{r.used}{r.included ? ` of ${r.included}` : ''}</td>
                <td><form method="post" action={`/admin/tutoring/${r.id}/delete`}><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p class="muted">No sessions recorded yet.</p>}
    </PortalLayout>,
  );
});

content.post('/tutoring', async (c) => {
  const f = await c.req.parseBody();
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(str(f.email).toLowerCase()).first<{ id: number }>();
  const date = str(f.held_on, 10);
  if (!u) return c.redirect(back('/admin/tutoring', 'No account with that email.', true));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect(back('/admin/tutoring', 'Choose a date.', true));
  const minutes = Math.max(15, Math.min(240, Number(f.minutes) || 60));
  await c.env.DB.prepare('INSERT INTO tutoring_sessions (user_id, held_on, minutes, note, created_by) VALUES (?, ?, ?, ?, ?)').bind(u.id, date, minutes, str(f.note, 200) || null, c.get('user')!.id).run();
  return c.redirect(back('/admin/tutoring', 'Session recorded.'));
});

content.post('/tutoring/:id{[0-9]+}/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM tutoring_sessions WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/tutoring', 'Removed.'));
});

// ---------- Home page: Study Strategy articles and FAQ (admin only) ----------

content.get('/home-content', async (c) => {
  const [arts, faqs] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM articles ORDER BY sort, id').all<any>(),
    c.env.DB.prepare('SELECT * FROM faqs ORDER BY sort, id').all<any>(),
  ]);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: home page" active="admin-home" user={c.get('user')!}>
      <PageHead eyebrow="Admin" title="Home page content" sub="Study Strategy articles and the FAQ on every student’s home page. Only live items are shown." />
      <Msgs ok={c.req.query('ok')} error={c.req.query('error')} />
      <h2 class="section-title">Study Strategy articles</h2>
      {arts.results.map((a: any) => <ArticleForm a={a} />)}
      <details class="card"><summary class="row between" style="cursor:pointer"><h2>Write an article</h2><Icon name="add" /></summary><ArticleForm a={null} /></details>
      <h2 class="section-title">FAQ</h2>
      {faqs.results.map((q: any) => (
        <form method="post" action={`/admin/faq/${q.id}`} class="card">
          <div class="grid" style="grid-template-columns:90px 1fr">
            <label class="field">Order<input type="number" name="sort" value={String(q.sort)} /></label>
            <label class="field">Question<input type="text" name="question" value={q.question} required maxlength={200} /></label>
          </div>
          <label class="field">Answer<textarea name="answer" rows={3} required maxlength={2000}>{q.answer}</textarea></label>
          <div class="row">
            <label class="check"><input type="checkbox" name="live" value="1" checked={q.status === 'live'} /> Live</label>
            <button class="btn btn-ghost btn-sm" type="submit">Save</button>
            <button class="btn btn-ghost btn-sm" type="submit" formaction={`/admin/faq/${q.id}/delete`}>Delete</button>
          </div>
        </form>
      ))}
      <form method="post" action="/admin/faq" class="card">
        <h2>Add a question</h2>
        <label class="field">Question<input type="text" name="question" required maxlength={200} /></label>
        <label class="field">Answer<textarea name="answer" rows={3} required maxlength={2000}></textarea></label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">Add</button>
      </form>
    </PortalLayout>,
  );
});

const ArticleForm = (p: { a: any | null }) => (
  <form method="post" action={p.a ? `/admin/articles/${p.a.id}` : '/admin/articles'} class={p.a ? 'card' : 'stack'}>
    <div class="grid">
      <label class="field">Label<input type="text" name="kicker" maxlength={60} value={p.a?.kicker ?? ''} placeholder="Study strategy" /></label>
      <label class="field">Author<input type="text" name="author" maxlength={120} value={p.a?.author ?? ''} placeholder="Dr. Haider Khan, MD" /></label>
      <label class="field">Order<input type="number" name="sort" value={String(p.a?.sort ?? 0)} /></label>
    </div>
    <label class="field">Title<input type="text" name="title" required maxlength={200} value={p.a?.title ?? ''} /></label>
    <label class="field">Summary (on the home page)<textarea name="summary" rows={2} maxlength={400}>{p.a?.summary ?? ''}</textarea></label>
    <label class="field">Article<textarea name="body" rows={8} maxlength={20000}>{p.a?.body ?? ''}</textarea><span class="muted small" style="font-weight:500">Blank lines start a new paragraph.</span></label>
    <div class="row">
      <label class="check"><input type="checkbox" name="live" value="1" checked={p.a?.status === 'live'} /> Live</label>
      <button class="btn btn-primary btn-sm" type="submit">{p.a ? 'Save' : 'Add article'}</button>
      {p.a && <button class="btn btn-ghost btn-sm" type="submit" formaction={`/admin/articles/${p.a.id}/delete`}>Delete</button>}
    </div>
  </form>
);

const articleVals = (f: Record<string, unknown>) => [str(f.kicker, 60) || null, str(f.title, 200), str(f.summary, 400) || null, str(f.body, 20000) || null, str(f.author, 120) || null, f.live ? 'live' : 'draft', Number(f.sort) || 0];

content.post('/articles', async (c) => {
  const v = articleVals(await c.req.parseBody());
  if (!v[1]) return c.redirect(back('/admin/home-content', 'Enter a title.', true));
  await c.env.DB.prepare('INSERT INTO articles (kicker, title, summary, body, author, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...v).run();
  return c.redirect(back('/admin/home-content', 'Article added.'));
});
content.post('/articles/:id{[0-9]+}', async (c) => {
  const v = articleVals(await c.req.parseBody());
  if (!v[1]) return c.redirect(back('/admin/home-content', 'Enter a title.', true));
  await c.env.DB.prepare('UPDATE articles SET kicker = ?, title = ?, summary = ?, body = ?, author = ?, status = ?, sort = ? WHERE id = ?').bind(...v, Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/home-content', 'Saved.'));
});
content.post('/articles/:id{[0-9]+}/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/home-content', 'Deleted.'));
});

content.post('/faq', async (c) => {
  const f = await c.req.parseBody();
  const q = str(f.question, 200);
  const a = str(f.answer, 2000);
  if (!q || !a) return c.redirect(back('/admin/home-content', 'Enter a question and an answer.', true));
  const top = (await c.env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM faqs').first<{ s: number }>())?.s ?? 0;
  await c.env.DB.prepare('INSERT INTO faqs (question, answer, sort) VALUES (?, ?, ?)').bind(q, a, top + 1).run();
  return c.redirect(back('/admin/home-content', 'Question added.'));
});
content.post('/faq/:id{[0-9]+}', async (c) => {
  const f = await c.req.parseBody();
  const q = str(f.question, 200);
  const a = str(f.answer, 2000);
  if (q && a) await c.env.DB.prepare('UPDATE faqs SET question = ?, answer = ?, sort = ?, status = ? WHERE id = ?').bind(q, a, Number(f.sort) || 0, f.live ? 'live' : 'draft', Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/home-content', 'Saved.'));
});
content.post('/faq/:id{[0-9]+}/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM faqs WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect(back('/admin/home-content', 'Deleted.'));
});

export const isAdminUser = isAdmin;
