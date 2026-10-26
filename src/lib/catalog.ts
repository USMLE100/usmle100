import type { Env } from './types';

/** Lectures with their subject, section, length and this student's progress (V12 Browse, Path, Workbench, Topics). */
export type CatLecture = {
  id: number;
  day_number: number;
  title: string;
  subject_id: number | null;
  section_id: number | null;
  duration_seconds: number | null;
  objectives: string | null;
  status: string;
  completed_at: string | null;
  saved: number;
};
export type Section = { id: number; subject_id: number | null; title: string; sort: number };
export type Subject = { id: number; name: string; sort: number };

export async function catalog(db: D1Database, cohortId: number, userId: number) {
  const [lec, sec, sub] = await Promise.all([
    db
      .prepare(
        `SELECT l.id, l.day_number, l.title, l.subject_id, l.section_id, l.duration_seconds, l.objectives, l.status, p.completed_at,
           CASE WHEN b.lecture_id IS NULL THEN 0 ELSE 1 END AS saved
         FROM lectures l
         LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?1
         LEFT JOIN lecture_bookmarks b ON b.lecture_id = l.id AND b.user_id = ?1
         WHERE l.cohort_id = ?2 ORDER BY l.day_number`,
      )
      .bind(userId, cohortId)
      .all<CatLecture>(),
    db.prepare('SELECT id, subject_id, title, sort FROM sections ORDER BY sort, id').all<Section>(),
    db.prepare('SELECT id, name, sort FROM subjects ORDER BY sort').all<Subject>(),
  ]);
  return { lectures: lec.results, sections: sec.results, subjects: sub.results };
}

export type Group = { key: string; section: Section | null; title: string; subject_id: number | null; lectures: CatLecture[] };

/**
 * Lectures grouped into sections, in course order (by each section's first lecture day).
 * Lectures without a section are grouped by subject so nothing is left out.
 */
export function groupBySection(lectures: CatLecture[], sections: Section[], subjects: Subject[]): Group[] {
  const secById = new Map(sections.map((s) => [s.id, s]));
  const subName = new Map(subjects.map((s) => [s.id, s.name]));
  const groups = new Map<string, Group>();
  for (const l of lectures) {
    const sec = l.section_id ? secById.get(l.section_id) ?? null : null;
    const key = sec ? `s${sec.id}` : `u${l.subject_id ?? 0}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        section: sec,
        title: sec ? sec.title : l.subject_id ? `${subName.get(l.subject_id) ?? 'Other'} lectures` : 'Other lectures',
        subject_id: sec ? sec.subject_id : l.subject_id,
        lectures: [],
      });
    }
    groups.get(key)!.lectures.push(l);
  }
  return [...groups.values()];
}

export const seconds = (ls: { duration_seconds: number | null }[]) => ls.reduce((a, l) => a + (l.duration_seconds ?? 0), 0);
export const hasLength = (ls: { duration_seconds: number | null }[]) => ls.some((l) => l.duration_seconds);

/** "10:17" or "3:52:10" — a video's length. */
export function clock(sec: number | null | undefined) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "2h 22m" for runtimes. */
export function runtime(sec: number) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "2 hours, 22 minutes" (V12 Path wording). */
export function runtimeLong(sec: number) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const hp = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mp = mm || !h ? `${mm} minute${mm === 1 ? '' : 's'}` : '';
  return [hp, mp].filter(Boolean).join(', ');
}

export const objectiveList = (o: string | null) => (o ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/**
 * Fill in video lengths from Bunny for lectures and evening classes that don't have one yet.
 * Bunny reports `length` in seconds once a video has been processed. Cheap to run often.
 */
export async function syncDurations(env: Env) {
  if (!env.BUNNY_API_KEY || !env.BUNNY_LIBRARY_ID) return;
  const db = env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT 'lectures' AS t, id, bunny_video_id FROM lectures WHERE bunny_video_id IS NOT NULL AND duration_seconds IS NULL
         UNION ALL SELECT 'evening_sessions', id, bunny_video_id FROM evening_sessions WHERE bunny_video_id IS NOT NULL AND duration_seconds IS NULL
         LIMIT 25`,
      )
      .all<{ t: 'lectures' | 'evening_sessions'; id: number; bunny_video_id: string }>()
  ).results;
  for (const r of rows) {
    const res = await fetch(`https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${encodeURIComponent(r.bunny_video_id)}`, {
      headers: { AccessKey: env.BUNNY_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) continue;
    const len = Number(((await res.json()) as { length?: number }).length);
    if (len > 0) await db.prepare(`UPDATE ${r.t} SET duration_seconds = ? WHERE id = ? AND duration_seconds IS NULL`).bind(Math.round(len), r.id).run();
  }
}
