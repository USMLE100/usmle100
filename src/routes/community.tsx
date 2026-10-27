import { EXAMS } from '../lib/profile';
import { Hono, type Context } from 'hono';
import type { AppEnv, User } from '../lib/types';
import { isAdmin, isStaff } from '../lib/types';
import { PortalLayout, PageHead, Flash } from '../views/layout';
import { Icon, type IconName } from '../views/icons';
import { getSettings } from '../lib/settings';
import { cohortDay, currentCohort, dayDate, fmtDate, money, todayUtc } from '../lib/content';
import { rewards, FREEZES } from '../lib/rewards';
import { hasBook } from '../lib/book';
import { eveningAccess } from '../lib/evening';
import { catalog, groupBySection, hasLength, runtimeLong, seconds } from '../lib/catalog';
import { ago } from '../lib/activity';
import { Calendar, lecturesFor } from './portal';
import { INCLUDES, INDIVIDUAL, KICKER, type Pkg } from './public';

/**
 * Ask the Room, Streaks & Milestones, search, onboarding, Plans, Portal Map, All Apps and Study Strategy articles.
 * Mounted after the portal router, so sign-in and enrollment checks apply.
 */
export const community = new Hono<AppEnv>();

const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const when = (utc: string) => ago(utc);
const paras = (t: string) => t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

// ---------- Ask the Room ----------

const REDDIT = 'https://www.reddit.com/r/step1/';
/** Posting limits per person per day, to keep spam out. */
const MAX_THREADS_PER_DAY = 10;
const MAX_REPLIES_PER_DAY = 60;

type Thread = {
  id: number; user_id: number; kind: string; title: string; body: string; section_id: number | null; status: string; hidden: number; created_at: string; last_activity_at: string;
  author: string; author_role: string; section: string | null; votes: number; voted: number; replies: number; staff_replies: number;
};

const THREAD_SQL = `SELECT t.*, u.name AS author, u.role AS author_role, s.title AS section,
  (SELECT COUNT(*) FROM thread_votes v WHERE v.thread_id = t.id) AS votes,
  (SELECT COUNT(*) FROM thread_votes v WHERE v.thread_id = t.id AND v.user_id = ?1) AS voted,
  (SELECT COUNT(*) FROM replies r WHERE r.thread_id = t.id AND r.hidden = 0) AS replies,
  (SELECT COUNT(*) FROM replies r WHERE r.thread_id = t.id AND r.hidden = 0 AND r.is_staff = 1) AS staff_replies
  FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN sections s ON s.id = t.section_id`;

/** Discussion threads are open to the class. Feedback is only for its author and staff. Hidden threads only for staff. */
const canSee = (t: { kind: string; user_id: number; hidden: number }, u: User) =>
  isStaff(u) || (!t.hidden && (t.kind === 'discussion' || t.user_id === u.id));

community.get('/ask', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const tab = c.req.query('tab') === 'feedback' ? 'feedback' : 'discussion';
  const filter = ['unanswered', 'faculty', 'mine'].includes(c.req.query('f') ?? '') ? c.req.query('f')! : 'all';
  const all = (await db.prepare(`${THREAD_SQL} ORDER BY t.last_activity_at DESC LIMIT 500`).bind(user.id).all<Thread>()).results.filter((t) => canSee(t, user));
  const inTab = all.filter((t) => t.kind === tab);
  const counts = {
    discussion: all.filter((t) => t.kind === 'discussion').length,
    feedback: all.filter((t) => t.kind === 'feedback').length,
    all: inTab.length,
    unanswered: inTab.filter((t) => !t.replies).length,
    faculty: inTab.filter((t) => t.staff_replies).length,
    mine: inTab.filter((t) => t.user_id === user.id).length,
  };
  const shown = inTab.filter((t) => (filter === 'unanswered' ? !t.replies : filter === 'faculty' ? t.staff_replies > 0 : filter === 'mine' ? t.user_id === user.id : true));
  const settings = await getSettings(db);
  const sections = (await db.prepare('SELECT x.id, x.title, s.name AS subject FROM sections x LEFT JOIN subjects s ON s.id = x.subject_id ORDER BY s.sort, x.sort').all<{ id: number; title: string; subject: string | null }>()).results;
  const href = (o: { tab?: string; f?: string }) => {
    const p = new URLSearchParams();
    const t = o.tab ?? tab;
    const f = o.f ?? filter;
    if (t !== 'discussion') p.set('tab', t);
    if (f !== 'all') p.set('f', f);
    return '/ask' + (p.toString() ? '?' + p : '');
  };
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Ask the Room" active="ask" user={user}>
      <PageHead eyebrow="Community" title="Class Discussion & Q&A" sub="Browse classmate questions, faculty explanations and clinical discussions." />
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card card-sage hub">
        <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap">
          <Icon name="groups" size={28} class="gic" />
          <div><h2>USMLE100 Community & Discussion Hub</h2><p class="small">Classroom Q&A with faculty and student commentary.</p></div>
        </div>
        <div class="row">
          <a class="btn btn-white" href={REDDIT} rel="noopener" target="_blank"><Icon name="forum" size={20} class="gic" />r/step1 Reddit Hub</a>
          {settings.blog_url && <a class="btn btn-white" href={settings.blog_url} rel="noopener" target="_blank"><Icon name="description" size={20} class="gic" />USMLE100 Clinical Blog</a>}
        </div>
      </section>
      <nav class="tabs" aria-label="Ask the Room">
        <a href={href({ tab: 'discussion', f: 'all' })} class={tab === 'discussion' ? 'on' : ''}>Discussion <small>{counts.discussion}</small></a>
        <a href={href({ tab: 'feedback', f: 'all' })} class={tab === 'feedback' ? 'on' : ''}>Feedback <small>{counts.feedback}</small></a>
      </nav>
      {tab === 'feedback' && <p class="muted small">Feedback goes to the USMLE100 team only. Other students can’t see it.</p>}
      <nav class="pills" aria-label="Filter">
        {([['all', 'All'], ['unanswered', 'Unanswered'], ['faculty', 'Faculty answered'], ['mine', 'Mine']] as const).map(([k, l]) => (
          <a href={href({ f: k })} class={filter === k ? 'on' : ''} aria-current={filter === k ? 'page' : undefined}>{l} <small>{counts[k]}</small></a>
        ))}
      </nav>
      <details class="new-q" open={!!c.req.query('new')}>
        <summary class="btn btn-primary"><Icon name="add" size={20} />{tab === 'feedback' ? 'New feedback' : 'New question'}</summary>
        <form method="post" action="/ask" class="card stack">
          <input type="hidden" name="kind" value={tab} />
          <label class="field">Title<input type="text" name="title" required minlength={5} maxlength={150} placeholder={tab === 'feedback' ? 'What should we improve?' : 'Sensitivity vs specificity — how do you keep the denominators straight?'} /></label>
          <label class="field">Details<textarea name="body" rows={5} required minlength={10} maxlength={5000}></textarea></label>
          {tab === 'discussion' && sections.length > 0 && (
            <label class="field">Topic (optional)
              <select name="section_id"><option value="">None</option>{sections.map((s) => <option value={String(s.id)} selected={Number(c.req.query('section')) === s.id}>{s.subject ? `${s.subject} · ` : ''}{s.title}</option>)}</select>
            </label>
          )}
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Post</button>
        </form>
      </details>
      {!shown.length && <p class="muted">{filter === 'all' ? (tab === 'feedback' ? 'No feedback yet.' : 'No questions yet. Be the first to ask.') : 'Nothing here.'}</p>}
      <div class="threads">
        {shown.map((t) => <ThreadCard t={t} />)}
      </div>
    </PortalLayout>,
  );
});

const ThreadCard = (p: { t: Thread }) => (
  <article class={'card thread' + (p.t.hidden ? ' is-hidden' : '')}>
    <form method="post" action={`/ask/${p.t.id}/vote`} class="vote">
      <input type="hidden" name="back" value="list" />
      <button type="submit" aria-pressed={p.t.voted ? 'true' : 'false'} aria-label={`${p.t.voted ? 'Remove your vote' : 'Vote up'} (${p.t.votes} votes)`}><Icon name="arrow_up" size={20} /><b>{p.t.votes}</b></button>
    </form>
    <div class="thread-body">
      <h2><a class="plain" href={`/ask/${p.t.id}`}>{p.t.title}</a></h2>
      <p class="excerpt">{p.t.body}</p>
      <div class="tags">
        {p.t.section && <span class="tag-soft">{p.t.section}</span>}
        {p.t.staff_replies > 0 && <span class="tag">Faculty Answered</span>}
        {p.t.kind === 'discussion' && (p.t.status === 'resolved' ? <span class="tag">Resolved</span> : <span class="chip chip-sand">Open</span>)}
        {p.t.hidden ? <span class="chip chip-rust">Hidden</span> : null}
        <span class="muted small">{p.t.replies} repl{p.t.replies === 1 ? 'y' : 'ies'} · {when(p.t.last_activity_at)}</span>
      </div>
    </div>
  </article>
);

async function postsToday(db: D1Database, table: 'threads' | 'replies', userId: number) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND created_at > datetime('now', '-1 day')`).bind(userId).first<{ n: number }>())?.n ?? 0;
}

community.post('/ask', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody();
  const kind = f.kind === 'feedback' ? 'feedback' : 'discussion';
  const title = str(f.title, 150);
  const body = str(f.body, 5000);
  const list = `/ask${kind === 'feedback' ? '?tab=feedback&' : '?'}`;
  if (title.length < 5 || body.length < 10) return c.redirect(list + 'error=' + encodeURIComponent('Add a title (5+ characters) and some details (10+ characters).'));
  if (!isStaff(user) && (await postsToday(c.env.DB, 'threads', user.id)) >= MAX_THREADS_PER_DAY) return c.redirect(list + 'error=' + encodeURIComponent('You’ve posted a lot today. Please try again tomorrow.'));
  const r = await c.env.DB.prepare('INSERT INTO threads (user_id, kind, title, body, section_id) VALUES (?, ?, ?, ?, ?)').bind(user.id, kind, title, body, kind === 'discussion' ? num(f.section_id) : null).run();
  return c.redirect(`/ask/${r.meta.last_row_id}`);
});

async function loadThread(c: Context<AppEnv>) {
  const user = c.get('user')!;
  const t = await c.env.DB.prepare(`${THREAD_SQL} WHERE t.id = ?2`).bind(user.id, Number(c.req.param('id'))).first<Thread>();
  return t && canSee(t, user) ? t : null;
}

community.get('/ask/:id{[0-9]+}', async (c) => {
  const user = c.get('user')!;
  const t = await loadThread(c);
  if (!t) return c.notFound();
  const staff = isStaff(user);
  const replies = (
    await c.env.DB.prepare('SELECT r.*, u.name AS author FROM replies r JOIN users u ON u.id = r.user_id WHERE r.thread_id = ? AND (r.hidden = 0 OR ?) ORDER BY r.created_at, r.id')
      .bind(t.id, staff ? 1 : 0)
      .all<{ id: number; user_id: number; body: string; is_staff: number; hidden: number; created_at: string; author: string }>()
  ).results;
  const mine = t.user_id === user.id;
  return c.html(
    <PortalLayout shell={c.get('shell')} title={t.title} active="ask" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/ask">Ask the Room</a><Icon name="chevron_right" size={16} />{t.kind === 'feedback' ? 'Feedback' : 'Discussion'}</nav>
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <article class="card thread thread-full">
        <form method="post" action={`/ask/${t.id}/vote`} class="vote">
          <button type="submit" aria-pressed={t.voted ? 'true' : 'false'} aria-label={`${t.voted ? 'Remove your vote' : 'Vote up'} (${t.votes} votes)`}><Icon name="arrow_up" size={20} /><b>{t.votes}</b></button>
        </form>
        <div class="thread-body">
          <h1 style="font-size:24px">{t.title}</h1>
          <p class="muted small">{t.author}{t.author_role !== 'student' ? ' · Faculty' : ''} · {when(t.created_at)}</p>
          <div class="note-body">{t.body}</div>
          <div class="tags">
            {t.section_id && <a class="tag-soft" href={`/topics/${t.section_id}`}>{t.section}</a>}
            {t.staff_replies > 0 && <span class="tag">Faculty Answered</span>}
            {t.kind === 'discussion' && (t.status === 'resolved' ? <span class="tag">Resolved</span> : <span class="chip chip-sand">Open</span>)}
            {t.hidden ? <span class="chip chip-rust">Hidden from students</span> : null}
          </div>
          <div class="row">
            {(mine || staff) && t.kind === 'discussion' && (
              <form method="post" action={`/ask/${t.id}/status`}><button class="btn btn-outline btn-sm" type="submit">{t.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></form>
            )}
            {(mine || staff) && (
              <form method="post" action={`/ask/${t.id}/delete`}><button class="btn btn-ghost btn-sm" type="submit">{staff && !mine ? (t.hidden ? 'Show again' : 'Hide') : 'Delete'}</button></form>
            )}
          </div>
        </div>
      </article>
      <h2 class="section-title">{replies.length} repl{replies.length === 1 ? 'y' : 'ies'}</h2>
      {replies.map((r) => (
        <article class={'card reply' + (r.is_staff ? ' staff' : '') + (r.hidden ? ' is-hidden' : '')}>
          <div class="row between" style="flex-wrap:nowrap">
            <p class="small"><strong>{r.author}</strong>{r.is_staff ? <span class="tag" style="margin-left:6px">Faculty</span> : null} <span class="muted">· {when(r.created_at)}</span></p>
            {(r.user_id === user.id || staff) && (
              <form method="post" action={`/ask/replies/${r.id}/delete`}><button class="link-btn" type="submit">{staff && r.user_id !== user.id ? (r.hidden ? 'Show' : 'Hide') : 'Delete'}</button></form>
            )}
          </div>
          <div class="note-body plain-body">{r.body}</div>
        </article>
      ))}
      <form method="post" action={`/ask/${t.id}/reply`} class="card stack">
        <label class="field">{staff ? 'Reply as faculty' : 'Your reply'}<textarea name="body" rows={4} required minlength={2} maxlength={5000}></textarea></label>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start"><Icon name="send" size={18} />Reply</button>
      </form>
    </PortalLayout>,
  );
});

community.post('/ask/:id{[0-9]+}/reply', async (c) => {
  const user = c.get('user')!;
  const t = await loadThread(c);
  if (!t) return c.notFound();
  const body = str((await c.req.parseBody()).body, 5000);
  if (body.length < 2) return c.redirect(`/ask/${t.id}`);
  if (!isStaff(user) && (await postsToday(c.env.DB, 'replies', user.id)) >= MAX_REPLIES_PER_DAY) return c.redirect(`/ask/${t.id}?error=` + encodeURIComponent('You’ve replied a lot today. Please try again tomorrow.'));
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO replies (thread_id, user_id, body, is_staff) VALUES (?, ?, ?, ?)').bind(t.id, user.id, body, isStaff(user) ? 1 : 0),
    c.env.DB.prepare("UPDATE threads SET last_activity_at = datetime('now') WHERE id = ?").bind(t.id),
  ]);
  return c.redirect(`/ask/${t.id}`);
});

community.post('/ask/:id{[0-9]+}/vote', async (c) => {
  const user = c.get('user')!;
  const t = await loadThread(c);
  if (!t) return c.notFound();
  const f = await c.req.parseBody();
  await c.env.DB.prepare(t.voted ? 'DELETE FROM thread_votes WHERE user_id = ? AND thread_id = ?' : 'INSERT OR IGNORE INTO thread_votes (user_id, thread_id) VALUES (?, ?)').bind(user.id, t.id).run();
  const ref = c.req.header('referer') ?? '';
  return c.redirect(f.back === 'list' && /\/ask(\?|$)/.test(ref) ? new URL(ref).pathname + new URL(ref).search : `/ask/${t.id}`);
});

community.post('/ask/:id{[0-9]+}/status', async (c) => {
  const user = c.get('user')!;
  const t = await loadThread(c);
  if (!t || (t.user_id !== user.id && !isStaff(user))) return c.notFound();
  await c.env.DB.prepare('UPDATE threads SET status = ? WHERE id = ?').bind(t.status === 'resolved' ? 'open' : 'resolved', t.id).run();
  return c.redirect(`/ask/${t.id}`);
});

/** Authors delete their own thread. Staff hide (or show again) anyone else's. */
community.post('/ask/:id{[0-9]+}/delete', async (c) => {
  const user = c.get('user')!;
  const t = await loadThread(c);
  if (!t) return c.notFound();
  if (t.user_id === user.id) {
    await c.env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(t.id).run();
    return c.redirect('/ask?ok=' + encodeURIComponent('Deleted.'));
  }
  if (!isStaff(user)) return c.notFound();
  await c.env.DB.prepare('UPDATE threads SET hidden = 1 - hidden WHERE id = ?').bind(t.id).run();
  return c.redirect(`/ask/${t.id}`);
});

community.post('/ask/replies/:rid{[0-9]+}/delete', async (c) => {
  const user = c.get('user')!;
  const r = await c.env.DB.prepare('SELECT r.id, r.user_id, r.thread_id, t.kind, t.user_id AS owner, t.hidden FROM replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?')
    .bind(Number(c.req.param('rid')))
    .first<{ id: number; user_id: number; thread_id: number; kind: string; owner: number; hidden: number }>();
  if (!r || !canSee({ kind: r.kind, user_id: r.owner, hidden: r.hidden }, user)) return c.notFound();
  if (r.user_id === user.id) await c.env.DB.prepare('DELETE FROM replies WHERE id = ?').bind(r.id).run();
  else if (isStaff(user)) await c.env.DB.prepare('UPDATE replies SET hidden = 1 - hidden WHERE id = ?').bind(r.id).run();
  else return c.notFound();
  return c.redirect(`/ask/${r.thread_id}`);
});

// ---------- Streaks & Milestones ----------

community.get('/rewards', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const cohort = await currentCohort(db, c.get('enrollment')?.cohort_id);
  const day100 = cohort ? todayUtc() >= dayDate(cohort, cohort.total_days).getTime() : false;
  const r = await rewards(db, user.id, cohort, day100);
  const lectures = cohort ? await lecturesFor(db, cohort.id, user.id) : [];
  const lPct = r.total ? Math.round((r.lectures / r.total) * 100) : 0;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Streaks & Milestones" active="rewards" user={user} wide>
      <PageHead eyebrow="Progress" title="Streaks & Milestones" sub={`Track your daily study consistency and ${r.total}-day curriculum milestones.`} />
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));align-items:start;gap:16px">
        <section class="card card-sage">
          <div class="streak-big"><Icon name="fire" size={36} class={r.streak ? 'flame on' : 'flame'} />{r.streak}</div>
          <span class="small">day streak</span>
          <div class="bar"><i style={`width:${lPct}%`}></i></div>
          <p class="small">{r.lectures} of {r.total} lectures · longest streak {r.longest} day{r.longest === 1 ? '' : 's'}</p>
          <div class="freeze">
            <span><Icon name="freeze" size={20} class="gic" /> {r.freezesLeft} streak freeze{r.freezesLeft === 1 ? '' : 's'} available</span>
            <form method="post" action="/rewards/freeze"><button class="btn btn-soft btn-sm" type="submit" disabled={!r.canFreeze}>Use freeze</button></form>
          </div>
          <p class="small muted">A streak freeze protects your streak when you miss a day: use it the day after. You have {FREEZES} in total.</p>
        </section>
        <section class="card card-cream">
          <div class="row" style="gap:12px"><span class="badge" style="font-size:13px;padding:6px 14px">Level {r.level}</span><span class="xp"><b>{r.xp}</b> XP</span></div>
          <div class="bar bar-cream2"><i style={`width:${r.levelPct}%`}></i></div>
          <p class="small">{r.toNext} XP to Level {r.level + 1}</p>
          <div class="counters">
            <span><b>{r.lectures}</b>of {r.total} lectures</span>
            <span><b>{r.minutes}</b>minutes watched</span>
            <span><b>{r.earned}</b>badges earned</span>
          </div>
          <p class="small muted">Earn 10 XP per completed lecture and 15 XP for each day that continues your streak.</p>
        </section>
      </div>
      {cohort && (
        <section class="card">
          <div class="sched-head">
            <span class="sched-num">{r.lectures}<small>/{r.total}</small></span>
            <span><strong>Lectures completed</strong><span>{r.total}-day structured study schedule</span></span>
          </div>
          <div class="bar"><i style={`width:${lPct}%`}></i></div>
          <Calendar cohort={cohort} lectures={lectures} />
        </section>
      )}
      <h2 class="section-title">Course Badges <small class="muted">{r.earned} / {r.badges.length}</small></h2>
      <div class="badges">
        {r.badges.map((b) => (
          <article class={'badge-card' + (b.earned ? ' earned' : '')}>
            <span class="bi"><Icon name={b.icon} size={26} /></span>
            <strong>{b.name}</strong>
            <span class="small">{b.desc}</span>
            <div class="bar"><i style={`width:${b.pct}%`}></i></div>
            <span class="small muted">{b.earned ? 'Earned' : `${b.pct}%`}</span>
          </article>
        ))}
      </div>
    </PortalLayout>,
  );
});

community.post('/rewards/freeze', async (c) => {
  const user = c.get('user')!;
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const r = await rewards(c.env.DB, user.id, cohort, false);
  if (r.canFreeze) await c.env.DB.prepare('INSERT OR IGNORE INTO streak_freezes (user_id, day) VALUES (?, ?)').bind(user.id, r.freezeDay).run();
  return c.redirect('/rewards?ok=' + encodeURIComponent(r.canFreeze ? 'Freeze used. Your streak is safe.' : 'There is no missed day to cover right now.'));
});

// ---------- Search ----------

type Hit = { href: string; title: string; detail: string; icon: IconName };

const PAGES: Hit[] = [
  { href: '/dashboard', title: 'Home', detail: 'Today’s goal, streak and study schedule', icon: 'home' },
  { href: '/lectures', title: 'Lectures', detail: 'Browse every lecture by section', icon: 'play_circle' },
  { href: '/lectures/workbench', title: 'Workbench', detail: 'Build your own study session', icon: 'queue_add' },
  { href: '/lectures/path', title: 'Path', detail: 'Your progress through every subject', icon: 'route' },
  { href: '/topics', title: 'Topics', detail: 'High-yield sections with objectives', icon: 'menu_book' },
  { href: '/course-book', title: 'USMLE100 Book', detail: 'Chapters and PDF handouts', icon: 'book' },
  { href: '/warmup', title: 'Daily Warmup', detail: '10 questions a day', icon: 'bolt' },
  { href: '/qbank', title: 'Question Bank', detail: 'Quick blocks and custom tests', icon: 'quiz' },
  { href: '/create-test', title: 'Create a Test', detail: 'Choose pools, subjects and systems', icon: 'filter' },
  { href: '/cards', title: 'Flash Cards', detail: 'Spaced repetition from your classes', icon: 'cards' },
  { href: '/review', title: 'Review', detail: 'Missed lectures, questions and cards', icon: 'replay' },
  { href: '/evening', title: 'Evening Questions', detail: 'Mon · Wed · Fri recordings', icon: 'videocam' },
  { href: '/performance', title: 'Performance', detail: 'Scores by system and discipline', icon: 'monitoring' },
  { href: '/rewards', title: 'Rewards', detail: 'Streaks, XP and badges', icon: 'trophy' },
  { href: '/notes', title: 'My Notes', detail: 'Your notes and faculty handouts', icon: 'edit_note' },
  { href: '/ask', title: 'Ask the Room', detail: 'Class discussion and Q&A', icon: 'forum' },
  { href: '/book', title: '1-on-1 Tutoring', detail: 'Book a session with Dr. Khan', icon: 'event' },
  { href: '/exam-window', title: 'Exam Window', detail: 'Days 91 to 100 checklist', icon: 'calendar' },
  { href: '/plans', title: 'Plans', detail: 'Your plan and add-ons', icon: 'premium' },
  { href: '/programs', title: 'Programs', detail: 'Packages and prices', icon: 'premium' },
];

community.get('/search', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const q = str(c.req.query('q'), 80);
  const like = '%' + q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const groups: { name: string; hits: Hit[] }[] = [];
  if (q.length >= 2) {
    const cohort = await currentCohort(db, c.get('enrollment')?.cohort_id);
    const staff = isStaff(user);
    const [lec, sec, notes, threads] = await Promise.all([
      cohort
        ? db.prepare(`SELECT id, day_number, title FROM lectures WHERE cohort_id = ? AND (status = 'live' OR ?) AND (lower(title) LIKE ? ESCAPE '\\' OR lower(COALESCE(objectives, '')) LIKE ? ESCAPE '\\') ORDER BY day_number LIMIT 20`)
            .bind(cohort.id, staff ? 1 : 0, like, like).all<{ id: number; day_number: number; title: string }>()
        : null,
      db.prepare(`SELECT x.id, x.title, s.name AS subject FROM sections x LEFT JOIN subjects s ON s.id = x.subject_id WHERE lower(x.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(s.name, '')) LIKE ? ESCAPE '\\' LIMIT 20`)
        .bind(like, like).all<{ id: number; title: string; subject: string | null }>(),
      db.prepare(`SELECT id, title FROM notes WHERE (user_id = ? OR is_faculty = 1) AND (lower(title) LIKE ? ESCAPE '\\' OR lower(COALESCE(body, '')) LIKE ? ESCAPE '\\') LIMIT 20`)
        .bind(user.id, like, like).all<{ id: number; title: string }>(),
      db.prepare(`SELECT id, title, kind, user_id, hidden FROM threads WHERE (lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\') ORDER BY last_activity_at DESC LIMIT 40`)
        .bind(like, like).all<{ id: number; title: string; kind: string; user_id: number; hidden: number }>(),
    ]);
    if (lec?.results.length) groups.push({ name: 'Lectures', hits: lec.results.map((l) => ({ href: `/lectures/${l.id}`, title: l.title, detail: `Day ${l.day_number}`, icon: 'play_circle' })) });
    if (sec.results.length) groups.push({ name: 'Topics', hits: sec.results.map((s) => ({ href: `/topics/${s.id}`, title: s.title, detail: s.subject ?? 'Topic', icon: 'menu_book' })) });
    if (await hasBook(db, user, c.get('enrollment'))) {
      const ch = await db.prepare(`SELECT id, number, title FROM book_chapters WHERE status = 'live' AND (lower(title) LIKE ? ESCAPE '\\' OR lower(COALESCE(description, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(topics, '')) LIKE ? ESCAPE '\\') LIMIT 20`)
        .bind(like, like, like).all<{ id: number; number: number; title: string }>();
      if (ch.results.length) groups.push({ name: 'USMLE100 Book', hits: ch.results.map((x) => ({ href: `/course-book/${x.id}`, title: x.title, detail: `Chapter ${x.number}`, icon: 'book' })) });
    }
    const acc = await eveningAccess(db, user);
    if (acc) {
      const ev = await db.prepare(`SELECT id, session_date, title FROM evening_sessions WHERE status = 'live' AND lower(title) LIKE ? ESCAPE '\\' ORDER BY session_date DESC LIMIT 20`).bind(like).all<{ id: number; session_date: string; title: string }>();
      const vis = ev.results.filter((e) => acc.staff || acc.visible.has(e.id));
      if (vis.length) groups.push({ name: 'Evening Questions', hits: vis.map((e) => ({ href: `/evening/${e.id}`, title: e.title, detail: fmtDate(new Date(e.session_date + 'T00:00:00Z')), icon: 'videocam' })) });
    }
    if (notes.results.length) groups.push({ name: 'Notes', hits: notes.results.map((n) => ({ href: '/notes?q=' + encodeURIComponent(q), title: n.title, detail: 'Note', icon: 'edit_note' })) });
    const th = threads.results.filter((t) => canSee(t, user)).slice(0, 20);
    if (th.length) groups.push({ name: 'Ask the Room', hits: th.map((t) => ({ href: `/ask/${t.id}`, title: t.title, detail: t.kind === 'feedback' ? 'Feedback' : 'Discussion', icon: 'forum' })) });
    const pages = PAGES.filter((p) => (p.title + ' ' + p.detail).toLowerCase().includes(q.toLowerCase()));
    if (pages.length) groups.push({ name: 'Pages', hits: pages });
  }
  const total = groups.reduce((a, g) => a + g.hits.length, 0);
  return c.html(
    <PortalLayout shell={c.get('shell')} title={q ? `Search: ${q}` : 'Search'} active="search" user={user}>
      <h1>Search</h1>
      <form method="get" action="/search" role="search">
        <label class="filter-box big"><Icon name="search" size={22} /><span class="sr">Search USMLE100</span><input type="search" name="q" value={q} placeholder="Lectures, topics, chapters, notes, discussions…" autofocus /></label>
      </form>
      {q && q.length < 2 && <p class="muted">Type at least 2 letters.</p>}
      {q.length >= 2 && <p class="small muted">{total} result{total === 1 ? '' : 's'} for “{q}”</p>}
      {groups.map((g) => (
        <section class="stack" style="gap:8px">
          <h2 class="section-title">{g.name}</h2>
          <div class="hits">
            {g.hits.map((h) => (
              <a class="hit" href={h.href}><Icon name={h.icon} size={22} class="gic" /><span><strong>{h.title}</strong><small>{h.detail}</small></span><Icon name="chevron_right" class="chev" /></a>
            ))}
          </div>
        </section>
      ))}
      {q.length >= 2 && !total && <p class="muted">Nothing found. Try a different word.</p>}
    </PortalLayout>,
  );
});

// ---------- All Apps and Portal Map ----------

community.get('/apps', (c) => {
  const apps: [string, IconName, string, string][] = [
    ['/lectures', 'play_circle', 'Lectures', 'Video library & workbench'],
    ['/course-book', 'book', 'USMLE100 Book', 'Comprehensive course book'],
    ['/qbank', 'quiz', 'Question Bank', 'Custom tests & warmup'],
    ['/cards', 'cards', 'Flash Cards', 'Spaced repetition'],
    ['/ask', 'groups', 'Discussion Hub', 'Community Q&A & Reddit'],
    ['/performance', 'monitoring', 'Performance', 'Systems & disciplines'],
    ['/evening', 'videocam', 'Evening Questions', 'Mon · Wed · Fri recordings'],
    ['/notes', 'edit_note', 'My Notes', 'Notes & faculty handouts'],
  ];
  return c.html(
    <PortalLayout shell={c.get('shell')} title="All Apps" active="apps" user={c.get('user')!}>
      <section class="card page-card">
        <div class="page-head"><div class="eyebrow">Apps</div><h1>All Apps</h1><p>All active learning tools in the USMLE100 portal.</p></div>
        <div class="apps">
          {apps.map(([href, icon, name, sub]) => (
            <a class="app-tile" href={href}><Icon name={icon} size={28} class="gic" /><strong>{name}</strong><span>{sub}</span></a>
          ))}
        </div>
      </section>
    </PortalLayout>,
  );
});

community.get('/map', (c) => {
  const groups: [string, string[]][] = [
    ['Study', ['/lectures', '/lectures/workbench', '/lectures/path', '/topics', '/course-book', '/warmup', '/qbank', '/create-test', '/cards', '/review', '/evening']],
    ['Progress', ['/dashboard', '/performance', '/rewards', '/notes', '/exam-window']],
    ['Help', ['/ask', '/book', '/plans', '/programs']],
  ];
  const by = new Map(PAGES.map((p) => [p.href, p]));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Portal Map" active="map" user={c.get('user')!}>
      <PageHead eyebrow="Help" title="Portal Map" sub="Every part of the USMLE100 portal in one place." />
      {groups.map(([name, hrefs]) => (
        <section class="stack" style="gap:8px">
          <h2 class="section-title">{name}</h2>
          <div class="hits">
            {hrefs.map((h) => by.get(h)!).map((p) => (
              <a class="hit" href={p.href}><Icon name={p.icon} size={22} class="gic" /><span><strong>{p.title}</strong><small>{p.detail}</small></span><Icon name="chevron_right" class="chev" /></a>
            ))}
          </div>
        </section>
      ))}
    </PortalLayout>,
  );
});

// ---------- Plans ----------

community.get('/plans', async (c) => {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  const tab = c.req.query('tab') === 'individual' ? 'individual' : 'packages';
  const pkgs = (await c.env.DB.prepare('SELECT * FROM packages ORDER BY sort').all<Pkg>()).results;
  const settings = await getSettings(c.env.DB);
  const ask = (subject: string) => (settings.contact_email ? `mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: ' + subject)}` : '/programs');
  const short = (n: string) => n.replace('USMLE100 ', '');
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Plans" active="plans" user={user} wide>
      <PageHead eyebrow="Course plans" title="Select Your Preparation Plan" sub="Compare one-time enrollment plans and standalone courses." />
      <div class="seg">
        <a href="/plans" class={tab === 'packages' ? 'on' : ''} aria-current={tab === 'packages' ? 'page' : undefined}>Full Preparation Packages</a>
        <a href="/plans?tab=individual" class={tab === 'individual' ? 'on' : ''} aria-current={tab === 'individual' ? 'page' : undefined}>Individual Courses & Add-Ons</a>
      </div>
      {tab === 'packages' ? (
        <div class="pkgs">
          {pkgs.map((p) => {
            const current = enr?.package_id === p.id;
            const list = (INCLUDES[p.id] ?? []).filter((i) => !i.startsWith('Everything'));
            return (
              <section class={'card pkg' + (current ? ' rec' : '')}>
                <div class="row between" style="align-items:flex-start;flex-wrap:nowrap">
                  {KICKER[p.id] && <div class="kick">{KICKER[p.id]}</div>}
                  {current && <span class="badge" style="flex:none">Current Plan</span>}
                </div>
                <h2>{p.name}</h2>
                <div class="price" style="border:0;padding:0"><b>{money(p.price_cents)}</b><span>one-time</span></div>
                <p class="tagline">{p.tagline}</p>
                {(p.evening_q_months > 0 || p.one_on_one_sessions > 0) && (
                  <div class="counts-big">
                    {p.evening_q_months > 0 && <span><b>{p.evening_q_months}</b>months of Evening Q’s</span>}
                    {p.one_on_one_sessions > 0 && <span><b>{p.one_on_one_sessions}</b>1-on-1 sessions</span>}
                  </div>
                )}
                {current ? (
                  <button class="btn btn-block btn-disabled" type="button" disabled>Current Plan</button>
                ) : enr ? (
                  <a class="btn btn-primary btn-block" href={ask(`switching to ${p.name}`)}>Ask about {short(p.name)}</a>
                ) : (
                  <form method="post" action={`/enroll/${p.id}`}><button class="btn btn-primary btn-block" type="submit">Select {short(p.name)}</button></form>
                )}
                <details class="more">
                  <summary>View included features ({list.length}) <Icon name="down" size={18} /></summary>
                  <ul class="checks" style="margin-top:12px">{list.map((i) => <li><Icon name="check_circle" size={20} />{i}</li>)}</ul>
                </details>
              </section>
            );
          })}
        </div>
      ) : (
        <div class="addons">
          {INDIVIDUAL.map((i, k) => (
            <div class={'addon ' + ['tile-olive', 'tile-warm', 'tile-sky'][k % 3]}>
              <h3>{i.name}</h3>
              <span class="p">{i.price} <small>{i.unit}</small></span>
              <p>{i.desc}</p>
              {i.name === 'USMLE100 Course Book' ? <a class="btn btn-primary" href="/buy/course-book">Buy the Course Book</a> : <a class="btn btn-outline" href={ask(i.name)}>Inquire about {i.name}</a>}
            </div>
          ))}
        </div>
      )}
      {enr && <p class="small muted">To change your plan, use the button on the plan you want and we’ll reply by email.</p>}
    </PortalLayout>,
  );
});

// ---------- Onboarding ----------

const WHEN: [string, string, number][] = [['1m', 'In 1 month', 30], ['3m', '3 months', 91], ['6m', '6 months', 182], ['1y', '1 year', 365]];

community.get('/welcome', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  if (!c.req.query('step') && (user.onboarded_at || isStaff(user))) return c.redirect('/dashboard');
  const step = Math.min(3, Math.max(1, Number(c.req.query('step')) || 1));
  const Steps = () => (
    <div class="steps" aria-hidden="true">{[1, 2, 3].map((n) => <i class={n <= step ? 'on' : ''}></i>)}</div>
  );
  let body;
  if (step === 1) {
    body = (
      <>
        <Steps />
        <div class="eyebrow" style="color:var(--body)">Step 1 of 3</div>
        <h1>Welcome, {user.name.split(' ')[0]}.</h1>
        <p class="muted">A few quick questions so the portal can plan around your exam instead of handing you a catalogue.</p>
        <div class="wave"><Icon name="wave" size={64} /></div>
        <div class="row between" style="border-top:1px solid var(--line);padding-top:18px">
          <form method="post" action="/welcome/skip"><button class="link-btn" type="submit">Skip for now</button></form>
          <a class="btn btn-primary" href="/welcome?step=2">Continue</a>
        </div>
      </>
    );
  } else if (step === 2) {
    const u = await db.prepare('SELECT exam, exam_date FROM users WHERE id = ?').bind(user.id).first<{ exam: string | null; exam_date: string | null }>();
    body = (
      <form method="post" action="/welcome/exam" class="stack" style="gap:16px">
        <Steps />
        <div class="eyebrow" style="color:var(--body)">Step 2 of 3</div>
        <fieldset class="bare"><legend><h1>Which exam?</h1></legend>
          <div class="choice-chips">{EXAMS.map((e, i) => <label><input type="radio" name="exam" value={e} checked={u?.exam ? u.exam === e : i === 0} /><span>{e}</span></label>)}</div>
        </fieldset>
        <fieldset class="bare"><legend><h2>When is it?</h2></legend>
          <p class="muted small">You can change it later.</p>
          <div class="choice-chips">{WHEN.map(([k, l]) => <label><input type="radio" name="when" value={k} /><span>{l}</span></label>)}</div>
          <label class="field" style="margin-top:12px">Exam date<input type="date" name="exam_date" value={u?.exam_date ?? ''} /></label>
          <label class="check" style="margin-top:8px"><input type="radio" name="when" value="none" /> I don’t have a date yet</label>
        </fieldset>
        <div class="row between" style="border-top:1px solid var(--line);padding-top:18px">
          <a class="link-btn" href="/welcome?step=1">Back</a>
          <button class="btn btn-primary" type="submit">Continue</button>
        </div>
      </form>
    );
  } else {
    const cohort = await currentCohort(db, c.get('enrollment')?.cohort_id);
    const cat = cohort ? await catalog(db, cohort.id, user.id) : null;
    const focus = new Set((await db.prepare('SELECT subject_id FROM user_focus_subjects WHERE user_id = ?').bind(user.id).all<{ subject_id: number }>()).results.map((x) => x.subject_id));
    const subjects = (await db.prepare('SELECT id, name FROM subjects ORDER BY sort').all<{ id: number; name: string }>()).results;
    const live = cat ? cat.lectures.filter((l) => l.status === 'live') : [];
    const groups = cat ? groupBySection(live, cat.sections, cat.subjects) : [];
    const withLectures = subjects.filter((s) => live.some((l) => l.subject_id === s.id));
    const list = withLectures.length ? withLectures : subjects;
    body = (
      <form method="post" action="/welcome/start" class="stack" style="gap:16px">
        <Steps />
        <div class="eyebrow" style="color:var(--body)">Step 3 of 3</div>
        <h1>Where do you want to start?</h1>
        <p class="muted">Pick the subjects you’re weakest in. They’ll lead your path.</p>
        <div class="opt-list">
          {list.map((s) => {
            const ls = live.filter((l) => l.subject_id === s.id);
            const secs = groups.filter((g) => g.subject_id === s.id && g.section).length;
            return (
              <label class="opt">
                <input type="checkbox" name="subject" value={String(s.id)} checked={focus.has(s.id)} />
                <span class="ot"><strong>{s.name}</strong><span>{ls.length ? `${secs ? `${secs} section${secs === 1 ? '' : 's'} · ` : ''}${ls.length} lecture${ls.length === 1 ? '' : 's'}${hasLength(ls) ? ` · ${runtimeLong(seconds(ls))}` : ''}` : 'Lectures coming soon'}</span></span>
              </label>
            );
          })}
        </div>
        <div class="row between" style="border-top:1px solid var(--line);padding-top:18px">
          <a class="link-btn" href="/welcome?step=2">Back</a>
          <button class="btn btn-primary" type="submit"><Icon name="arrow_forward" size={18} />Start studying</button>
        </div>
      </form>
    );
  }
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Welcome" active="home" user={user}>
      <section class="card onboard">{body}</section>
    </PortalLayout>,
  );
});

community.post('/welcome/exam', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody();
  const exam = EXAMS.includes(String(f.exam)) ? String(f.exam) : null;
  let date: string | null = /^\d{4}-\d{2}-\d{2}$/.test(String(f.exam_date ?? '')) ? String(f.exam_date) : null;
  const w = WHEN.find(([k]) => k === f.when);
  if (w) date = new Date(todayUtc() + w[2] * 86400_000).toISOString().slice(0, 10);
  if (f.when === 'none') date = null;
  await c.env.DB.prepare('UPDATE users SET exam = ?, exam_date = ? WHERE id = ?').bind(exam, date, user.id).run();
  return c.redirect('/welcome?step=3');
});

community.post('/welcome/start', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody({ all: true });
  const ids = (Array.isArray(f.subject) ? f.subject : f.subject ? [f.subject] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  const valid = ids.length ? (await c.env.DB.prepare(`SELECT id FROM subjects WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: number }>()).results.map((r) => r.id) : [];
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM user_focus_subjects WHERE user_id = ?').bind(user.id),
    ...valid.map((id) => c.env.DB.prepare('INSERT INTO user_focus_subjects (user_id, subject_id) VALUES (?, ?)').bind(user.id, id)),
    c.env.DB.prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, datetime('now')) WHERE id = ?").bind(user.id),
  ]);
  return c.redirect('/lectures/path');
});

community.post('/welcome/skip', async (c) => {
  await c.env.DB.prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, datetime('now')) WHERE id = ?").bind(c.get('user')!.id).run();
  return c.redirect('/dashboard');
});

// ---------- Study Strategy articles ----------

community.get('/articles/:id{[0-9]+}', async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM articles WHERE id = ? AND (status = 'live' OR ?)").bind(Number(c.req.param('id')), isAdmin(c.get('user')) ? 1 : 0).first<any>();
  if (!a) return c.notFound();
  return c.html(
    <PortalLayout shell={c.get('shell')} title={a.title} active="home" user={c.get('user')!}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/dashboard">Home</a><Icon name="chevron_right" size={16} />Study strategy</nav>
      <article class="card article">
        {a.kicker && <div class="eyebrow">{a.kicker}</div>}
        <h1>{a.title}</h1>
        {a.author && <p class="small"><strong>{a.author}</strong></p>}
        {a.summary && <p class="lead-p">{a.summary}</p>}
        {paras(a.body ?? '').map((p) => <p>{p}</p>)}
      </article>
    </PortalLayout>,
  );
});

export const _unused = cohortDay;
