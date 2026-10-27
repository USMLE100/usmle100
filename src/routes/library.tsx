import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isAdmin, isStaff } from '../lib/types';
import { PortalLayout, PageHead, Flash } from '../views/layout';
import { Icon } from '../views/icons';
import { getSettings } from '../lib/settings';
import { chapters, hasBook, topicList } from '../lib/book';
import { cardOpen, cardsIn, dueQueue, queueSummary, rate, today, type Card, type Rating } from '../lib/cards';
import { deleteFile, fileMeta, fileResponse, fmtSize, MB, readUpload, saveFile, sniff } from '../lib/files';
import { questionStatuses, shuffle } from '../lib/qbank';
import { nyDay } from '../lib/activity';
import { fmtDate, todayUtc } from '../lib/content';
import { eveningAccess } from '../lib/evening';

/**
 * Course Book, Flash Cards, Daily Warmup, Written Notes and evening "watched".
 * Mounted after the portal router, so sign-in and enrollment checks apply.
 */
export const library = new Hono<AppEnv>();

const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const safeBack = (v: unknown, fallback: string) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fallback);

// ---------- Course Book ----------

async function bookLocked(c: Context<AppEnv>) {
  const settings = await getSettings(c.env.DB);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="USMLE100 Book" active="book-library" user={c.get('user')!}>
      <section class="card card-sage">
        <Icon name="menu_book" size={36} class="gic" />
        <h1 style="font-size:26px">USMLE100 Book</h1>
        <p>Written syllabus chapters to read online. The Course Book is included with <strong>Companion</strong>, <strong>Complete</strong> and <strong>MAX</strong>, or <strong>$199</strong> on its own.</p>
        <a class="btn btn-primary btn-block" href="/buy/course-book">Buy the Course Book</a>
        <a class="btn btn-outline btn-block" href="/plans">See plans</a>
        {settings.contact_email && <a class="btn btn-outline btn-block" href={`mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: Course Book')}`}>Ask about the Course Book</a>}
      </section>
    </PortalLayout>,
  );
}

library.get('/course-book', async (c) => {
  const user = c.get('user')!;
  if (!(await hasBook(c.env.DB, user, c.get('enrollment')))) return bookLocked(c);
  const all = await chapters(c.env.DB, user.id);
  const subj = Number(c.req.query('subject')) || 0;
  const shown = subj ? all.filter((ch) => ch.subject_id === subj) : all;
  const subjects = (await c.env.DB.prepare('SELECT id, name FROM subjects ORDER BY sort').all<{ id: number; name: string }>()).results;
  const pages = all.reduce((a, ch) => a + (ch.pages ?? 0), 0);
  const read = all.filter((ch) => ch.read_at).length;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="USMLE100 Book" active="book-library" user={user} wide>
      <section class="card card-sage book-head">
        <h1>USMLE100 Book</h1>
        <p>Written syllabus chapters to read online · {all.length} chapter{all.length === 1 ? '' : 's'}{pages ? ` · ${pages} pages` : ''} · {read}/{all.length} read</p>
        {isAdmin(user) && <a class="btn btn-primary" href="/admin/book/new" style="align-self:flex-start"><Icon name="upload" size={20} />Upload PDF</a>}
      </section>
      <nav class="pill-chips" aria-label="Subjects">
        <a href="/course-book" class={subj ? '' : 'on'}>All Subjects ({all.length})</a>
        {subjects.map((s) => {
          const n = all.filter((ch) => ch.subject_id === s.id).length;
          return <a href={`/course-book?subject=${s.id}`} class={subj === s.id ? 'on' : ''}>{s.name}{n ? <b>{n}</b> : null}</a>;
        })}
      </nav>
      {!shown.length && <p class="muted">{all.length ? 'No chapters for this subject yet.' : 'Chapters will appear here soon.'}</p>}
      <div class="book-grid">
        {shown.map((ch) => (
          <article class={'card chapter' + (ch.read_at ? ' read' : '')}>
            <div class="row between">
              <span class="ch-pill">Chapter {ch.number}{ch.subject ? ` · ${ch.subject}` : ''}</span>
              {ch.pages ? <span class="small" style="display:inline-flex;gap:6px;align-items:center"><Icon name="description" size={18} class="gic" />{ch.pages} pages</span> : null}
            </div>
            <h2><a class="plain" href={`/course-book/${ch.id}`}>{ch.title}</a></h2>
            {ch.description && <p class="muted">{ch.description}</p>}
            {topicList(ch.topics).length > 0 && <div class="tags">{topicList(ch.topics).map((t) => <span class="tag-soft">{t}</span>)}</div>}
            <div class="row" style="padding-top:12px;border-top:1px solid var(--line)">
              {ch.file_id && <a class="btn btn-soft btn-sm" href={`/course-book/${ch.id}/pdf`}><Icon name="visibility" size={18} />Read Chapter</a>}
              <form method="post" action={`/course-book/${ch.id}/read`}>
                <input type="hidden" name="back" value={c.req.url.replace(/^https?:\/\/[^/]+/, '')} />
                <button class="btn btn-outline btn-sm" type="submit" aria-pressed={ch.read_at ? 'true' : 'false'}><Icon name={ch.read_at ? 'check_circle' : 'circle'} size={18} />{ch.read_at ? 'Read' : 'Mark Read'}</button>
              </form>
            </div>
          </article>
        ))}
      </div>
    </PortalLayout>,
  );
});

library.get('/course-book/:id{[0-9]+}', async (c) => {
  const user = c.get('user')!;
  if (!(await hasBook(c.env.DB, user, c.get('enrollment')))) return bookLocked(c);
  const ch = (await chapters(c.env.DB, user.id, isStaff(user))).find((x) => x.id === Number(c.req.param('id')));
  if (!ch) return c.notFound();
  const topics = topicList(ch.topics);
  return c.html(
    <PortalLayout shell={c.get('shell')} title={ch.title} active="book-library" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/dashboard">Home</a><Icon name="chevron_right" size={16} /><a href="/course-book">USMLE100 Book</a><Icon name="chevron_right" size={16} />Chapter {ch.number}</nav>
      <section class="card">
        <div class="eyebrow">Chapter {ch.number}{ch.subject ? ` · ${ch.subject}` : ''}</div>
        <h1 style="font-size:28px">{ch.title}</h1>
        <p class="muted">{[ch.author, ch.pages ? `${ch.pages} pages` : '', ch.file_name].filter(Boolean).join(' · ')}</p>
        <div class="row">
          {ch.file_id && <a class="btn btn-primary" href={`/course-book/${ch.id}/pdf`}><Icon name="visibility" size={20} />Read Chapter</a>}
          <form method="post" action={`/course-book/${ch.id}/read`}>
            <input type="hidden" name="back" value={`/course-book/${ch.id}`} />
            <button class="btn btn-ghost" type="submit" aria-pressed={ch.read_at ? 'true' : 'false'}><Icon name={ch.read_at ? 'check_circle' : 'circle'} size={20} />{ch.read_at ? 'Read' : 'Mark Read'}</button>
          </form>
        </div>
        {ch.summary && (
          <div class="summary-box">
            <Icon name="description" size={26} class="gic" />
            <div><strong>Chapter Summary</strong><p>{ch.summary}</p></div>
          </div>
        )}
        {topics.length > 0 && (
          <>
            <div class="eyebrow" style="color:var(--body)">Topics covered</div>
            <ul class="topic-ticks">{topics.map((t) => <li><Icon name="check" size={20} />{t}</li>)}</ul>
          </>
        )}
        <a class="btn btn-outline btn-block" href={ch.section_id ? `/topics/${ch.section_id}` : ch.subject_id ? `/lectures?subject=${ch.subject_id}` : '/lectures'}><Icon name="play_circle" size={20} class="gic" />Related Lectures</a>
        {ch.subject_id && (
          <form method="post" action="/create-test">
            <input type="hidden" name="mode" value="tutor" />
            <input type="hidden" name="subject" value={String(ch.subject_id)} />
            <input type="hidden" name="count" value="10" />
            <button class="btn btn-outline btn-block" type="submit"><Icon name="quiz" size={20} class="gic" />{ch.subject} Questions</button>
          </form>
        )}
      </section>
    </PortalLayout>,
  );
});

library.get('/course-book/:id{[0-9]+}/pdf', async (c) => {
  const user = c.get('user')!;
  if (!(await hasBook(c.env.DB, user, c.get('enrollment')))) return c.notFound();
  const ch = await c.env.DB.prepare('SELECT file_id, status FROM book_chapters WHERE id = ?').bind(Number(c.req.param('id'))).first<{ file_id: number | null; status: string }>();
  if (!ch?.file_id || (ch.status !== 'live' && !isStaff(user))) return c.notFound();
  const f = await fileMeta(c.env.DB, ch.file_id);
  if (!f) return c.notFound();
  // The Course Book is view-only (R005): never offered as a download, and only formats a browser can show.
  if (f.type !== 'application/pdf') return c.notFound();
  const res = fileResponse(c.env.DB, f, 'view');
  res.headers.set('X-Robots-Tag', 'noindex, noarchive');
  return res;
});

library.post('/course-book/:id{[0-9]+}/read', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  if (await hasBook(c.env.DB, user, c.get('enrollment'))) {
    const had = await c.env.DB.prepare('SELECT 1 FROM book_reads WHERE user_id = ? AND chapter_id = ?').bind(user.id, id).first();
    const exists = await c.env.DB.prepare('SELECT 1 FROM book_chapters WHERE id = ?').bind(id).first();
    if (had) await c.env.DB.prepare('DELETE FROM book_reads WHERE user_id = ? AND chapter_id = ?').bind(user.id, id).run();
    else if (exists) await c.env.DB.prepare('INSERT INTO book_reads (user_id, chapter_id) VALUES (?, ?)').bind(user.id, id).run();
  }
  return c.redirect(safeBack(f.back, '/course-book'));
});

// ---------- Flash Cards ----------

library.get('/cards', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const section = num(c.req.query('section'));
  const lecture = num(c.req.query('lecture'));
  const practice = !!(section || lecture);
  let list: Card[];
  let i = 0;
  let title = 'Cards from your own classes';
  if (practice) {
    list = await cardsIn(db, user.id, { section: section ?? undefined, lecture: lecture ?? undefined });
    i = Math.max(0, Math.min(list.length, Number(c.req.query('i')) || 0));
    const name = section
      ? (await db.prepare('SELECT title FROM sections WHERE id = ?').bind(section).first<{ title: string }>())?.title
      : (await db.prepare('SELECT title FROM lectures WHERE id = ?').bind(lecture).first<{ title: string }>())?.title;
    title = name ?? 'Flash cards';
  } else {
    list = await dueQueue(db, user.id);
  }
  const reviewedToday = practice ? i : ((await db.prepare('SELECT COUNT(*) AS n FROM flashcard_log WHERE user_id = ? AND reviewed_at >= ?').bind(user.id, today()).first<{ n: number }>())?.n ?? 0);
  const card = practice ? list[i] : list[0];
  const total = practice ? list.length : reviewedToday + list.length;
  const pos = practice ? i + 1 : reviewedToday + 1;
  const qs = (o: Record<string, string | number>) => '/cards?' + new URLSearchParams(Object.entries({ ...(section ? { section } : {}), ...(lecture ? { lecture } : {}), ...o }).map(([k, v]) => [k, String(v)])).toString();
  const summary = !card && !practice ? await queueSummary(db, user.id) : null;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Flash Cards" active="cards" user={user}>
      <PageHead eyebrow="Flash Facts" title={title} sub={practice ? 'Practise the cards for this topic. Each answer also updates when the card comes back.' : 'Written by your instructors for the lectures you’ve watched, and scheduled so each card comes back right before you’d forget it.'} />
      {card ? (
        <>
          <div class="fc-bar">
            <b>{pos} / {total}</b>
            <div class="bar"><i style={`width:${Math.round(((pos - 1) / Math.max(1, total)) * 100)}%`}></i></div>
            {card.lecture_id && <a href={`/lectures/${card.lecture_id}`} class="fc-src"><Icon name="play_circle" size={22} />Source</a>}
          </div>
          <div class="flashcard" id="fc">
            <div class="fc-face">
              <div class="eyebrow" style="color:var(--body)">{card.lecture_title ? 'From the lesson' : 'Flash fact'}</div>
              <p class="fc-front">{card.front}</p>
              <button type="button" class="link-btn" id="flip" aria-expanded="false" aria-controls="fc-back">Tap to reveal</button>
              <div id="fc-back" class="fc-back" hidden>
                <p>{card.back}</p>
                <form method="post" action={`/cards/${card.id}/rate`} class="fc-rate">
                  <input type="hidden" name="next" value={practice ? qs({ i: i + 1 }) : '/cards'} />
                  <button class="btn btn-outline" name="rating" value="again" type="submit">Again<small>tomorrow</small></button>
                  <button class="btn btn-primary" name="rating" value="good" type="submit">Good</button>
                  <button class="btn btn-outline" name="rating" value="easy" type="submit">Easy</button>
                </form>
              </div>
            </div>
          </div>
          <p class="muted small" style="text-align:center">Answer in your head, then flip.</p>
          <script dangerouslySetInnerHTML={{ __html: `(function(){var b=document.getElementById('flip'),k=document.getElementById('fc-back'),c=document.getElementById('fc');function show(){k.hidden=false;b.hidden=true;b.setAttribute('aria-expanded','true');}b.addEventListener('click',show);c.addEventListener('click',function(e){if(!e.target.closest('form,a'))show();});})();` }} />
        </>
      ) : (
        <section class="card catch">
          <div class="catch-item">
            <span class="txt">
              <strong>{practice ? (list.length ? 'You went through every card' : 'No cards for this topic yet') : 'Cards up to date'}</strong>
              <span>{practice ? (list.length ? `${list.length} card${list.length === 1 ? '' : 's'} reviewed.` : 'Your instructors haven’t written cards for this topic yet.') : summary?.next ? `Next batch arrives ${fmtDate(new Date(summary.next + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' })}.` : 'Cards appear here after you watch lectures that have them.'}</span>
            </span>
            <span class="okic"><Icon name="check_circle" /></span>
          </div>
          {practice && list.length > 0 && <a class="btn btn-outline" href={qs({ i: 0 })} style="align-self:flex-start">Go through them again</a>}
        </section>
      )}
    </PortalLayout>,
  );
});

library.post('/cards/:id{[0-9]+}/rate', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const rating = (['again', 'good', 'easy'].includes(String(f.rating)) ? f.rating : 'good') as Rating;
  if (await cardOpen(c.env.DB, user.id, id)) await rate(c.env.DB, user.id, id, rating);
  return c.redirect(safeBack(f.next, '/cards'));
});

// ---------- Daily Warmup ----------

/** One block of 10 questions a day: unused first, then ones answered wrong, then the rest. Tutor-style, with a stopwatch. */
library.get('/warmup', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const last = await db.prepare("SELECT id, created_at, finished_at FROM tests WHERE user_id = ? AND mode = 'warmup' ORDER BY id DESC LIMIT 1").bind(user.id).first<{ id: number; created_at: string; finished_at: string | null }>();
  const todayYmd = new Date(todayUtc()).toISOString().slice(0, 10);
  if (last && nyDay(last.created_at) === todayYmd) {
    if (last.finished_at) return c.redirect(`/tests/${last.id}/results`);
    const next = await db.prepare('SELECT MIN(position) AS p FROM test_items WHERE test_id = ? AND chosen_index IS NULL').bind(last.id).first<{ p: number | null }>();
    return c.redirect(`/tests/${last.id}/${next?.p ?? 1}`);
  }
  const rows = await questionStatuses(db, user.id);
  const order = ['unused', 'incorrect', 'omitted', 'correct'];
  const picked = order.flatMap((k) => shuffle(rows.filter((r) => r.status === k))).slice(0, 10);
  if (!picked.length) return c.redirect('/qbank?error=' + encodeURIComponent('No questions are in the bank yet, so there is no warmup today.'));
  const t = await db.prepare("INSERT INTO tests (user_id, mode) VALUES (?, 'warmup')").bind(user.id).run();
  const testId = Number(t.meta.last_row_id);
  await db.batch(picked.map((q, i) => db.prepare('INSERT INTO test_items (test_id, position, question_id) VALUES (?, ?, ?)').bind(testId, i + 1, q.id)));
  return c.redirect(`/tests/${testId}/1`);
});

// ---------- Written Notes & Documents ----------

const NOTE_MAX = 10 * MB;
const NOTES_QUOTA = 50 * MB;

type NoteRow = { id: number; user_id: number; title: string; body: string | null; subject: string | null; section: string | null; file_id: number | null; file_name: string | null; file_size: number | null; file_type: string | null; is_faculty: number; created_at: string; author: string };

async function visibleNote(db: D1Database, userId: number, id: number) {
  return db.prepare('SELECT * FROM notes WHERE id = ? AND (user_id = ? OR is_faculty = 1)').bind(id, userId).first<{ id: number; user_id: number; file_id: number | null; is_faculty: number }>();
}

library.get('/notes', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const q = str(c.req.query('q'), 100);
  const rows = (
    await db
      .prepare(
        `SELECT n.*, s.name AS subject, x.title AS section, f.name AS file_name, f.size AS file_size, f.type AS file_type, u.name AS author
         FROM notes n LEFT JOIN subjects s ON s.id = n.subject_id LEFT JOIN sections x ON x.id = n.section_id
         LEFT JOIN files f ON f.id = n.file_id JOIN users u ON u.id = n.user_id
         WHERE (n.user_id = ? OR n.is_faculty = 1) ORDER BY n.updated_at DESC, n.id DESC`,
      )
      .bind(user.id)
      .all<NoteRow>()
  ).results;
  const needle = q.toLowerCase();
  const shown = needle ? rows.filter((n) => [n.title, n.body, n.subject, n.section, n.file_name].some((v) => v?.toLowerCase().includes(needle))) : rows;
  const [subjects, sections] = await Promise.all([
    db.prepare('SELECT id, name FROM subjects ORDER BY sort').all<{ id: number; name: string }>(),
    db.prepare('SELECT x.id, x.title, s.name AS subject FROM sections x LEFT JOIN subjects s ON s.id = x.subject_id ORDER BY s.sort, x.sort').all<{ id: number; title: string; subject: string | null }>(),
  ]);
  const staff = isStaff(user);
  const Tags = () => (
    <div class="grid">
      <label class="field">Subject<select name="subject_id"><option value="">None</option>{subjects.results.map((s) => <option value={String(s.id)}>{s.name}</option>)}</select></label>
      <label class="field">Section<select name="section_id"><option value="">None</option>{sections.results.map((s) => <option value={String(s.id)}>{s.subject ? `${s.subject} · ` : ''}{s.title}</option>)}</select></label>
    </div>
  );
  return c.html(
    <PortalLayout shell={c.get('shell')} title="My Notes" active="notes" user={user}>
      <PageHead title="Written Notes & Documents" sub={staff ? 'Notes you add here are shared with every student as faculty handouts.' : 'Upload written lecture summaries and your own notes, alongside faculty handouts, all in one place. Your notes are private to you.'} />
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card card-sage">
        <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap">
          <Icon name="upload" size={28} class="gic" />
          <div><h2>Upload Written Notes</h2><p class="small">Upload your own notes (PDF, DOCX, images or text, up to {NOTE_MAX / MB} MB){staff ? ' as a faculty handout' : ''} or write one here.</p></div>
        </div>
        <div class="row">
          <details class="dropdown note-add">
            <summary class="btn btn-primary"><Icon name="upload" size={18} />Upload document</summary>
            <form method="post" action="/notes" enctype="multipart/form-data" class="card stack note-form">
              <label class="field">Title<input type="text" name="title" maxlength={160} placeholder="Defaults to the file name" /></label>
              <label class="field">File<input type="file" name="file" required accept=".pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md" /></label>
              <Tags />
              <button class="btn btn-primary" type="submit">Upload</button>
            </form>
          </details>
          <details class="dropdown note-add">
            <summary class="btn btn-outline" style="background:var(--surface)"><Icon name="add" size={18} />New Typed Note</summary>
            <form method="post" action="/notes" class="card stack note-form">
              <label class="field">Title<input type="text" name="title" required maxlength={160} /></label>
              <label class="field">Note<textarea name="body" rows={6} required maxlength={20000}></textarea></label>
              <Tags />
              <button class="btn btn-primary" type="submit">Save note</button>
            </form>
          </details>
        </div>
      </section>
      <form method="get" action="/notes" class="row" style="flex-wrap:nowrap;gap:10px">
        <label class="filter-box" style="flex:1"><Icon name="search" size={20} /><span class="sr">Search your notes</span><input type="search" name="q" value={q} placeholder="Search your written notes…" /></label>
        <span class="small muted" style="white-space:nowrap">{shown.length} of {rows.length}</span>
      </form>
      {!rows.length && <p class="muted">No notes yet.</p>}
      {shown.map((n) => (
        <article class="card note">
          <div class="row between" style="flex-wrap:nowrap;align-items:flex-start">
            <h2>{n.title}</h2>
            {(n.user_id === user.id || isAdmin(user)) && (
              <form method="post" action={`/notes/${n.id}/delete`}>
                <button class="icon-btn" type="submit" aria-label={`Delete note “${n.title}”`}><Icon name="delete" size={22} /></button>
              </form>
            )}
          </div>
          <p class="small muted">{[n.subject, n.section].filter(Boolean).join(' · ')}{(n.subject || n.section) && ' · '}{n.is_faculty ? <span class="chip chip-sand">Faculty</span> : fmtDate(new Date(n.created_at.replace(' ', 'T') + 'Z'), { month: 'short', day: 'numeric' })}{n.is_faculty && n.user_id !== user.id ? ` · ${n.author}` : ''}</p>
          {n.body && <div class="note-body">{n.body}</div>}
          {n.file_id && (
            <div class="row">
              <a class="btn btn-soft btn-sm" href={`/notes/${n.id}/file`}><Icon name="visibility" size={18} />Open</a>
              <a class="btn btn-outline btn-sm" href={`/notes/${n.id}/file?download=1`}><Icon name="download" size={18} />{n.file_name} · {fmtSize(n.file_size ?? 0)}</a>
            </div>
          )}
        </article>
      ))}
    </PortalLayout>,
  );
});

library.post('/notes', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const bad = (m: string) => c.redirect('/notes?error=' + encodeURIComponent(m));
  const up = await readUpload(f.file, NOTE_MAX);
  if (up && 'error' in up) return bad(up.error);
  let fileId: number | null = null;
  if (up) {
    const type = sniff(up.data, up.name, 'notes');
    if (!type) return bad('That file type isn’t allowed. Use PDF, DOCX, an image (PNG, JPG, GIF, WebP) or a text file.');
    const used = (await db.prepare('SELECT COALESCE(SUM(f.size), 0) AS s FROM notes n JOIN files f ON f.id = n.file_id WHERE n.user_id = ?').bind(user.id).first<{ s: number }>())?.s ?? 0;
    if (!isStaff(user) && used + up.data.byteLength > NOTES_QUOTA) return bad(`Your uploads would go over ${NOTES_QUOTA / MB} MB. Delete an old file first.`);
    fileId = await saveFile(db, user.id, up.name, type, up.data);
  }
  const body = str(f.body, 20000);
  const title = str(f.title, 160) || up?.name.replace(/\.[a-z0-9]+$/i, '') || '';
  if (!title || (!body && !fileId)) return bad('Add a title and either a note or a file.');
  await db.prepare('INSERT INTO notes (user_id, title, body, subject_id, section_id, file_id, is_faculty) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, title, body || null, num(f.subject_id), num(f.section_id), fileId, isStaff(user) ? 1 : 0)
    .run();
  return c.redirect('/notes?ok=' + encodeURIComponent('Saved.'));
});

library.get('/notes/:id{[0-9]+}/file', async (c) => {
  const n = await visibleNote(c.env.DB, c.get('user')!.id, Number(c.req.param('id')));
  if (!n?.file_id) return c.notFound();
  const f = await fileMeta(c.env.DB, n.file_id);
  return f ? fileResponse(c.env.DB, f, c.req.query('download') ? 'download' : 'view') : c.notFound();
});

library.post('/notes/:id{[0-9]+}/delete', async (c) => {
  const user = c.get('user')!;
  const n = await c.env.DB.prepare('SELECT id, user_id, file_id FROM notes WHERE id = ?').bind(Number(c.req.param('id'))).first<{ id: number; user_id: number; file_id: number | null }>();
  if (n && (n.user_id === user.id || isAdmin(user))) {
    await c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(n.id).run();
    await deleteFile(c.env.DB, n.file_id);
  }
  return c.redirect('/notes?ok=' + encodeURIComponent('Deleted.'));
});

// ---------- Evening Questions: mark a recording as watched ----------

library.post('/evening/:id{[0-9]+}/done', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const acc = await eveningAccess(c.env.DB, user);
  if (acc && (acc.staff || acc.visible.has(id))) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO evening_progress (user_id, session_id) VALUES (?, ?)').bind(user.id, id).run();
  }
  return c.redirect(`/evening/${id}`);
});
