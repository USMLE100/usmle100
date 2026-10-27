/**
 * Protected video viewing rules (owner decisions R036–R071).
 *
 * Every protected video is named by an item key:
 *   'L:<id>'  a course lecture — paid students of that lecture's cohort: 5 views per lecture per enrollment;
 *   'F:<id>'  an entry in the owner's Free Lectures list — any signed-in student with a complete profile: 2 views;
 *   'E:<id>'  an Evening Questions class — its subscribers, with no view limit (no owner decision sets one).
 *
 * - A viewing session's 24-hour window starts when playback actually begins. A session uses one view, once:
 *   when 65% of the video's unique content has been watched in it (the session then ends), or when its
 *   24 hours run out after playback began, however little was watched. Unstarted sessions never count.
 * - Only content actually played counts; replaying the same part in one session counts once. Seeking is free.
 * - One protected tab per account (all devices). Released by End Lecture, closing the tab, or 2 minutes of silence.
 *   Ending and coming back resumes the same session. Extra views only from the owner. Staff are not limited.
 */
import type { Enrollment, User } from './types';
import { isStaff } from './types';
import { currentCohort, defaultLecturesUntil, todayUtc } from './content';
import { eveningAccess } from './evening';

export const FREE_VIEWS = 2;
export const PAID_VIEWS = 5;
export const THRESHOLD = 0.65;
export const WINDOW_SECONDS = 24 * 3600;
export const TAB_RELEASE_SECONDS = 120;
/** Fastest allowed playback speed (R055), used to reject impossible progress reports. */
export const MAX_SPEED = 2;
const MAX_SECONDS = 6 * 3600;

export const epoch = () => Math.floor(Date.now() / 1000);
export const randomId = (bytes = 9) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

export type Kind = 'free' | 'paid';
export type Access = { kind: 'staff' } | { kind: 'open' } | { kind: 'paid'; enrollmentId: number } | { kind: 'free' };
export type Video = { key: string; title: string; bunny: string | null; duration: number | null };

type LectureRow = { id: number; cohort_id: number; status: string; bunny_video_id: string | null; duration_seconds: number | null; title: string };
type EveningRow = { id: number; status: string; bunny_video_id: string | null; duration_seconds: number | null; title: string };
export type FreeRow = { id: number; source: string; title: string; description: string | null; category: string; duration_seconds: number | null; sort: number; published: number };

export const parseKey = (key: unknown) => {
  const m = typeof key === 'string' ? /^([LEF]):(\d{1,9})$/.exec(key) : null;
  return m ? { type: m[1] as 'L' | 'E' | 'F', id: Number(m[2]) } : null;
};

const lecture = (db: D1Database, id: number) =>
  db.prepare('SELECT id, cohort_id, status, bunny_video_id, duration_seconds, title FROM lectures WHERE id = ?').bind(id).first<LectureRow>();
const evening = (db: D1Database, id: number) =>
  db.prepare('SELECT id, status, bunny_video_id, duration_seconds, title FROM evening_sessions WHERE id = ?').bind(id).first<EveningRow>();
export const freeRow = (db: D1Database, id: number) => db.prepare('SELECT * FROM free_videos WHERE id = ?').bind(id).first<FreeRow>();

/** The video behind a free-list source ('L:12', 'E:5', 'V:<bunny id>'). */
export async function sourceVideo(db: D1Database, f: FreeRow): Promise<{ bunny: string | null; duration: number | null } | null> {
  const [t, ref] = [f.source.slice(0, 1), f.source.slice(2)];
  if (t === 'V') return { bunny: ref, duration: f.duration_seconds };
  const row = t === 'L' ? await lecture(db, Number(ref)) : t === 'E' ? await evening(db, Number(ref)) : null;
  return row ? { bunny: row.bunny_video_id, duration: row.duration_seconds } : null;
}

/** Paid access: an active enrollment in this lecture's cohort, while that enrollment's lecture access lasts. */
export async function paidAccess(db: D1Database, l: { cohort_id: number; status: string }, enr: Enrollment | null) {
  if (!enr || l.status !== 'live') return false;
  const cohort = await currentCohort(db, enr.cohort_id);
  if (!cohort || cohort.id !== l.cohort_id) return false;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  return new Date(todayUtc()).toISOString().slice(0, 10) <= until;
}

/** Free lectures need the registration details the owner asked for: phone, exam and graduation year (name and email always exist). */
export const profileComplete = (u: User) => !!(u.phone && u.exam && u.grad_year);

/**
 * The video and how this person may watch it, or null. For a free entry whose lecture the student has paid for,
 * `paidKey` says where to watch it with their paid views instead (R046).
 */
export async function resolve(db: D1Database, user: User, enr: Enrollment | null, key: string): Promise<{ video: Video; access: Access; paidKey?: string } | null> {
  const k = parseKey(key);
  if (!k) return null;
  if (k.type === 'L') {
    const l = await lecture(db, k.id);
    if (!l) return null;
    const video = { key, title: l.title, bunny: l.bunny_video_id, duration: l.duration_seconds };
    if (isStaff(user)) return { video, access: { kind: 'staff' } };
    return (await paidAccess(db, l, enr)) ? { video, access: { kind: 'paid', enrollmentId: enr!.id } } : null;
  }
  if (k.type === 'E') {
    const e = await evening(db, k.id);
    if (!e) return null;
    const video = { key, title: e.title, bunny: e.bunny_video_id, duration: e.duration_seconds };
    if (isStaff(user)) return { video, access: { kind: 'staff' } };
    const acc = await eveningAccess(db, user);
    return acc && e.status === 'live' && !acc.staff && acc.visible.has(e.id) ? { video, access: { kind: 'open' } } : null;
  }
  const f = await freeRow(db, k.id);
  if (!f) return null;
  const src = await sourceVideo(db, f);
  if (!src) return null;
  const video = { key, title: f.title, bunny: src.bunny, duration: src.duration };
  if (isStaff(user)) return { video, access: { kind: 'staff' } };
  if (f.published !== 1) return null;
  if (f.source.startsWith('L:')) {
    const l = await lecture(db, Number(f.source.slice(2)));
    if (l && (await paidAccess(db, l, enr))) return { video, access: { kind: 'free' }, paidKey: f.source };
  }
  return { video, access: { kind: 'free' } };
}

export type Session = {
  id: string; user_id: number; item: string; kind: Kind; enrollment_id: number | null; created_at: number; started_at: number | null;
  expires_at: number | null; last_beat_at: number | null; duration: number | null; watched_seconds: number; seen: string; counted: number; counted_reason: string | null;
};

const isCounted = (a: Access) => a.kind === 'paid' || a.kind === 'free';
const scope = (a: Access) => (a.kind === 'paid' ? { kind: 'paid' as const, enr: a.enrollmentId } : { kind: 'free' as const, enr: null });

/** Settle a session whose 24 hours ran out after playback began: it uses its view (R039, R050). */
async function settleExpired(db: D1Database, userId: number, item: string) {
  const t = epoch();
  await db
    .prepare("UPDATE view_sessions SET counted = 1, counted_at = ?, counted_reason = 'expired' WHERE user_id = ? AND item = ? AND counted = 0 AND started_at IS NOT NULL AND expires_at <= ?")
    .bind(t, userId, item, t)
    .run();
}

/** Views allowed, used, and the open (not yet used-up) session for this video and this kind of access. */
export async function viewState(db: D1Database, userId: number, item: string, a: Access) {
  if (!isCounted(a)) return { allowed: Infinity, used: 0, open: null as Session | null, history: 0 };
  await settleExpired(db, userId, item);
  const s = scope(a);
  const enrSql = s.kind === 'paid' ? 'AND enrollment_id = ?' : '';
  const binds = s.kind === 'paid' ? [userId, item, s.kind, s.enr] : [userId, item, s.kind];
  const [used, extra, open, history] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND item = ? AND kind = ? ${enrSql} AND counted = 1`).bind(...binds).first<{ n: number }>(),
    db.prepare(`SELECT COALESCE(SUM(extra), 0) AS n FROM view_grants WHERE user_id = ? AND item = ? AND kind = ? ${enrSql}`).bind(...binds).first<{ n: number }>(),
    db.prepare(`SELECT * FROM view_sessions WHERE user_id = ? AND item = ? AND kind = ? ${enrSql} AND counted = 0 ORDER BY created_at DESC LIMIT 1`).bind(...binds).first<Session>(),
    db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND item = ? AND started_at IS NOT NULL').bind(userId, item).first<{ n: number }>(),
  ]);
  const base = s.kind === 'paid' ? PAID_VIEWS : FREE_VIEWS;
  return { allowed: base + (extra?.n ?? 0), used: used?.n ?? 0, open: open ?? null, history: history?.n ?? 0 };
}

/** The open session, or a new one if a view is left. `session` is null when every view is used. */
export async function openOrCreate(db: D1Database, userId: number, item: string, a: Access) {
  const st = await viewState(db, userId, item, a);
  if (st.open) return { ...st, session: st.open };
  if (st.used >= st.allowed) return { ...st, session: null };
  const s = scope(a);
  const id = randomId();
  await db.prepare('INSERT INTO view_sessions (id, user_id, item, kind, enrollment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, userId, item, s.kind, s.enr, epoch()).run();
  return { ...st, session: (await db.prepare('SELECT * FROM view_sessions WHERE id = ?').bind(id).first<Session>())! };
}

// ---------- Unique seconds watched (bitset as hex) ----------

function toBits(hex: string, len: number) {
  const bits = new Uint8Array(Math.ceil(len / 8));
  for (let i = 0; i < Math.min(hex.length / 2, bits.length); i++) bits[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return bits;
}
const toHex = (bits: Uint8Array) => [...bits].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Mark watched seconds [from, to) and return how many were new. Stops after `limit` new seconds. */
export function markSeconds(hex: string, len: number, ranges: [number, number][], limit: number) {
  const bits = toBits(hex, len);
  let added = 0;
  for (const [a, b] of ranges) {
    const from = Math.max(0, Math.floor(a));
    const to = Math.min(len, Math.ceil(b));
    for (let s = from; s < to && added < limit; s++) {
      const byte = s >> 3, mask = 1 << (s & 7);
      if (!(bits[byte] & mask)) {
        bits[byte] |= mask;
        added++;
      }
    }
  }
  let total = 0;
  for (const b of bits) for (let x = b; x; x &= x - 1) total++;
  return { hex: toHex(bits), added, total };
}

// ---------- One protected tab ----------

export type Tab = { user_id: number; tab: string; nonce: string; item: string; session_id: string | null; seen_at: number };

/** Take the protected-tab slot for this browser tab. When another tab holds it, says which video. */
export async function claimTab(db: D1Database, userId: number, tab: string, item: string, sessionId: string | null, where: { device: string | null; ip: string | null } = { device: null, ip: null }) {
  const t = epoch();
  const nonce = randomId(12);
  // Free when nobody holds it, this same tab holds it (a reload), or the holder went quiet for 2 minutes.
  const r = await db
    .prepare(
      `INSERT INTO play_tabs (user_id, tab, nonce, item, session_id, seen_at, device_hash, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, ?9)
       ON CONFLICT (user_id) DO UPDATE SET tab = ?2, nonce = ?3, item = ?4, session_id = ?5, seen_at = ?6, device_hash = ?8, ip = ?9
       WHERE play_tabs.tab = ?2 OR play_tabs.seen_at < ?7`,
    )
    .bind(userId, tab, nonce, item, sessionId, t, t - TAB_RELEASE_SECONDS, where.device, where.ip)
    .run();
  if ((r.meta.changes ?? 0) > 0) return { ok: true as const, nonce };
  const holder = await db.prepare('SELECT item, device_hash, ip, seen_at FROM play_tabs WHERE user_id = ?').bind(userId).first<{ item: string; device_hash: string | null; ip: string | null; seen_at: number }>();
  // Another registered device, on another network, actively playing within the last 30 seconds: suspected sharing.
  const sharing = !!holder && !!where.device && !!holder.device_hash && holder.device_hash !== where.device && !!where.ip && !!holder.ip && holder.ip !== where.ip && t - holder.seen_at <= 30;
  return { ok: false as const, item: holder?.item ?? null, title: holder ? await titleOf(db, holder.item) : null, sharing };
}

export async function titleOf(db: D1Database, key: string) {
  const k = parseKey(key);
  if (!k) return null;
  const table = k.type === 'L' ? 'lectures' : k.type === 'E' ? 'evening_sessions' : 'free_videos';
  return (await db.prepare(`SELECT title FROM ${table} WHERE id = ?`).bind(k.id).first<{ title: string }>())?.title ?? null;
}

export async function releaseTab(db: D1Database, userId: number, tab: string) {
  await db.prepare('DELETE FROM play_tabs WHERE user_id = ? AND tab = ?').bind(userId, tab).run();
}

// ---------- Progress reports ----------

export type Beat = { sid: string; tab: string; nonce: string; playing: boolean; pos: number; dur: number; add: [number, number][] };
export type BeatResult = { state: 'ok'; watchedPct: number; expiresAt: number | null } | { state: 'done'; reason: '65%' | 'expired' } | { state: 'tab' } | { state: 'gone' };

const savePos = (db: D1Database, userId: number, item: string, pos: number, t: number) =>
  db
    .prepare('INSERT INTO video_positions (user_id, item, seconds, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, item) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at')
    .bind(userId, item, pos, t);

/**
 * Record a progress report from the player. Starts the 24-hour window on first playback, adds newly watched
 * seconds (no faster than 2× real time), saves the position, and uses the view at 65%.
 * Uncounted videos (Evening classes) only keep the tab and position.
 */
export async function recordBeat(db: D1Database, user: User, enr: Enrollment | null, b: Beat): Promise<BeatResult> {
  const t = epoch();
  if (b.sid === 'staff') return isStaff(user) ? { state: 'ok', watchedPct: 0, expiresAt: null } : { state: 'gone' };
  const tab = await db.prepare('SELECT * FROM play_tabs WHERE user_id = ?').bind(user.id).first<Tab>();
  if (!tab || tab.tab !== b.tab || tab.nonce !== b.nonce) return { state: 'tab' };
  await db.prepare('UPDATE play_tabs SET seen_at = ? WHERE user_id = ?').bind(t, user.id).run();
  const pos = Number.isFinite(b.pos) ? Math.max(0, Math.min(MAX_SECONDS, b.pos)) : 0;

  // Access can end mid-viewing (free entry unpublished, refund, suspension, lecture access closed).
  const r = await resolve(db, user, enr, tab.item);
  if (!r || r.access.kind === 'staff') return { state: 'gone' };
  if (r.access.kind === 'open') {
    if (b.sid !== 'open') return { state: 'gone' };
    await savePos(db, user.id, tab.item, pos, t).run();
    return { state: 'ok', watchedPct: 0, expiresAt: null };
  }
  const a = r.access;
  const s = await db.prepare('SELECT * FROM view_sessions WHERE id = ? AND user_id = ?').bind(b.sid, user.id).first<Session>();
  if (!s || s.item !== tab.item || a.kind !== s.kind || (a.kind === 'paid' && a.enrollmentId !== s.enrollment_id)) return { state: 'gone' };
  if (s.counted) return { state: 'done', reason: s.counted_reason === 'expired' ? 'expired' : '65%' };
  if (s.started_at && s.expires_at! <= t) {
    await settleExpired(db, user.id, s.item);
    return { state: 'done', reason: 'expired' };
  }

  const reported = Number.isFinite(b.dur) && b.dur > 0 ? Math.min(MAX_SECONDS, b.dur) : null;
  const duration = r.video.duration || s.duration || reported;
  const ranges = (Array.isArray(b.add) ? b.add : [])
    .filter((x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] > x[0])
    .slice(0, 200) as [number, number][];
  // Playback has begun when the player says it is playing, or reports content already played (sent late after a dropped connection).
  const startedAt = s.started_at ?? (b.playing || ranges.length ? t : null);

  let { seen, watched_seconds: watched } = s;
  if (startedAt && duration && ranges.length) {
    // No more new seconds than could have played since the last report at 2× speed (plus a little slack).
    const since = s.last_beat_at ? t - s.last_beat_at : 15;
    const m = markSeconds(seen, Math.ceil(duration), ranges, Math.ceil(since * MAX_SPEED) + 5);
    seen = m.hex;
    watched = m.total;
  }
  const reached = !!duration && watched >= THRESHOLD * duration;
  const lectureId = s.item.startsWith('L:') ? Number(s.item.slice(2)) : null;
  await db.batch([
    db
      .prepare(
        `UPDATE view_sessions SET started_at = COALESCE(started_at, ?), expires_at = COALESCE(expires_at, ?), last_beat_at = ?, duration = COALESCE(duration, ?),
           seen = ?, watched_seconds = ?, counted = ?, counted_at = ?, counted_reason = ? WHERE id = ? AND counted = 0`,
      )
      .bind(startedAt, startedAt ? startedAt + WINDOW_SECONDS : null, t, reported, seen, watched, reached ? 1 : 0, reached ? t : null, reached ? '65%' : null, s.id),
    savePos(db, user.id, s.item, pos, t),
    db.prepare('UPDATE play_tabs SET session_id = ? WHERE user_id = ?').bind(s.id, user.id),
    // Reaching 65% of a course lecture also marks it watched.
    ...(reached && lectureId
      ? [
          db
            .prepare(
              `INSERT INTO lecture_progress (user_id, lecture_id, completed_at) VALUES (?, ?, datetime('now'))
               ON CONFLICT (user_id, lecture_id) DO UPDATE SET completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now')`,
            )
            .bind(user.id, lectureId),
        ]
      : []),
  ]);
  if (reached) return { state: 'done', reason: '65%' };
  return { state: 'ok', watchedPct: duration ? Math.round((watched / duration) * 100) : 0, expiresAt: startedAt ? startedAt + WINDOW_SECONDS : null };
}

export async function lastPosition(db: D1Database, userId: number, item: string) {
  return (await db.prepare('SELECT seconds FROM video_positions WHERE user_id = ? AND item = ?').bind(userId, item).first<{ seconds: number }>())?.seconds ?? 0;
}

/** For the security log and admin pages: the video's readable name. */
export async function itemLabel(db: D1Database, key: string) {
  const k = parseKey(key);
  if (!k) return key;
  const title = await titleOf(db, key);
  const kind = k.type === 'L' ? 'Lecture' : k.type === 'E' ? 'Evening class' : 'Free lecture';
  return `${kind}: ${title ?? '(removed)'}`;
}
