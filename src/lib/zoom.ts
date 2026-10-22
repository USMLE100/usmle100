import type { Env } from './types';
import { safeEqual } from './auth';
import { currentCohort, dayOfDate, isClassDate, todayUtc } from './content';

/**
 * Automatic lecture import: Zoom cloud recording -> Bunny Stream -> that day's lecture.
 *
 * 1. Zoom calls POST /zoom/webhook with "recording.completed" (signed with ZOOM_WEBHOOK_SECRET).
 * 2. We pick the best MP4, attach it to the program day it was recorded on, and ask Bunny to fetch it
 *    using Zoom's short-lived download token. Bunny downloads straight from Zoom; nothing passes through here.
 * 3. A cron job (and each visit to Admin -> Lectures) finds the new Bunny video, saves its ID on the lecture,
 *    and puts the lecture live when Bunny has finished encoding.
 */

const enc = new TextEncoder();

async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Zoom signs each webhook: x-zm-signature = "v0=" + HMAC_SHA256(secret, "v0:{timestamp}:{body}"). */
export async function verifyZoom(secret: string, body: string, ts: string | undefined, sig: string | undefined, toleranceSec = 300) {
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  const t = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  return safeEqual(sig, 'v0=' + (await hmacHex(secret, `v0:${ts}:${body}`)));
}

/** Answer Zoom's endpoint check when the webhook URL is saved. */
export async function urlValidation(secret: string, plainToken: string) {
  return { plainToken, encryptedToken: await hmacHex(secret, plainToken) };
}

type ZoomFile = { id: string; file_type: string; recording_type?: string; status?: string; download_url: string; file_size?: number; recording_start?: string; recording_end?: string };

const VIEW_PREFERENCE = ['shared_screen_with_speaker_view', 'shared_screen_with_speaker_view(CC)', 'shared_screen_with_gallery_view', 'shared_screen', 'active_speaker', 'speaker_view', 'gallery_view'];

/** The one MP4 students should watch: screen-share-with-speaker if there is one, and the longest part of that view. */
export function pickRecording(files: ZoomFile[]) {
  const mp4 = files.filter((f) => f.file_type === 'MP4' && (!f.status || f.status === 'completed'));
  if (!mp4.length) return null;
  const rank = (f: ZoomFile) => {
    const i = VIEW_PREFERENCE.indexOf(f.recording_type ?? '');
    return i < 0 ? VIEW_PREFERENCE.length : i;
  };
  const best = Math.min(...mp4.map(rank));
  const sameView = mp4.filter((f) => rank(f) === best);
  const length = (f: ZoomFile) => (f.recording_start && f.recording_end ? Date.parse(f.recording_end) - Date.parse(f.recording_start) : 0) || f.file_size || 0;
  sameView.sort((a, b) => length(b) - length(a));
  return { file: sameView[0], extraParts: sameView.length - 1 };
}

export const meetingIdList = (v: string) =>
  v
    .split(/[,;\n]+/)
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);

async function getSetting(db: D1Database, key: string) {
  return (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? '';
}

async function zoomServerToken(env: Env) {
  if (!env.ZOOM_ACCOUNT_ID || !env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) return null;
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID)}`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`) },
  });
  if (!res.ok) return null;
  return ((await res.json()) as { access_token?: string }).access_token ?? null;
}

const bunnyBase = (env: Env) => `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}`;
const marker = (importId: number) => `[u100-${importId}]`;

/** Handle a "recording.completed" event. Safe to call twice for the same recording (Zoom retries). */
export async function importRecording(env: Env, payload: any) {
  const db = env.DB;
  const obj = payload?.object ?? {};
  const picked = pickRecording(Array.isArray(obj.recording_files) ? obj.recording_files : []);
  if (!picked) return;
  const { file, extraParts } = picked;
  const meetingId = String(obj.id ?? '');
  const topic = String(obj.topic ?? 'Lecture').slice(0, 120);
  const allowed = meetingIdList(await getSetting(db, 'zoom_meeting_ids'));
  if (allowed.length && !allowed.includes(meetingId)) return; // Not a class meeting: ignore it.

  const existing = await db.prepare('SELECT id FROM zoom_imports WHERE zoom_file_id = ?').bind(file.id).first();
  if (existing) return;

  // Which program day was this recorded on? (New York date of the recording.)
  const startedAt = file.recording_start || obj.start_time || new Date().toISOString();
  const cohort = await currentCohort(db);
  const t = todayUtc(new Date(startedAt));
  const day = cohort && isClassDate(cohort, t) ? dayOfDate(cohort, t) : 0;
  let lectureId: number | null = null;
  let note: string | null = extraParts ? `Zoom made ${extraParts + 1} parts; the longest was imported.` : null;
  if (cohort && day >= 1 && day <= cohort.lecture_days) {
    const lec = await db.prepare('SELECT id, bunny_video_id FROM lectures WHERE cohort_id = ? AND day_number = ?').bind(cohort.id, day).first<{ id: number; bunny_video_id: string | null }>();
    if (!lec) {
      const r = await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, zoom_url, status) VALUES (?, ?, ?, ?, 'processing')").bind(cohort.id, day, topic, obj.share_url ?? null).run();
      lectureId = Number(r.meta.last_row_id);
    } else if (!lec.bunny_video_id) {
      lectureId = lec.id;
    } else {
      note = `Day ${day} already has a video, so this one was not attached.`;
    }
  } else {
    note = 'Recorded outside the class days, so it was not attached to a day.';
  }

  const autoLive = allowed.length > 0 && lectureId ? 1 : 0;
  const ins = await db
    .prepare('INSERT OR IGNORE INTO zoom_imports (zoom_file_id, meeting_id, topic, start_time, share_url, lecture_id, auto_live, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(file.id, meetingId, topic, startedAt, obj.share_url ?? null, lectureId, autoLive, note)
    .run();
  if (!ins.meta.changes) return;
  const importId = Number(ins.meta.last_row_id);

  const fail = (why: string) => db.prepare("UPDATE zoom_imports SET status = 'failed', note = ?, updated_at = datetime('now') WHERE id = ?").bind(why, importId).run();
  if (!env.BUNNY_API_KEY || !env.BUNNY_LIBRARY_ID) return fail('The Bunny API key is not set in Cloudflare yet.');
  const token = payload.download_token || (await zoomServerToken(env));
  if (!token) return fail('Zoom did not include a download permission.');
  const res = await fetch(`${bunnyBase(env)}/videos/fetch`, {
    method: 'POST',
    headers: { AccessKey: env.BUNNY_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url: file.download_url, headers: { Authorization: `Bearer ${token}` }, title: `${topic} ${marker(importId)}` }),
  });
  if (!res.ok) return fail(`Bunny refused the copy (error ${res.status}). Check the Bunny API key.`);
}

type BunnyVideo = { guid: string; title: string; status: number };
const READY = [4, 7, 8];
const FAILED = [5, 6];

/** Link fetched videos to their lectures and put them live when Bunny is done. Cheap to run often. */
export async function syncImports(env: Env) {
  if (!env.BUNNY_API_KEY || !env.BUNNY_LIBRARY_ID) return;
  const db = env.DB;
  const pending = (
    await db.prepare("SELECT * FROM zoom_imports WHERE status IN ('fetching', 'processing') AND created_at > datetime('now', '-3 days') ORDER BY id LIMIT 20").all<any>()
  ).results;
  const headers = { AccessKey: env.BUNNY_API_KEY, Accept: 'application/json' };
  for (const imp of pending) {
    let vid: string | null = imp.bunny_video_id;
    let video: BunnyVideo | null = null;
    if (!vid) {
      const res = await fetch(`${bunnyBase(env)}/videos?page=1&itemsPerPage=50&search=${encodeURIComponent(`u100-${imp.id}`)}`, { headers });
      if (!res.ok) continue;
      const items = (((await res.json()) as { items?: BunnyVideo[] }).items ?? []).filter((v) => v.title?.includes(marker(imp.id)));
      video = items[0] ?? null;
      if (!video) {
        // Bunny hasn't started yet. Give up after a few hours.
        if (Date.now() - Date.parse(imp.created_at + 'Z') > 4 * 3600_000) {
          await db.prepare("UPDATE zoom_imports SET status = 'failed', note = 'Bunny could not download it from Zoom.', updated_at = datetime('now') WHERE id = ?").bind(imp.id).run();
        }
        continue;
      }
      vid = video.guid;
      // Remove the tracking tag from the title students see.
      await fetch(`${bunnyBase(env)}/videos/${vid}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: String(imp.topic ?? 'Lecture') }),
      });
      await db.batch([
        db.prepare("UPDATE zoom_imports SET bunny_video_id = ?, status = 'processing', updated_at = datetime('now') WHERE id = ?").bind(vid, imp.id),
        db.prepare('UPDATE lectures SET bunny_video_id = ? WHERE id = ? AND bunny_video_id IS NULL').bind(vid, imp.lecture_id),
      ]);
    } else {
      const res = await fetch(`${bunnyBase(env)}/videos/${vid}`, { headers });
      if (!res.ok) continue;
      video = (await res.json()) as BunnyVideo;
    }
    if (READY.includes(video.status)) {
      await db.batch([
        db.prepare("UPDATE zoom_imports SET status = 'ready', updated_at = datetime('now') WHERE id = ?").bind(imp.id),
        ...(imp.auto_live && imp.lecture_id
          ? [db.prepare("UPDATE lectures SET status = 'live' WHERE id = ? AND bunny_video_id = ?").bind(imp.lecture_id, vid)]
          : []),
      ]);
    } else if (FAILED.includes(video.status)) {
      await db.prepare("UPDATE zoom_imports SET status = 'failed', note = 'Bunny could not process the video.', updated_at = datetime('now') WHERE id = ?").bind(imp.id).run();
    }
  }
}
