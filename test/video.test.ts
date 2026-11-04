import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importRecording, syncImports } from '../src/lib/zoom';
import { syncDurations } from '../src/lib/catalog';
import { ensureMigrated, statements } from '../src/lib/migrate';
import detachSql from '../migrations/0026_detach_declined.sql';
import { SIGNUP, cookies, makeOwner } from './owner';

// Zoom → Bunny → lecture, with Zoom and Bunny mocked. This checks USMLE100's own logic, not the real services.
const e = env as any;
const db = e.DB as D1Database;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function account(role: 'admin' | 'owner') {
  const email = `video${++n}-${Date.now()}@example.com`;
  const res = await worker.fetch(new Request('https://usmle100.test/sign-up', { method: 'POST', body: new URLSearchParams({ ...SIGNUP, email, password: 'correct-horse-battery' }), headers: { origin: 'https://usmle100.test', 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }));
  const cookie = cookies(res);
  if (role === 'owner') await makeOwner(db, email);
  else await db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(email).run();
  return { cookie };
}

const recording = (meetingId: string, start: string, fileId: string) => ({
  download_token: 'zoom-download-token',
  object: {
    id: meetingId, topic: 'Biochemistry Session 3', start_time: start, share_url: 'https://zoom.us/rec/share/x',
    recording_files: [
      { id: fileId + '-audio', file_type: 'M4A', recording_type: 'audio_only', download_url: 'https://zoom.us/a' },
      { id: fileId, file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'completed', recording_start: start, recording_end: start.replace('T23', 'T23:59').slice(0, 19) + 'Z', download_url: 'https://zoom.us/rec/download/abc' },
    ],
  },
});

describe('Zoom recording to lecture', () => {
  it('a lecture recording is sent to Bunny, attached to that day, waits for the owner’s approval, then goes live, and gets its length', async () => {
    await ensureMigrated(db);
    await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Video test', '2026-10-05')").run();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('zoom_meeting_ids', '11122233344') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    const calls: { url: string; body: any }[] = [];
    let guid = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/videos/fetch')) return new Response('{"success":true}');
      if (url.includes('/videos?')) {
        const title = calls.find((x) => x.url.endsWith('/videos/fetch'))!.body.title;
        guid = 'guid-123';
        return new Response(JSON.stringify({ items: [{ guid, title, status: 4 }] }));
      }
      if (url.endsWith('/videos/guid-123') && init?.method === 'POST') return new Response('{}');
      if (url.endsWith('/videos/guid-123')) return new Response(JSON.stringify({ guid, title: 'x', status: 4, length: 13512 }));
      return new Response('not mocked', { status: 500 });
    });

    // Oct 7 2026, 7 pm New York = Day 3.
    await importRecording(e, recording('11122233344', '2026-10-07T23:00:00Z', 'file-1'));
    const fetchCall = calls.find((x) => x.url.endsWith('/videos/fetch'))!;
    expect(fetchCall.url).toContain(`/library/${e.BUNNY_LIBRARY_ID}/videos/fetch`);
    expect(fetchCall.body.url).toBe('https://zoom.us/rec/download/abc');
    expect(fetchCall.body.headers.Authorization).toBe('Bearer zoom-download-token');
    const lec = (await db.prepare('SELECT l.* FROM lectures l JOIN cohorts c ON c.id = l.cohort_id WHERE c.name = ? AND l.day_number = 3').bind('Video test').first<any>())!;
    expect(lec.status).toBe('processing');

    // Zoom retries the same event: nothing is copied twice.
    await importRecording(e, recording('11122233344', '2026-10-07T23:00:00Z', 'file-1'));
    expect(calls.filter((x) => x.url.endsWith('/videos/fetch')).length).toBe(1);

    await syncImports(e);
    await syncDurations(e);
    const after = (await db.prepare('SELECT * FROM lectures WHERE id = ?').bind(lec.id).first<any>())!;
    expect(after.bunny_video_id).toBe('guid-123');
    expect(after.duration_seconds).toBe(13512);
    // Ready, but students see nothing until the owner's one approval.
    expect(after.status).toBe('processing');
    expect(await db.prepare("SELECT 1 FROM staff_alerts WHERE kind = 'recording.approval'").first()).not.toBeNull();
    const imp = (await db.prepare("SELECT id FROM zoom_imports WHERE zoom_file_id = 'file-1'").first<{ id: number }>())!;
    const owner = await account('owner');
    const admin = await account('admin');
    const approve = (cookie: string) =>
      worker.fetch(new Request(`https://usmle100.test/admin/zoom-imports/${imp.id}/approve`, { method: 'POST', body: new URLSearchParams({ decision: 'approve' }), headers: { cookie, origin: 'https://usmle100.test', 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }));
    expect((await approve(admin.cookie)).status).toBe(403);
    expect((await approve(owner.cookie)).status).toBe(302);
    expect((await db.prepare('SELECT status FROM lectures WHERE id = ?').bind(lec.id).first<any>())!.status).toBe('live');
  });

  it('declining a recording frees its day, so the real recording of that day still attaches (also when declined before Bunny finished)', async () => {
    const fetched: string[] = [];
    let g = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/videos/fetch')) { fetched.push(JSON.parse(init.body).title); return new Response('{"success":true}'); }
      if (url.includes('/videos?')) {
        const tag = decodeURIComponent(url.split('search=')[1]);
        const title = fetched.find((t) => t.includes(`[${tag}]`));
        return new Response(JSON.stringify({ items: title ? [{ guid: `guid-${tag}`, title, status: 4 }] : [] }));
      }
      if (/\/videos\/guid-/.test(url) && init?.method === 'POST') return new Response('{}');
      if (/\/videos\/guid-/.test(url)) return new Response(JSON.stringify({ guid: url.split('/').pop(), title: 'x', status: 4, length: 100 }));
      return new Response('{}');
    });
    const owner = await account('owner');
    const decide = (id: number, decision: string) =>
      worker.fetch(new Request(`https://usmle100.test/admin/zoom-imports/${id}/approve`, { method: 'POST', body: new URLSearchParams({ decision }), headers: { cookie: owner.cookie, origin: 'https://usmle100.test', 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }));
    const day = async (n: number) => (await db.prepare("SELECT l.* FROM lectures l JOIN cohorts c ON c.id = l.cohort_id WHERE c.name = 'Video test' AND l.day_number = ?").bind(n).first<any>())!;
    const impOf = async (file: string) => (await db.prepare('SELECT * FROM zoom_imports WHERE zoom_file_id = ?').bind(file).first<any>())!;

    // Day 4 (Oct 8): a test recording is attached, then declined after Bunny finished.
    await importRecording(e, recording('11122233344', '2026-10-08T23:00:00Z', 'test-rec-a'));
    await syncImports(e);
    expect((await day(4)).bunny_video_id).toBe(`guid-u100-${(await impOf('test-rec-a')).id}`);
    expect((await decide((await impOf('test-rec-a')).id, 'decline')).status).toBe(302);
    expect(await day(4)).toMatchObject({ bunny_video_id: null, status: 'processing' });
    // The real class recording of the same day now attaches.
    await importRecording(e, recording('11122233344', '2026-10-08T23:30:00Z', 'real-rec-a'));
    await syncImports(e);
    expect((await day(4)).bunny_video_id).toBe(`guid-u100-${(await impOf('real-rec-a')).id}`);
    expect((await impOf('real-rec-a')).note).toBeNull();

    // Day 5 (Oct 9): declined while Bunny was still preparing it: the sync never attaches it afterwards.
    await importRecording(e, recording('11122233344', '2026-10-09T23:00:00Z', 'test-rec-b'));
    expect((await decide((await impOf('test-rec-b')).id, 'decline')).status).toBe(302);
    await syncImports(e);
    expect((await day(5)).bunny_video_id).toBeNull();
    expect((await day(5)).status).toBe('processing');
  });

  it('one-time cleanup detaches recordings declined earlier, never a live lecture or an undeclined one', async () => {
    const c = Number((await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('Cleanup', '2026-09-07')").run()).meta.last_row_id);
    const add = async (d: number, status: string, vid: string) => Number((await db.prepare('INSERT INTO lectures (cohort_id, day_number, title, status, bunny_video_id) VALUES (?, ?, ?, ?, ?)').bind(c, d, 'x', status, vid).run()).meta.last_row_id);
    const declinedHidden = await add(1, 'processing', 'vid-declined');
    const liveSameVideo = await add(2, 'live', 'vid-declined-live');
    const waiting = await add(3, 'processing', 'vid-waiting');
    await db.prepare("INSERT INTO zoom_imports (zoom_file_id, meeting_id, topic, bunny_video_id, declined_at) VALUES ('cl-1', '1', 't', 'vid-declined', datetime('now')), ('cl-2', '1', 't', 'vid-declined-live', datetime('now')), ('cl-3', '1', 't', 'vid-waiting', NULL)").run();
    for (const q of statements(detachSql)) await db.prepare(q).run();
    const vid = async (id: number) => (await db.prepare('SELECT bunny_video_id FROM lectures WHERE id = ?').bind(id).first<any>()).bunny_video_id;
    expect(await vid(declinedHidden)).toBeNull();
    expect(await vid(liveSameVideo)).toBe('vid-declined-live');
    expect(await vid(waiting)).toBe('vid-waiting');
  });

  it('recordings of other meetings are ignored once class meeting IDs are saved', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await importRecording(e, recording('99999999999', '2026-10-08T23:00:00Z', 'file-personal'));
    expect(spy).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT 1 FROM zoom_imports WHERE zoom_file_id = 'file-personal'").first()).toBeNull();
  });

  it('a signed Zoom webhook uses the download token Zoom sends at the top level of the event', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return new Response('{"success":true}');
    });
    // Real Zoom shape: download_token is a sibling of "payload", not inside it.
    const { download_token: _ignored, ...object } = recording('11122233344', '2026-10-09T23:00:00Z', 'file-top-token');
    const body = JSON.stringify({ event: 'recording.completed', event_ts: Date.now(), payload: object, download_token: 'top-level-token' });
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = 'v0=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${body}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const res = await worker.fetch(new Request('https://usmle100.test/zoom/webhook', { method: 'POST', body, headers: { 'x-zm-request-timestamp': ts, 'x-zm-signature': sig } }));
    expect(res.status).toBe(200);
    // The copy to Bunny runs after the reply; wait for it.
    for (let i = 0; i < 50 && !calls.some((x) => x.url.endsWith('/videos/fetch')); i++) await new Promise((r) => setTimeout(r, 20));
    const fetchCall = calls.find((x) => x.url.endsWith('/videos/fetch'));
    expect(fetchCall, 'Bunny was asked to copy the recording').toBeTruthy();
    expect(fetchCall!.body.headers.Authorization).toBe('Bearer top-level-token');
    const imp = await db.prepare("SELECT status FROM zoom_imports WHERE zoom_file_id = 'file-top-token'").first<{ status: string }>();
    expect(imp!.status).not.toBe('failed');
  });

  it('a Zoom webhook with a bad signature is refused', async () => {
    const res = await worker.fetch(new Request('https://usmle100.test/zoom/webhook', {
      method: 'POST', body: JSON.stringify({ event: 'recording.completed', payload: {} }),
      headers: { 'x-zm-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-zm-signature': 'v0=bad' },
    }));
    expect(res.status).toBe(401);
  });
});
