import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { Icon } from '../views/icons';
import { lecturesEndedOn, lecturesEndedPage, lectureNotice, LectureNotice } from '../views/lectureAccess';
import { ProtectedPlayer } from '../views/player';
import { cohortDay, currentCohort, dayDate, fmtDate, type Cohort } from '../lib/content';
import { getSettings } from '../lib/settings';
import { shuffle } from '../lib/qbank';
import { catalog, clock, groupBySection, hasLength, objectiveList, runtime, runtimeLong, seconds, type CatLecture, type Group } from '../lib/catalog';

/**
 * V12 lectures: Browse (sections, Play section, bookmarks, filters), Workbench (your own session queue),
 * Path (subjects and sections with progress), Topics (one section at a time with objectives) and the player.
 * Mounted after the portal router, so its sign-in and enrollment checks apply here too.
 */
export const learn = new Hono<AppEnv>();

const safeBack = (v: unknown, fallback: string) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fallback);

/** Shared start for every lectures page: the cohort, the access check and the catalog. */
async function load(c: Context<AppEnv>) {
  const user = c.get('user')!;
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const ended = await lecturesEndedOn(c, cohort);
  if (ended) return { ended, user, cohort: null, cat: null };
  const cat = cohort ? await catalog(c.env.DB, cohort.id, user.id) : { lectures: [], sections: [], subjects: [] };
  // Students only see lectures that are live.
  if (!isStaff(user)) cat.lectures = cat.lectures.filter((l) => l.status === 'live');
  return { ended: null, user, cohort, cat };
}

const Tabs = (p: { on: 'browse' | 'workbench' | 'path' }) => (
  <nav class="tabs" aria-label="Lecture views">
    <a href="/lectures" class={p.on === 'browse' ? 'on' : ''} aria-current={p.on === 'browse' ? 'page' : undefined}>Browse</a>
    <a href="/lectures/workbench" class={p.on === 'workbench' ? 'on' : ''} aria-current={p.on === 'workbench' ? 'page' : undefined}>Workbench</a>
    <a href="/lectures/path" class={p.on === 'path' ? 'on' : ''} aria-current={p.on === 'path' ? 'page' : undefined}>Path</a>
  </nav>
);

const SaveBtn = (p: { l: CatLecture; back: string }) => (
  <form method="post" action={`/lectures/${p.l.id}/save`} class="save-form">
    <input type="hidden" name="back" value={p.back} />
    <button type="submit" class="icon-btn" aria-pressed={p.l.saved ? 'true' : 'false'} aria-label={p.l.saved ? `Remove “${p.l.title}” from saved` : `Save “${p.l.title}”`} title={p.l.saved ? 'Saved' : 'Save'}>
      <Icon name={p.l.saved ? 'bookmark_fill' : 'bookmark'} size={22} />
    </button>
  </form>
);

function LecCard(p: { l: CatLecture; today: number; cohort: Cohort; back: string; inParam?: string }) {
  const { l } = p;
  const live = l.status === 'live';
  const missed = live && !l.completed_at && l.day_number < p.today;
  const href = `/lectures/${l.id}${p.inParam ? `?in=${p.inParam}` : ''}`;
  return (
    <article class={'lec-card' + (l.day_number === p.today ? ' today' : '')} data-title={l.title.toLowerCase()} data-state={l.completed_at ? 'watched' : 'todo'} data-saved={l.saved ? '1' : '0'}>
      <div class="lec-top">
        <span class={'dot' + (l.completed_at ? '' : missed ? ' missed' : ' todo')} aria-hidden="true"></span>
        <span class="lec-num">Day {l.day_number}</span>
        {l.completed_at ? <span class="tag">Watched</span> : !live ? <span class="chip chip-gray">Coming soon</span> : missed ? <span class="chip chip-rust">Missed</span> : <span class="tag">Video</span>}
        <span style="flex:1"></span>
        <SaveBtn l={l} back={p.back} />
      </div>
      {live ? <a class="lec-title" href={href}>{l.title}</a> : <span class="lec-title">{l.title}</span>}
      <span class="lec-date">{l.duration_seconds ? clock(l.duration_seconds) + ' · ' : ''}{fmtDate(dayDate(p.cohort, l.day_number), { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      {live && (
        <a class={'btn btn-block ' + (l.completed_at ? 'btn-outline' : 'btn-primary')} href={href}>
          <Icon name="play" size={18} />{l.completed_at ? 'Watch again' : 'Start'}
        </a>
      )}
    </article>
  );
}

const firstToPlay = (ls: CatLecture[]) => ls.find((l) => l.status === 'live' && !l.completed_at) ?? ls.find((l) => l.status === 'live');

// ---------- Browse ----------

learn.get('/lectures', async (c) => {
  const r = await load(c);
  if (r.ended) return lecturesEndedPage(c, r.ended, (await getSettings(c.env.DB)).contact_email);
  const { user, cohort, cat } = r;
  const subj = Number(c.req.query('subject')) || 0;
  const show = c.req.query('show') ?? 'all';
  const usedSubjects = cat!.subjects.filter((s) => cat!.lectures.some((l) => l.subject_id === s.id));
  let shown = subj ? cat!.lectures.filter((l) => l.subject_id === subj) : cat!.lectures;
  if (show === 'saved') shown = shown.filter((l) => l.saved);
  if (show === 'todo') shown = shown.filter((l) => !l.completed_at);
  if (show === 'watched') shown = shown.filter((l) => l.completed_at);
  const groups = groupBySection(shown, cat!.sections, cat!.subjects);
  const today = cohort ? cohortDay(cohort) : 0;
  const done = shown.filter((l) => l.completed_at).length;
  const next = firstToPlay(shown.filter((l) => !l.completed_at));
  const back = c.req.path + (c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '');
  const q = (o: Record<string, string | number>) => {
    const p = new URLSearchParams();
    if (subj) p.set('subject', String(subj));
    if (show !== 'all') p.set('show', show);
    for (const [k, v] of Object.entries(o)) v ? p.set(k, String(v)) : p.delete(k);
    const s = p.toString();
    return '/lectures' + (s ? '?' + s : '');
  };
  const SHOWS: [string, string][] = [['all', 'All lectures'], ['todo', 'Not watched yet'], ['watched', 'Watched'], ['saved', 'Saved']];
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Lectures" active="lectures" user={user} wide>
      <Tabs on="browse" />
      <section class="card" style="gap:12px">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/dashboard">Home</a><Icon name="chevron_right" size={16} />Lectures</nav>
        <h1>All lectures</h1>
        <p class="muted">Taught live by doctors. One lecture a day across {cohort?.lecture_days ?? 90} days.</p>
        {usedSubjects.length > 0 && (
          <nav class="subj-tabs" aria-label="Subjects">
            <a href={q({ subject: 0 })} class={subj ? '' : 'on'}>All subjects</a>
            {usedSubjects.map((s) => <a href={q({ subject: s.id })} class={subj === s.id ? 'on' : ''}>{s.name}</a>)}
          </nav>
        )}
        <label class="filter-box">
          <Icon name="filter" size={20} />
          <span class="sr">Filter lectures</span>
          <input type="search" id="lecfilter" placeholder="Start typing to filter the lectures" autocomplete="off" />
        </label>
      </section>
      <LectureNotice n={lectureNotice(c, cohort)} />
      <p class="small"><strong>{done}</strong> of {shown.length} lectures done{hasLength(shown) ? ` · ${runtime(seconds(shown))} runtime` : ''}</p>
      {next && (
        <a class="btn btn-primary btn-block" href={`/lectures/${next.id}`}><Icon name="play" size={20} />{done ? 'Continue with the next lecture' : 'Start the first lecture'}</a>
      )}
      <div class="row" style="gap:10px">
        <a class={'btn btn-outline' + (show === 'saved' ? ' on' : '')} style="flex:1" href={q({ show: show === 'saved' ? '' : 'saved' })} aria-pressed={show === 'saved' ? 'true' : 'false'}>
          <Icon name={show === 'saved' ? 'bookmark_fill' : 'bookmark'} size={18} />Saved
        </a>
        <details class="dropdown" style="flex:1">
          <summary class="btn btn-outline btn-block"><Icon name="filter" size={18} />Filters</summary>
          <div class="dropdown-menu" role="menu">
            {SHOWS.map(([k, label]) => (
              <a role="menuitemradio" aria-checked={show === k ? 'true' : 'false'} href={q({ show: k === 'all' ? '' : k })} class={show === k ? 'on' : ''}>
                <Icon name={show === k ? 'check_circle' : 'circle'} size={18} />{label}
              </a>
            ))}
          </div>
        </details>
      </div>
      {!shown.length && <p class="muted">{show === 'saved' ? 'Nothing saved yet. Tap the bookmark on a lecture to keep it here.' : 'No lectures here yet. They appear after each class.'}</p>}
      {groups.map((g, i) => <SectionBlock g={g} n={i + 1} today={today} cohort={cohort!} back={back} />)}
      <p class="muted small" id="lecnone" hidden>No lectures match that filter.</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var i=document.getElementById('lecfilter');if(!i)return;i.addEventListener('input',function(){var q=i.value.trim().toLowerCase(),any=false;document.querySelectorAll('[data-section]').forEach(function(s){var n=0;s.querySelectorAll('[data-title]').forEach(function(a){var ok=!q||a.dataset.title.indexOf(q)>=0;a.hidden=!ok;if(ok)n++;});s.hidden=n===0;if(n)any=true;});document.getElementById('lecnone').hidden=any;});})();`,
        }}
      />
    </PortalLayout>,
  );
});

function SectionBlock(p: { g: Group; n: number; today: number; cohort: Cohort; back: string }) {
  const { g } = p;
  const done = g.lectures.filter((l) => l.completed_at).length;
  const pct = Math.round((done / g.lectures.length) * 100);
  const play = firstToPlay(g.lectures);
  const inParam = g.section ? `s${g.section.id}` : undefined;
  return (
    <section class="lec-section" data-section>
      <div class="lec-section-head">
        <span class="num">{p.n}</span>
        <strong>{g.section ? <a href={`/topics/${g.section.id}`} class="plain">{g.title}</a> : g.title}</strong>
        {play && (
          <a class="btn btn-outline btn-sm" href={`/lectures/${play.id}${inParam ? `?in=${inParam}` : ''}`}><Icon name="play" size={16} />Play section</a>
        )}
      </div>
      <div class="bar bar-cream"><i style={`width:${pct}%`}></i></div>
      <div class="lec-meta">{done} of {g.lectures.length} lectures completed{hasLength(g.lectures) ? ` · ${runtime(seconds(g.lectures))} runtime` : ''}</div>
      <div class="lec-grid">
        {g.lectures.map((l) => <LecCard l={l} today={p.today} cohort={p.cohort} back={p.back} inParam={inParam} />)}
      </div>
    </section>
  );
}

/**
 * A student may only open, save or complete lectures of their own cohort (staff: any).
 */
async function ownCohortId(c: any): Promise<number | null> {
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  return cohort?.id ?? null;
}
const lectureAllowedSql = "SELECT 1 FROM lectures WHERE id = ? AND ((status = 'live' AND cohort_id = ?) OR ?)";

learn.post('/lectures/:id{[0-9]+}/save', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const exists = await c.env.DB.prepare(lectureAllowedSql).bind(id, await ownCohortId(c), isStaff(user) ? 1 : 0).first();
  if (exists) {
    const had = await c.env.DB.prepare('SELECT 1 FROM lecture_bookmarks WHERE user_id = ? AND lecture_id = ?').bind(user.id, id).first();
    await c.env.DB.prepare(had ? 'DELETE FROM lecture_bookmarks WHERE user_id = ? AND lecture_id = ?' : 'INSERT INTO lecture_bookmarks (user_id, lecture_id) VALUES (?, ?)').bind(user.id, id).run();
  }
  return c.redirect(safeBack(f.back, `/lectures/${id}`));
});

// ---------- Workbench ----------

async function queue(db: D1Database, userId: number, cohortId: number) {
  return (
    await db
      .prepare(
        `SELECT l.id, l.day_number, l.title, l.subject_id, l.section_id, l.duration_seconds, l.objectives, l.status, p.completed_at, 0 AS saved
         FROM workbench_items w JOIN lectures l ON l.id = w.lecture_id
         LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = w.user_id
         WHERE w.user_id = ? AND l.cohort_id = ? AND l.status = 'live' ORDER BY w.position`,
      )
      .bind(userId, cohortId)
      .all<CatLecture>()
  ).results;
}

learn.get('/lectures/workbench', async (c) => {
  const r = await load(c);
  if (r.ended) return lecturesEndedPage(c, r.ended, (await getSettings(c.env.DB)).contact_email);
  const { user, cohort, cat } = r;
  const q = cohort ? await queue(c.env.DB, user.id, cohort.id) : [];
  const groups = groupBySection(cat!.lectures, cat!.sections, cat!.subjects).filter((g) => g.section);
  const inQueue = new Set(q.map((l) => l.id));
  const left = q.filter((l) => !l.completed_at);
  const start = left[0] ?? q[0];
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Workbench" active="lectures" user={user} wide>
      <Tabs on="workbench" />
      <div class="wb">
        <section class="card wb-main">
          {q.length ? (
            <>
              <div class="row between"><h1 style="font-size:24px">Your session</h1>
                <form method="post" action="/lectures/workbench/clear"><button class="link-btn danger" type="submit">Clear all</button></form>
              </div>
              <ol class="wb-list">
                {q.map((l, i) => (
                  <li class={l.completed_at ? 'done' : ''}>
                    <span class="wb-n">{i + 1}</span>
                    <a href={`/lectures/${l.id}?in=q`} class="wb-t"><strong>{l.title}</strong><span>Day {l.day_number}{l.duration_seconds ? ` · ${clock(l.duration_seconds)}` : ''}{l.completed_at ? ' · watched' : ''}</span></a>
                    <form method="post" action="/lectures/workbench/remove">
                      <input type="hidden" name="lecture" value={String(l.id)} />
                      <button class="icon-btn" type="submit" aria-label={`Remove “${l.title}” from the session`}><Icon name="close" size={20} /></button>
                    </form>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div class="empty">
              <Icon name="menu_book" size={44} />
              <h1 style="font-size:22px">Pick a section to build a session</h1>
              <p class="muted">Lessons land here as cards. The queue keeps a running total.</p>
            </div>
          )}
        </section>
        <aside class="card wb-side">
          <div class="row between"><span class="eyebrow" style="color:var(--body)">Session queue</span><b class="gnum">{q.length}</b></div>
          <div class="wb-total"><Icon name="schedule" size={24} /><span><strong>{hasLength(q) ? runtimeLong(seconds(q)) : `${q.length} lecture${q.length === 1 ? '' : 's'}`}</strong><small>{hasLength(q) ? 'total runtime' : 'in this session'}</small></span></div>
          {start && <a class="btn btn-primary btn-block" href={`/lectures/${start.id}?in=q`}><Icon name="queue_play" size={20} />{left.length && left.length < q.length ? 'Continue session' : 'Start session'}</a>}
        </aside>
      </div>
      <h2 class="section-title">Sections</h2>
      {!groups.length && <p class="muted">Sections appear here once lectures are sorted into topics.</p>}
      <div class="path-rows">
        {groups.map((g) => {
          const all = g.lectures.every((l) => inQueue.has(l.id));
          return (
            <div class="path-row">
              <a href={`/topics/${g.section!.id}`} class="pr-t">{g.title}</a>
              <span class="pr-m">{g.lectures.length}{hasLength(g.lectures) ? ` · ${runtime(seconds(g.lectures))}` : ''}</span>
              <form method="post" action="/lectures/workbench/add">
                <input type="hidden" name="section" value={String(g.section!.id)} />
                <input type="hidden" name="back" value="/lectures/workbench" />
                <button class="icon-btn" type="submit" disabled={all} aria-label={all ? `${g.title} is in your session` : `Add ${g.title} to your session`}><Icon name={all ? 'check_circle' : 'add_circle'} size={26} /></button>
              </form>
            </div>
          );
        })}
      </div>
    </PortalLayout>,
  );
});

learn.post('/lectures/workbench/add', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody();
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  if (cohort) {
    const ids = f.section
      ? (await c.env.DB.prepare("SELECT id FROM lectures WHERE cohort_id = ? AND section_id = ? AND status = 'live' ORDER BY day_number").bind(cohort.id, Number(f.section)).all<{ id: number }>()).results.map((x) => x.id)
      : f.lecture
        ? (await c.env.DB.prepare("SELECT id FROM lectures WHERE cohort_id = ? AND id = ? AND status = 'live'").bind(cohort.id, Number(f.lecture)).all<{ id: number }>()).results.map((x) => x.id)
        : [];
    const top = (await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM workbench_items WHERE user_id = ?').bind(user.id).first<{ p: number }>())?.p ?? 0;
    if (ids.length) {
      await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare('INSERT OR IGNORE INTO workbench_items (user_id, lecture_id, position) VALUES (?, ?, ?)').bind(user.id, id, top + i + 1)));
    }
  }
  return c.redirect(safeBack(f.back, '/lectures/workbench'));
});

learn.post('/lectures/workbench/remove', async (c) => {
  const f = await c.req.parseBody();
  await c.env.DB.prepare('DELETE FROM workbench_items WHERE user_id = ? AND lecture_id = ?').bind(c.get('user')!.id, Number(f.lecture)).run();
  return c.redirect('/lectures/workbench');
});

learn.post('/lectures/workbench/clear', async (c) => {
  await c.env.DB.prepare('DELETE FROM workbench_items WHERE user_id = ?').bind(c.get('user')!.id).run();
  return c.redirect('/lectures/workbench');
});

// ---------- Path ----------

learn.get('/lectures/path', async (c) => {
  const r = await load(c);
  if (r.ended) return lecturesEndedPage(c, r.ended, (await getSettings(c.env.DB)).contact_email);
  const { user, cat } = r;
  const focus = new Set((await c.env.DB.prepare('SELECT subject_id FROM user_focus_subjects WHERE user_id = ?').bind(user.id).all<{ subject_id: number }>()).results.map((x) => x.subject_id));
  const cohort = r.cohort!;
  const q = cohort ? await queue(c.env.DB, user.id, cohort.id) : [];
  const inQueue = new Set(q.map((l) => l.id));
  const all = cat!.lectures;
  const done = all.filter((l) => l.completed_at);
  const remaining = all.filter((l) => !l.completed_at);
  const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
  const groups = groupBySection(all, cat!.sections, cat!.subjects);
  // Subjects in course order, with the ones picked during onboarding first.
  const subjectIds = [...new Set(groups.map((g) => g.subject_id ?? 0))].sort((a, b) => (focus.has(b) ? 1 : 0) - (focus.has(a) ? 1 : 0));
  const subName = new Map(cat!.subjects.map((s) => [s.id, s.name]));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Your path" active="lectures" user={user} wide>
      <Tabs on="path" />
      <div class="path-head">
        <div>
          <h1 style="font-size:34px">Your path</h1>
          <p class="muted">{done.length} of {all.length} lessons complete{hasLength(remaining) ? ` · ${runtimeLong(seconds(remaining))} remaining` : ''}</p>
        </div>
        <div class="ring ring-sm" style={`--p:${pct}`} role="img" aria-label={`${pct}% complete`}><b>{pct}%</b></div>
      </div>
      {!all.length && <p class="muted">Your path fills in as lectures go live.</p>}
      <ol class="path">
        {subjectIds.map((sid, i) => {
          const gs = groups.filter((g) => (g.subject_id ?? 0) === sid);
          const ls = gs.flatMap((g) => g.lectures);
          return (
            <li class="path-stage">
              <span class="path-n">{i + 1}</span>
              <div class="path-body">
                <h2>{sid ? subName.get(sid) : 'General'}{focus.has(sid) && <span class="chip" style="margin-left:8px;vertical-align:middle">Your focus</span>}</h2>
                <p class="muted small">{gs.length} stage{gs.length === 1 ? '' : 's'}{hasLength(ls) ? ` · ${runtimeLong(seconds(ls))}` : ''} · {ls.filter((l) => l.completed_at).length} of {ls.length} done</p>
                <div class="path-rows">
                  {gs.map((g) => {
                    const complete = g.lectures.every((l) => l.completed_at);
                    const queued = g.lectures.every((l) => inQueue.has(l.id));
                    return (
                      <div class={'path-row' + (complete ? ' done' : '')}>
                        {g.section ? <a href={`/topics/${g.section.id}`} class="pr-t">{g.title}</a> : <span class="pr-t">{g.title}</span>}
                        <span class="pr-m">{g.lectures.length}{hasLength(g.lectures) ? ` · ${seconds(g.lectures) >= 5400 ? runtime(seconds(g.lectures)) : `${Math.round(seconds(g.lectures) / 60)} minutes`}` : ''}</span>
                        {complete ? (
                          <span class="okic" aria-label="Completed"><Icon name="check_circle" size={26} /></span>
                        ) : g.section ? (
                          <form method="post" action="/lectures/workbench/add">
                            <input type="hidden" name="section" value={String(g.section.id)} />
                            <input type="hidden" name="back" value="/lectures/path" />
                            <button class="icon-btn" type="submit" disabled={queued} aria-label={queued ? `${g.title} is in your Workbench` : `Add ${g.title} to your Workbench`}><Icon name={queued ? 'check_circle' : 'add_circle'} size={26} /></button>
                          </form>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </PortalLayout>,
  );
});

// ---------- Topics (one section at a time) ----------

async function sectionCounts(db: D1Database, userId: number, sectionId: number, subjectId: number | null, lectureIds: number[]) {
  const ids = lectureIds.length ? lectureIds : [0];
  const marks = ids.map(() => '?').join(',');
  const [cards, qs, book] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM flashcards f WHERE f.status = 'live' AND (f.section_id = ? OR f.lecture_id IN (${marks}))`)
      .bind(sectionId, ...ids)
      .first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE status = 'approved' AND lecture_id IN (${marks})`).bind(...ids).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM book_chapters WHERE status = 'live' AND (section_id = ? OR (section_id IS NULL AND subject_id = ?))").bind(sectionId, subjectId).first<{ n: number }>(),
  ]);
  return { cards: cards?.n ?? 0, qs: qs?.n ?? 0, book: book?.n ?? 0 };
}

learn.get('/topics', async (c) => {
  const r = await load(c);
  if (r.ended) return lecturesEndedPage(c, r.ended, (await getSettings(c.env.DB)).contact_email);
  const g = groupBySection(r.cat!.lectures, r.cat!.sections, r.cat!.subjects).find((x) => x.section);
  if (g) return c.redirect(`/topics/${g.section!.id}`);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Topics" active="topics" user={r.user}>
      <h1>High-Yield Topics</h1>
      <p class="muted">Topics appear here once lectures are sorted into sections.</p>
      <a class="btn btn-primary" href="/lectures" style="align-self:flex-start">Browse all lectures</a>
    </PortalLayout>,
  );
});

learn.get('/topics/:id{[0-9]+}', async (c) => {
  const r = await load(c);
  if (r.ended) return lecturesEndedPage(c, r.ended, (await getSettings(c.env.DB)).contact_email);
  const { user, cat } = r;
  const groups = groupBySection(cat!.lectures, cat!.sections, cat!.subjects).filter((g) => g.section);
  const idx = groups.findIndex((g) => g.section!.id === Number(c.req.param('id')));
  if (idx < 0) return c.notFound();
  const g = groups[idx];
  const subName = new Map(cat!.subjects.map((s) => [s.id, s.name]));
  const counts = await sectionCounts(c.env.DB, user.id, g.section!.id, g.subject_id, g.lectures.map((l) => l.id));
  const err = c.req.query('error');
  return c.html(
    <PortalLayout shell={c.get('shell')} title={g.title} active="topics" user={user}>
      <details class="card topic-pick">
        <summary><Icon name="menu_book" size={24} class="gic" /><strong>Browse High-Yield Topics ({groups.length} Section{groups.length === 1 ? '' : 's'})</strong><Icon name="down" class="chev" /></summary>
        <ol class="topic-list">
          {groups.map((x, i) => (
            <li><a href={`/topics/${x.section!.id}`} aria-current={i === idx ? 'page' : undefined} class={i === idx ? 'on' : ''}><span>{i + 1}</span>{x.title}<small>{x.subject_id ? subName.get(x.subject_id) : ''}</small></a></li>
          ))}
        </ol>
      </details>
      {err && <Flash kind="error">{err}</Flash>}
      <section class="card topic">
        <div class="eyebrow">{g.subject_id ? subName.get(g.subject_id) + ' · ' : ''}{g.lectures.length} lecture{g.lectures.length === 1 ? '' : 's'}</div>
        <h1>{g.title}</h1>
        <nav class="pager" aria-label="Sections">
          {idx > 0 ? <a href={`/topics/${groups[idx - 1].section!.id}`} aria-label="Previous section"><Icon name="chevron_right" class="flip" /></a> : <span class="off"><Icon name="chevron_right" class="flip" /></span>}
          <span>Section {idx + 1} of {groups.length}</span>
          {idx < groups.length - 1 ? <a href={`/topics/${groups[idx + 1].section!.id}`} aria-label="Next section"><Icon name="chevron_right" /></a> : <span class="off"><Icon name="chevron_right" /></span>}
        </nav>
        <div class="chips-row">
          <a class="chip-btn" href="#lectures"><Icon name="play_circle" size={20} />Videos <b>{g.lectures.length}</b></a>
          <a class="chip-btn" href={`/cards?section=${g.section!.id}`}><Icon name="cards" size={20} />Cards <b>{counts.cards}</b></a>
          <form method="post" action={`/topics/${g.section!.id}/practice`} style="display:contents">
            <button class="chip-btn" type="submit" disabled={!counts.qs}><Icon name="quiz" size={20} />Qbank <b>{counts.qs}</b></button>
          </form>
          <a class="chip-btn" href={`/course-book${g.subject_id ? `?subject=${g.subject_id}` : ''}`}><Icon name="book" size={20} />Book <b>{counts.book}</b></a>
        </div>
        <div id="lectures" class="topic-lectures">
          {g.lectures.map((l) => {
            const obj = objectiveList(l.objectives);
            return (
              <article class="topic-lec">
                <h2>{l.title}</h2>
                <span class="muted small">Day {l.day_number}{l.duration_seconds ? ` · ${Math.max(1, Math.round(l.duration_seconds / 60))} min lecture` : ''}{l.completed_at ? ' · watched' : ''}</span>
                <a class={'btn btn-block ' + (l.completed_at ? 'btn-outline' : 'btn-primary')} href={`/lectures/${l.id}?in=s${g.section!.id}`}><Icon name="play" size={18} />{l.completed_at ? 'Watch again' : 'Watch Lecture'}</a>
                {obj.length > 0 && (
                  <>
                    <div class="eyebrow" style="color:var(--body)">By the end of this lecture you should be able to</div>
                    <ul class="checks">{obj.map((o) => <li><Icon name="check_circle" size={20} />{o}</li>)}</ul>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </PortalLayout>,
  );
});

/** Practice the questions written for a section's lectures (tutor mode). */
learn.post('/topics/:id{[0-9]+}/practice', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const qs = cohort
    ? (
        await c.env.DB.prepare(
          "SELECT q.id FROM questions q JOIN lectures l ON l.id = q.lecture_id WHERE q.status = 'approved' AND l.section_id = ? AND l.cohort_id = ? AND l.status = 'live'",
        )
          .bind(id, cohort.id)
          .all<{ id: number }>()
      ).results
    : [];
  const picked = shuffle(qs).slice(0, 20);
  if (!picked.length) return c.redirect(`/topics/${id}?error=` + encodeURIComponent('No questions are linked to this section yet.'));
  const t = await c.env.DB.prepare("INSERT INTO tests (user_id, mode) VALUES (?, 'tutor')").bind(user.id).run();
  const testId = Number(t.meta.last_row_id);
  await c.env.DB.batch(picked.map((q, i) => c.env.DB.prepare('INSERT INTO test_items (test_id, position, question_id) VALUES (?, ?, ?)').bind(testId, i + 1, q.id)));
  return c.redirect(`/tests/${testId}/1`);
});

// ---------- Player ----------

learn.get('/lectures/:id{[0-9]+}', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const l = await db
    .prepare(
      `SELECT l.*, p.completed_at, CASE WHEN b.lecture_id IS NULL THEN 0 ELSE 1 END AS saved, s.title AS section_title, sj.name AS subject_name
       FROM lectures l LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?1
       LEFT JOIN lecture_bookmarks b ON b.lecture_id = l.id AND b.user_id = ?1
       LEFT JOIN sections s ON s.id = l.section_id LEFT JOIN subjects sj ON sj.id = l.subject_id
       WHERE l.id = ?2`,
    )
    .bind(user.id, Number(c.req.param('id')))
    .first<CatLecture & { cohort_id: number; bunny_video_id: string | null; section_title: string | null; subject_name: string | null }>();
  if (!l || (l.status !== 'live' && !isStaff(user))) return c.notFound();
  const cohort = await currentCohort(db, c.get('enrollment')?.cohort_id);
  // Paid lectures belong to one cohort: another cohort's lecture is simply not there for this student.
  if (!isStaff(user) && (!cohort || cohort.id !== l.cohort_id)) return c.notFound();
  const ended = await lecturesEndedOn(c, cohort);
  if (ended) return lecturesEndedPage(c, ended, (await getSettings(db)).contact_email);

  // Previous / next: within the section or the Workbench when played from there, otherwise by day.
  const inP = c.req.query('in') ?? '';
  type Nav = { id: number; day_number: number; title: string };
  let list: Nav[] = [];
  let listName = '';
  if (inP === 'q') {
    list = (
      await db
        .prepare("SELECT l.id, l.day_number, l.title FROM workbench_items w JOIN lectures l ON l.id = w.lecture_id WHERE w.user_id = ? AND l.status = 'live' ORDER BY w.position")
        .bind(user.id)
        .all<Nav>()
    ).results;
    listName = 'Workbench session';
  } else if (/^s\d+$/.test(inP)) {
    list = (
      await db.prepare("SELECT id, day_number, title FROM lectures WHERE cohort_id = ? AND section_id = ? AND status = 'live' ORDER BY day_number").bind(l.cohort_id, Number(inP.slice(1))).all<Nav>()
    ).results;
    listName = l.section_title ?? 'This section';
  }
  const pos = list.findIndex((x) => x.id === l.id);
  let prev: Nav | null, next: Nav | null;
  if (pos >= 0) {
    prev = list[pos - 1] ?? null;
    next = list[pos + 1] ?? null;
  } else {
    listName = '';
    [prev, next] = await Promise.all([
      db.prepare("SELECT id, day_number, title FROM lectures WHERE cohort_id = ? AND day_number < ? AND status = 'live' ORDER BY day_number DESC LIMIT 1").bind(l.cohort_id, l.day_number).first<Nav>(),
      db.prepare("SELECT id, day_number, title FROM lectures WHERE cohort_id = ? AND day_number > ? AND status = 'live' ORDER BY day_number LIMIT 1").bind(l.cohort_id, l.day_number).first<Nav>(),
    ]);
  }
  const suffix = pos >= 0 ? `?in=${inP}` : '';
  const [lc, cardCount, inWb] = await Promise.all([
    db.prepare('SELECT * FROM cohorts WHERE id = ?').bind(l.cohort_id).first<Cohort>(),
    db.prepare("SELECT COUNT(*) AS n FROM flashcards WHERE status = 'live' AND lecture_id = ?").bind(l.id).first<{ n: number }>(),
    db.prepare('SELECT 1 FROM workbench_items WHERE user_id = ? AND lecture_id = ?').bind(user.id, l.id).first(),
  ]);
  const obj = objectiveList(l.objectives);
  const here = `/lectures/${l.id}${suffix}`;
  return c.html(
    <PortalLayout shell={c.get('shell')} title={l.title} active="lectures" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/dashboard">Home</a><Icon name="chevron_right" size={16} /><a href="/lectures">Lectures</a>{l.section_id && <><Icon name="chevron_right" size={16} /><a href={`/topics/${l.section_id}`}>{l.section_title}</a></>}<Icon name="chevron_right" size={16} />Day {l.day_number}</nav>
      <div class="stack" style="gap:6px">
        <Eyebrow>Day {l.day_number}{lc ? ` · ${fmtDate(dayDate({ ...lc, daysOff: cohort?.id === lc.id ? cohort.daysOff : undefined }, l.day_number), { weekday: 'long', month: 'long', day: 'numeric' })}` : ''}{l.duration_seconds ? ` · ${clock(l.duration_seconds)}` : ''}</Eyebrow>
        <h1>{l.title}</h1>
        {(l.subject_name || listName) && <p class="muted small">{[l.subject_name, listName && pos >= 0 ? `${listName} · ${pos + 1} of ${list.length}` : ''].filter(Boolean).join(' · ')}</p>}
      </div>
      {l.bunny_video_id ? <ProtectedPlayer item={`L:${l.id}`} title={l.title} /> : <Flash kind="error">The video for this lecture isn’t uploaded yet.</Flash>}
      <section class="card" style="flex-direction:row;align-items:center;flex-wrap:wrap;gap:10px">
        {l.completed_at ? (
          <span class="tag" style="font-size:13px;padding:6px 12px"><Icon name="check_circle" size={16} />&nbsp;Watched</span>
        ) : (
          <form method="post" action={`/lectures/${l.id}/done`}>
            <input type="hidden" name="back" value={here} />
            <button class="btn btn-primary" type="submit"><Icon name="check" size={18} />Mark as watched</button>
          </form>
        )}
        <form method="post" action={`/lectures/${l.id}/save`}>
          <input type="hidden" name="back" value={here} />
          <button class="btn btn-outline" type="submit" aria-pressed={l.saved ? 'true' : 'false'}><Icon name={l.saved ? 'bookmark_fill' : 'bookmark'} size={18} />{l.saved ? 'Saved' : 'Save'}</button>
        </form>
        {!inWb && (
          <form method="post" action="/lectures/workbench/add">
            <input type="hidden" name="lecture" value={String(l.id)} />
            <input type="hidden" name="back" value={here} />
            <button class="btn btn-ghost" type="submit"><Icon name="queue_add" size={18} />Add to Workbench</button>
          </form>
        )}
        {(cardCount?.n ?? 0) > 0 && <a class="btn btn-ghost" href={`/cards?lecture=${l.id}`}><Icon name="cards" size={18} />{cardCount!.n} flash card{cardCount!.n === 1 ? '' : 's'}</a>}
      </section>
      {obj.length > 0 && (
        <section class="card">
          <div class="eyebrow" style="color:var(--body)">By the end of this lecture you should be able to</div>
          <ul class="checks">{obj.map((o) => <li><Icon name="check_circle" size={20} />{o}</li>)}</ul>
        </section>
      )}
      <div class="grid">
        {prev && (
          <a class="card continue" href={`/lectures/${prev.id}${suffix}`} style="text-decoration:none">
            <span class="ci"><Icon name="arrow_back" /></span>
            <span class="txt"><small>Previous · Day {prev.day_number}</small><strong>{prev.title}</strong></span>
          </a>
        )}
        {next && (
          <a class="card continue" href={`/lectures/${next.id}${suffix}`} style="text-decoration:none">
            <span class="txt"><small>{listName ? `Up next in ${listName}` : 'Next'} · Day {next.day_number}</small><strong>{next.title}</strong></span>
            <span class="ci"><Icon name="arrow_forward" /></span>
          </a>
        )}
      </div>
    </PortalLayout>,
  );
});

learn.post('/lectures/:id{[0-9]+}/done', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const ok = await c.env.DB.prepare(lectureAllowedSql).bind(id, await ownCohortId(c), isStaff(user) ? 1 : 0).first();
  if (ok) {
    await c.env.DB.prepare(
      `INSERT INTO lecture_progress (user_id, lecture_id, completed_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id, lecture_id) DO UPDATE SET completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now')`,
    )
      .bind(user.id, id)
      .run();
  }
  return c.redirect(safeBack(f.back, `/lectures/${id}`));
});
