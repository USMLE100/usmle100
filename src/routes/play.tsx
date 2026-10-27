import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { requireUser } from '../lib/auth';
import { bunnyEmbedUrl } from '../lib/content';
import { audit } from '../lib/audit';
import { PortalLayout, PageHead, Flash } from '../views/layout';
import { Icon } from '../views/icons';
import { ProtectedPlayer } from '../views/player';
import { clock } from '../lib/catalog';
import { accessFor, claimTab, getLecture, lastPosition, openOrCreate, recordBeat, releaseTab, viewState, type Beat } from '../lib/viewing';

/**
 * Protected playback (lib/viewing) and the free preview lectures. Mounted before the portal router,
 * so students without a program (or with only the Course Book / Evening Questions) can use free lectures.
 */
export const play = new Hono<AppEnv>();

async function body(c: Context<AppEnv>): Promise<any> {
  try {
    return JSON.parse(await c.req.text());
  } catch {
    return {};
  }
}
const noStore = (c: Context<AppEnv>) => c.header('Cache-Control', 'no-store');

const NOTICE_PAID =
  'Before you start: each lecture can be watched a limited number of times. A viewing lasts 24 hours from when you press play. It counts as one view when you have watched 65% of the lecture, or when its 24 hours end. You can pause, press End Lecture and come back within those 24 hours without using another view. Lectures are for you alone: your name and account number appear on the video, and recording or sharing them is not allowed.';
const NOTICE_FREE =
  'Before you start: free preview lectures can be watched 2 times. A viewing lasts 24 hours from when you press play. It counts as one view when you have watched 65% of the lecture, or when its 24 hours end. You can pause, press End Lecture and come back within those 24 hours without using another view. Your name and account number appear on the video, and recording or sharing it is not allowed.';

/** Open (or resume) a viewing of a lecture in this tab: returns a short-lived video link only if allowed. */
play.post('/play/claim', async (c) => {
  noStore(c);
  const user = c.get('user');
  if (!user) return c.json({ state: 'signin' }, 401);
  const db = c.env.DB;
  const b = await body(c);
  const tab = typeof b.tab === 'string' && /^[0-9a-f]{8,64}$/.test(b.tab) ? b.tab : null;
  const l = await getLecture(db, Number(b.lecture));
  if (!l || !tab) return c.json({ state: 'gone' }, 404);
  const a = await accessFor(db, user, c.get('enrollment'), l);
  if (!a) return c.json({ state: 'gone' }, 403);
  if (!l.bunny_video_id) return c.json({ state: 'novideo', message: 'The video for this lecture isn’t uploaded yet.' });
  const wm = (code: string) => ({ name: user.name, id: user.id, code });

  if (a.kind === 'staff') {
    const src = await bunnyEmbedUrl(c.env, l.bunny_video_id);
    if (!src) return c.json({ state: 'novideo', message: 'This video can’t be played right now. Please try again later.' });
    return c.json({ state: 'ok', sid: 'staff', nonce: 'staff', src, pos: 0, first: false, wm: wm('STAFF') });
  }

  const v = await openOrCreate(db, user.id, l.id, a);
  if (!v.session) {
    const requested = !!(await db.prepare('SELECT 1 FROM view_requests WHERE user_id = ? AND lecture_id = ? AND resolved_at IS NULL').bind(user.id, l.id).first());
    return c.json({ state: 'locked', allowed: v.allowed, used: v.used, request: true, requested });
  }
  const t = await claimTab(db, user.id, tab, l.id, v.session.id);
  if (!t.ok) return c.json({ state: 'busy', title: t.title });
  const src = await bunnyEmbedUrl(c.env, l.bunny_video_id);
  if (!src) return c.json({ state: 'novideo', message: 'This video can’t be played right now. Please try again later.' });
  return c.json({
    state: 'ok',
    sid: v.session.id,
    nonce: t.nonce,
    src,
    pos: await lastPosition(db, user.id, l.id),
    // The rules are shown before the first playback of each lecture (R054).
    first: v.history === 0 && !v.session.started_at,
    notice: a.kind === 'free' ? NOTICE_FREE : NOTICE_PAID,
    wm: wm(v.session.id),
  });
});

play.post('/play/beat', async (c) => {
  noStore(c);
  const user = c.get('user');
  if (!user) return c.json({ state: 'signin' }, 401);
  const b = await body(c);
  const beat: Beat = {
    sid: String(b.sid ?? ''),
    tab: String(b.tab ?? ''),
    nonce: String(b.nonce ?? ''),
    playing: b.playing === true,
    pos: Number(b.pos),
    dur: Number(b.dur),
    add: Array.isArray(b.add) ? b.add : [],
  };
  return c.json(await recordBeat(c.env.DB, user, c.get('enrollment'), beat));
});

/** End Lecture, or the tab closing: frees the one-tab slot at once. The viewing session stays open. */
play.post('/play/release', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false }, 401);
  const b = await body(c);
  if (typeof b.tab === 'string') await releaseTab(c.env.DB, user.id, b.tab);
  return c.json({ ok: true });
});

/** A student who has used every view asks for more. Admins review; only the owner grants. */
play.post('/play/request', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ ok: false }, 401);
  const db = c.env.DB;
  const l = await getLecture(db, Number((await body(c)).lecture));
  if (!l) return c.json({ ok: false }, 404);
  const a = await accessFor(db, user, c.get('enrollment'), l);
  if (!a || a.kind === 'staff') return c.json({ ok: false }, 403);
  const v = await viewState(db, user.id, l.id, a);
  if (v.used < v.allowed || v.open) return c.json({ ok: false, reason: 'views left' }, 400);
  const open = await db.prepare('SELECT 1 FROM view_requests WHERE user_id = ? AND lecture_id = ? AND resolved_at IS NULL').bind(user.id, l.id).first();
  if (!open) {
    await db.prepare('INSERT INTO view_requests (user_id, lecture_id, kind) VALUES (?, ?, ?)').bind(user.id, l.id, a.kind).run();
    await audit(db, { actorId: user.id, action: 'views.requested', targetUserId: user.id, detail: { lecture: l.id, kind: a.kind }, ip: c.req.header('cf-connecting-ip') ?? null });
  }
  return c.json({ ok: true });
});

// ---------- Free preview lectures ----------

type FreeRow = { id: number; title: string; duration_seconds: number | null; section_title: string | null; subject_name: string | null; objectives: string | null };

play.get('/free-lectures', requireUser, async (c) => {
  const user = c.get('user')!;
  const rows = (
    await c.env.DB.prepare(
      `SELECT l.id, l.title, l.duration_seconds, s.title AS section_title, sj.name AS subject_name, l.objectives
       FROM lectures l LEFT JOIN sections s ON s.id = l.section_id LEFT JOIN subjects sj ON sj.id = l.subject_id
       WHERE l.is_free = 1 AND l.status = 'live' ORDER BY l.cohort_id DESC, l.day_number`,
    ).all<FreeRow>()
  ).results;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Free lectures" active="free-lectures" user={user}>
      <PageHead eyebrow="Try USMLE100" title="Free lectures" sub="Sample lectures you can watch before you enroll. Each free lecture can be watched 2 times." />
      {rows.length === 0 ? (
        <section class="card"><p class="muted" style="margin:0">There are no free lectures right now. Please check back soon.</p></section>
      ) : (
        <div class="grid">
          {rows.map((l) => (
            <article class="lec-card">
              <div class="lec-top"><span class="tag">Free</span>{l.subject_name && <span class="muted small">{l.subject_name}</span>}</div>
              <a class="lec-title" href={`/free-lectures/${l.id}`}>{l.title}</a>
              <span class="lec-date">{[l.duration_seconds ? clock(l.duration_seconds) : '', l.section_title].filter(Boolean).join(' · ')}</span>
              <a class="btn btn-block btn-primary" href={`/free-lectures/${l.id}`}><Icon name="play" size={18} />Watch</a>
            </article>
          ))}
        </div>
      )}
      {!isStaff(user) && !c.get('enrollment') && (
        <section class="card"><p style="margin:0">Ready for the full program? <a href="/enroll">See the programs</a>.</p></section>
      )}
    </PortalLayout>,
  );
});

play.get('/free-lectures/:id{[0-9]+}', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const l = await getLecture(db, Number(c.req.param('id')));
  if (!l) return c.notFound();
  const a = await accessFor(db, user, c.get('enrollment'), l);
  // A student who has this lecture in their program watches it there, with their paid views.
  if (a?.kind === 'paid') return c.redirect(`/lectures/${l.id}`);
  if (!a || (a.kind === 'staff' && l.is_free !== 1)) return c.notFound();
  return c.html(
    <PortalLayout shell={c.get('shell')} title={l.title} active="free-lectures" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/free-lectures">Free lectures</a><Icon name="chevron_right" size={16} />{l.title}</nav>
      <h1>{l.title}</h1>
      {!l.bunny_video_id && <Flash kind="error">The video for this lecture isn’t uploaded yet.</Flash>}
      {l.bunny_video_id && <ProtectedPlayer lectureId={l.id} title={l.title} />}
    </PortalLayout>,
  );
});
