/**
 * Lecture viewing rules (owner decisions R036–R071):
 * - Free preview lectures (chosen by an admin): 2 views per lecture, for any signed-in student.
 * - Paid lectures (the student's own cohort): 5 views per lecture for each paid enrollment.
 * - A viewing session's 24-hour window starts when playback actually begins. A session uses one view, once:
 *   when 65% of the video's unique content has been watched in it (the session then ends), or when its
 *   24 hours run out after playback began, however little was watched.
 * - Only content actually played counts; replaying the same part in one session counts once. Seeking is free.
 * - One protected lecture tab per account. It is released by End Lecture, by closing the tab, or after
 *   2 minutes without a signal from it. Ending and coming back resumes the same session.
 * - Extra views only from the owner. Staff are not limited.
 */
import type { Enrollment, User } from './types';
import { isStaff } from './types';
import { currentCohort, defaultLecturesUntil, todayUtc } from './content';

export const FREE_VIEWS = 2;
export const PAID_VIEWS = 5;
export const THRESHOLD = 0.65;
export const WINDOW_SECONDS = 24 * 3600;
export const TAB_RELEASE_SECONDS = 120;
/** Fastest allowed playback speed (R055), used to reject impossible progress reports. */
export const MAX_SPEED = 2;
const MAX_SECONDS = 6 * 3600; // longest video tracked: 6 hours

export const epoch = () => Math.floor(Date.now() / 1000);
export const randomId = (bytes = 9) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

export type Kind = 'free' | 'paid';
export type Access = { kind: 'staff' } | { kind: 'paid'; enrollmentId: number } | { kind: 'free' };
export type LectureRow = { id: number; cohort_id: number; status: string; is_free: number; bunny_video_id: string | null; duration_seconds: number | null; title: string };

export const getLecture = (db: D1Database, id: number) =>
  db.prepare('SELECT id, cohort_id, status, is_free, bunny_video_id, duration_seconds, title FROM lectures WHERE id = ?').bind(id).first<LectureRow>();

/** Paid access: an active enrollment in this lecture's cohort, while that enrollment's lecture access lasts. */
export async function paidAccess(db: D1Database, l: LectureRow, enr: Enrollment | null) {
  if (!enr || l.status !== 'live') return false;
  const cohort = await currentCohort(db, enr.cohort_id);
  if (!cohort || cohort.id !== l.cohort_id) return false;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  return new Date(todayUtc()).toISOString().slice(0, 10) <= until;
}

/** How this person may watch this lecture, if at all. A paid entitlement wins over a free preview (R046). */
export async function accessFor(db: D1Database, user: User, enr: Enrollment | null, l: LectureRow): Promise<Access | null> {
  if (isStaff(user)) return { kind: 'staff' };
  if (await paidAccess(db, l, enr)) return { kind: 'paid', enrollmentId: enr!.id };
  if (l.is_free === 1 && l.status === 'live') return { kind: 'free' };
  return null;
}

export type Session = {
  id: string; user_id: number; lecture_id: number; kind: Kind; enrollment_id: number | null; created_at: number; started_at: number | null;
  expires_at: number | null; last_beat_at: number | null; duration: number | null; watched_seconds: number; seen: string; counted: number; counted_reason: string | null;
};

const scope = (a: Access) => (a.kind === 'paid' ? { kind: 'paid' as const, enr: a.enrollmentId } : { kind: 'free' as const, enr: null });

/** Settle a session whose 24 hours ran out after playback began: it uses its view (R039, R050). */
async function settleExpired(db: D1Database, userId: number, lectureId: number) {
  const t = epoch();
  await db
    .prepare("UPDATE view_sessions SET counted = 1, counted_at = ?, counted_reason = 'expired' WHERE user_id = ? AND lecture_id = ? AND counted = 0 AND started_at IS NOT NULL AND expires_at <= ?")
    .bind(t, userId, lectureId, t)
    .run();
}

/** Views allowed, used, and the open (not yet used-up) session for this lecture, for this kind of access. */
export async function viewState(db: D1Database, userId: number, lectureId: number, a: Access) {
  if (a.kind === 'staff') return { allowed: Infinity, used: 0, open: null as Session | null, history: 0 };
  await settleExpired(db, userId, lectureId);
  const s = scope(a);
  const enrSql = s.kind === 'paid' ? 'AND enrollment_id = ?' : '';
  const binds = s.kind === 'paid' ? [userId, lectureId, s.kind, s.enr] : [userId, lectureId, s.kind];
  const [used, extra, open, history] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND lecture_id = ? AND kind = ? ${enrSql} AND counted = 1`).bind(...binds).first<{ n: number }>(),
    db.prepare(`SELECT COALESCE(SUM(extra), 0) AS n FROM view_grants WHERE user_id = ? AND lecture_id = ? AND kind = ? ${enrSql}`).bind(...binds).first<{ n: number }>(),
    db.prepare(`SELECT * FROM view_sessions WHERE user_id = ? AND lecture_id = ? AND kind = ? ${enrSql} AND counted = 0 ORDER BY created_at DESC LIMIT 1`).bind(...binds).first<Session>(),
    db.prepare('SELECT COUNT(*) AS n FROM view_sessions WHERE user_id = ? AND lecture_id = ? AND started_at IS NOT NULL').bind(userId, lectureId).first<{ n: number }>(),
  ]);
  const base = s.kind === 'paid' ? PAID_VIEWS : FREE_VIEWS;
  return { allowed: base + (extra?.n ?? 0), used: used?.n ?? 0, open: open ?? null, history: history?.n ?? 0 };
}

/** The open session, or a new one if a view is left. Null when every view is used. */
export async function openOrCreate(db: D1Database, userId: number, lectureId: number, a: Access) {
  const st = await viewState(db, userId, lectureId, a);
  if (st.open) return { ...st, session: st.open };
  if (st.used >= st.allowed) return { ...st, session: null };
  const s = scope(a);
  const id = randomId();
  await db
    .prepare('INSERT INTO view_sessions (id, user_id, lecture_id, kind, enrollment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, lectureId, s.kind, s.enr, epoch())
    .run();
  const session = (await db.prepare('SELECT * FROM view_sessions WHERE id = ?').bind(id).first<Session>())!;
  return { ...st, session };
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

export type Tab = { user_id: number; tab: string; nonce: string; lecture_id: number; session_id: string | null; seen_at: number };

/** Take the protected-tab slot for this browser tab. Returns the other tab's lecture when another tab holds it. */
export async function claimTab(db: D1Database, userId: number, tab: string, lectureId: number, sessionId: string | null) {
  const t = epoch();
  const nonce = randomId(12);
  // Free to take when nobody holds it, this same tab holds it (a reload), or the holder went quiet for 2 minutes.
  const r = await db
    .prepare(
      `INSERT INTO play_tabs (user_id, tab, nonce, lecture_id, session_id, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id) DO UPDATE SET tab = ?2, nonce = ?3, lecture_id = ?4, session_id = ?5, seen_at = ?6
       WHERE play_tabs.tab = ?2 OR play_tabs.seen_at < ?7`,
    )
    .bind(userId, tab, nonce, lectureId, sessionId, t, t - TAB_RELEASE_SECONDS)
    .run();
  if ((r.meta.changes ?? 0) > 0) return { ok: true as const, nonce };
  const holder = await db.prepare('SELECT p.lecture_id, l.title FROM play_tabs p LEFT JOIN lectures l ON l.id = p.lecture_id WHERE p.user_id = ?').bind(userId).first<{ lecture_id: number; title: string | null }>();
  return { ok: false as const, lectureId: holder?.lecture_id ?? null, title: holder?.title ?? null };
}

export async function releaseTab(db: D1Database, userId: number, tab: string) {
  await db.prepare('DELETE FROM play_tabs WHERE user_id = ? AND tab = ?').bind(userId, tab).run();
}

// ---------- Progress reports ----------

export type Beat = { sid: string; tab: string; nonce: string; playing: boolean; pos: number; dur: number; add: [number, number][] };
export type BeatResult =
  | { state: 'ok'; watchedPct: number; expiresAt: number | null }
  | { state: 'done'; reason: '65%' | 'expired' }
  | { state: 'tab' }
  | { state: 'gone' };

/**
 * Record a progress report from the player. Starts the 24-hour window on first playback, adds newly watched
 * seconds (no faster than 2× real time), saves the position, and uses the view at 65%.
 */
export async function recordBeat(db: D1Database, user: User, enr: Enrollment | null, b: Beat): Promise<BeatResult> {
  const t = epoch();
  if (b.sid === 'staff') return isStaff(user) ? { state: 'ok', watchedPct: 0, expiresAt: null } : { state: 'gone' };
  const tab = await db.prepare('SELECT * FROM play_tabs WHERE user_id = ?').bind(user.id).first<Tab>();
  if (!tab || tab.tab !== b.tab || tab.nonce !== b.nonce) return { state: 'tab' };
  await db.prepare('UPDATE play_tabs SET seen_at = ? WHERE user_id = ?').bind(t, user.id).run();

  const s = await db.prepare('SELECT * FROM view_sessions WHERE id = ? AND user_id = ?').bind(b.sid, user.id).first<Session>();
  if (!s || s.lecture_id !== tab.lecture_id) return { state: 'gone' };
  // Access can end mid-session (free preview removed, refund, lecture access closed).
  const l = await getLecture(db, s.lecture_id);
  const a = l ? await accessFor(db, user, enr, l) : null;
  if (!a || a.kind === 'staff' || a.kind !== s.kind || (a.kind === 'paid' && a.enrollmentId !== s.enrollment_id)) return { state: 'gone' };
  if (s.counted) return { state: 'done', reason: s.counted_reason === 'expired' ? 'expired' : '65%' };
  if (s.started_at && s.expires_at! <= t) {
    await settleExpired(db, user.id, s.lecture_id);
    return { state: 'done', reason: 'expired' };
  }

  const pos = Number.isFinite(b.pos) ? Math.max(0, Math.min(MAX_SECONDS, b.pos)) : 0;
  const reported = Number.isFinite(b.dur) && b.dur > 0 ? Math.min(MAX_SECONDS, b.dur) : null;
  const duration = l!.duration_seconds || s.duration || reported;
  // Playback has begun when the player says it is playing, or reports content already played (e.g. sent late after a dropped connection).
  const startNow = !s.started_at && (b.playing || (Array.isArray(b.add) && b.add.length > 0));
  const startedAt = s.started_at ?? (startNow ? t : null);

  let { seen, watched_seconds: watched } = s;
  if (startedAt && duration && Array.isArray(b.add) && b.add.length) {
    const ranges = b.add.filter((r) => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]).slice(0, 200) as [number, number][];
    // No more new seconds than could have played since the last report at 2× speed (plus a little slack).
    const since = s.last_beat_at ? t - s.last_beat_at : 15;
    const m = markSeconds(seen, Math.ceil(duration), ranges, Math.ceil(since * MAX_SPEED) + 5);
    seen = m.hex;
    watched = m.total;
  }
  const reached = !!duration && watched >= THRESHOLD * duration;
  await db.batch([
    db
      .prepare(
        `UPDATE view_sessions SET started_at = COALESCE(started_at, ?), expires_at = COALESCE(expires_at, ?), last_beat_at = ?, duration = COALESCE(duration, ?),
           seen = ?, watched_seconds = ?, counted = ?, counted_at = ?, counted_reason = ? WHERE id = ? AND counted = 0`,
      )
      .bind(startedAt, startedAt ? startedAt + WINDOW_SECONDS : null, t, reported, seen, watched, reached ? 1 : 0, reached ? t : null, reached ? '65%' : null, s.id),
    db
      .prepare('INSERT INTO lecture_positions (user_id, lecture_id, seconds, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, lecture_id) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at')
      .bind(user.id, s.lecture_id, pos, t),
    db.prepare('UPDATE play_tabs SET session_id = ? WHERE user_id = ?').bind(s.id, user.id),
    // Reaching 65% also marks the lecture watched.
    ...(reached
      ? [
          db
            .prepare(
              `INSERT INTO lecture_progress (user_id, lecture_id, completed_at) VALUES (?, ?, datetime('now'))
               ON CONFLICT (user_id, lecture_id) DO UPDATE SET completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now')`,
            )
            .bind(user.id, s.lecture_id),
        ]
      : []),
  ]);
  if (reached) return { state: 'done', reason: '65%' };
  return { state: 'ok', watchedPct: duration ? Math.round((watched / duration) * 100) : 0, expiresAt: startedAt ? startedAt + WINDOW_SECONDS : null };
}

export async function lastPosition(db: D1Database, userId: number, lectureId: number) {
  return (await db.prepare('SELECT seconds FROM lecture_positions WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first<{ seconds: number }>())?.seconds ?? 0;
}
