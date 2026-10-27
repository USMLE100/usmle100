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
import { reportSharing } from '../lib/devices';
import { claimTab, lastPosition, openOrCreate, parseKey, profileComplete, recordBeat, releaseTab, resolve, sourceVideo, viewState, type Beat, type FreeRow } from '../lib/viewing';

/**
 * Protected playback (lib/viewing) and the members' Free Lectures pages. Mounted before the portal router,
 * so students without a program (or with only the Course Book / Evening Questions) can use Free Lectures.
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
const ip = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? null;

const NOTICE_PAID =
  'Before you start: each lecture can be watched a limited number of times. A viewing lasts 24 hours from when you press play. It counts as one view when you have watched 65% of the lecture, or when its 24 hours end. You can pause, press End Lecture and come back within those 24 hours without using another view. Lectures are for you alone: your name and account number appear on the video, and recording or sharing them is not allowed.';
const NOTICE_FREE =
  'Before you start: each free lecture can be watched 2 times. A viewing lasts 24 hours from when you press play. It counts as one view when you have watched 65% of the video, or when its 24 hours end. You can pause, press End Lecture and come back within those 24 hours without using another view. Your name and account number appear on the video, and recording or sharing it is not allowed.';

const where = (c: Context<AppEnv>) => ({ device: c.get('session')?.deviceHash ?? null, ip: ip(c) });

/** The protected tab is held elsewhere. From another device on another network while playing: suspected sharing. */
async function busy(c: Context<AppEnv>, userId: number, t: { title: string | null; sharing: boolean; item: string | null }, item: string) {
  if (t.sharing) {
    const locked = await reportSharing(c.env.DB, userId, { item, other: t.item, ip: ip(c), country: c.req.header('cf-ipcountry') ?? null });
    return c.json({ state: 'sharing', locked });
  }
  return c.json({ state: 'busy', title: t.title });
}

/** Open (or resume) a viewing in this tab: returns a short-lived video link only if allowed. */
play.post('/play/claim', async (c) => {
  noStore(c);
  const user = c.get('user');
  if (!user) return c.json({ state: 'signin' }, 401);
  const db = c.env.DB;
  const b = await body(c);
  const tab = typeof b.tab === 'string' && /^[0-9a-f]{8,64}$/.test(b.tab) ? b.tab : null;
  const item = parseKey(b.item) ? String(b.item) : null;
  if (!tab || !item) return c.json({ state: 'gone' }, 404);
  const r = await resolve(db, user, c.get('enrollment'), item);
  if (!r) return c.json({ state: 'gone' }, 403);
  if (r.paidKey) return c.json({ state: 'redirect', url: `/lectures/${r.paidKey.slice(2)}` });
  if (r.access.kind === 'free' && !profileComplete(user)) return c.json({ state: 'profile' });
  if (!r.video.bunny) return c.json({ state: 'novideo', message: 'The video isn’t uploaded yet.' });
  const wm = (code: string) => ({ name: user.name, id: user.id, code });
  const link = () => bunnyEmbedUrl(c.env, r.video.bunny!);
  const unplayable = { state: 'novideo', message: 'This video can’t be played right now. Please try again later.' };

  if (r.access.kind === 'staff') {
    const src = await link();
    return src ? c.json({ state: 'ok', sid: 'staff', nonce: 'staff', src, pos: 0, first: false, wm: wm('STAFF') }) : c.json(unplayable);
  }
  if (r.access.kind === 'open') {
    const t = await claimTab(db, user.id, tab, item, null, where(c));
    if (!t.ok) return busy(c, user.id, t, item);
    const src = await link();
    return src ? c.json({ state: 'ok', sid: 'open', nonce: t.nonce, src, pos: await lastPosition(db, user.id, item), first: false, wm: wm(t.nonce.slice(0, 9)) }) : c.json(unplayable);
  }

  const v = await openOrCreate(db, user.id, item, r.access);
  if (!v.session) {
    const requested = !!(await db.prepare('SELECT 1 FROM view_requests WHERE user_id = ? AND item = ? AND resolved_at IS NULL').bind(user.id, item).first());
    return c.json({ state: 'locked', allowed: v.allowed, used: v.used, request: true, requested });
  }
  const t = await claimTab(db, user.id, tab, item, v.session.id, where(c));
  if (!t.ok) return busy(c, user.id, t, item);
  const src = await link();
  if (!src) return c.json(unplayable);
  return c.json({
    state: 'ok',
    sid: v.session.id,
    nonce: t.nonce,
    src,
    pos: await lastPosition(db, user.id, item),
    // The rules are shown before the first playback of each video (R054).
    first: v.history === 0 && !v.session.started_at,
    notice: r.access.kind === 'free' ? NOTICE_FREE : NOTICE_PAID,
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
  const item = String((await body(c)).item ?? '');
  const r = parseKey(item) ? await resolve(db, user, c.get('enrollment'), item) : null;
  if (!r || (r.access.kind !== 'paid' && r.access.kind !== 'free')) return c.json({ ok: false }, 403);
  const v = await viewState(db, user.id, item, r.access);
  if (v.used < v.allowed || v.open) return c.json({ ok: false, reason: 'views left' }, 400);
  if (!(await db.prepare('SELECT 1 FROM view_requests WHERE user_id = ? AND item = ? AND resolved_at IS NULL').bind(user.id, item).first())) {
    await db.prepare('INSERT INTO view_requests (user_id, item, kind) VALUES (?, ?, ?)').bind(user.id, item, r.access.kind).run();
    await audit(db, { actorId: user.id, action: 'views.requested', targetUserId: user.id, detail: { item, kind: r.access.kind }, ip: ip(c) });
  }
  return c.json({ ok: true });
});

// ---------- Members' Free Lectures ----------

export const CATEGORY: Record<string, string> = { sample: 'Sample class', evening: 'Evening Questions', educational: 'Free lecture', info: 'About USMLE100' };

export async function publishedFree(db: D1Database) {
  return (await db.prepare('SELECT * FROM free_videos WHERE published = 1 ORDER BY sort, id').all<FreeRow>()).results;
}

play.get('/free-lectures', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const rows = await publishedFree(db);
  const lengths = await Promise.all(rows.map(async (f) => (await sourceVideo(db, f))?.duration ?? null));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Free lectures" active="free-lectures" user={user}>
      <PageHead eyebrow="Try USMLE100" title="Free lectures" sub="Lectures you can watch before you enroll, chosen by our faculty. Each one can be watched 2 times." />
      {!profileComplete(user) && !isStaff(user) && (
        <Flash kind="error">Please add your phone number, exam and graduation year in <a href="/account?next=/free-lectures">My account</a> to watch free lectures.</Flash>
      )}
      {rows.length === 0 ? (
        <section class="card"><p class="muted" style="margin:0">There are no free lectures right now. Please check back soon.</p></section>
      ) : (
        <div class="grid">
          {rows.map((f, i) => (
            <article class="lec-card">
              <div class="lec-top"><span class="tag">{CATEGORY[f.category] ?? 'Free'}</span></div>
              <a class="lec-title" href={`/free-lectures/${f.id}`}>{f.title}</a>
              {f.description && <span class="lec-date">{f.description}</span>}
              {lengths[i] && <span class="lec-date">{clock(lengths[i]!)}</span>}
              <a class="btn btn-block btn-primary" href={`/free-lectures/${f.id}`}><Icon name="play" size={18} />Watch</a>
            </article>
          ))}
        </div>
      )}
      {!isStaff(user) && !c.get('enrollment') && (
        <section class="card row" style="justify-content:space-between;align-items:center">
          <div><strong>Ready for the full program?</strong><p class="muted small" style="margin:4px 0 0">90 days of live lectures, the question bank, the Course Book and more.</p></div>
          <a class="btn btn-outline" href="/programs">Explore programs</a>
        </section>
      )}
    </PortalLayout>,
  );
});

play.get('/free-lectures/:id{[0-9]+}', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const key = `F:${c.req.param('id')}`;
  const r = await resolve(db, user, c.get('enrollment'), key);
  if (!r) return c.notFound();
  // A student who has this lecture in their program watches it there, with their paid views (R046).
  if (r.paidKey) return c.redirect(`/lectures/${r.paidKey.slice(2)}`);
  return c.html(
    <PortalLayout shell={c.get('shell')} title={r.video.title} active="free-lectures" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/free-lectures">Free lectures</a><Icon name="chevron_right" size={16} />{r.video.title}</nav>
      <h1>{r.video.title}</h1>
      {r.access.kind === 'free' && !profileComplete(user) ? (
        <section class="card"><p style="margin:0">Before you watch, please add your phone number, the exam you’re preparing for and your graduation year.</p><a class="btn btn-primary" href={`/account?next=/free-lectures/${c.req.param('id')}`} style="align-self:flex-start">Complete my details</a></section>
      ) : r.video.bunny ? (
        <ProtectedPlayer item={key} title={r.video.title} />
      ) : (
        <Flash kind="error">The video isn’t uploaded yet.</Flash>
      )}
      {!isStaff(user) && !c.get('enrollment') && <p class="small muted">Enjoying it? <a href="/programs">See the full programs</a>.</p>}
    </PortalLayout>,
  );
});
