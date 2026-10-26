import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importRecording, syncImports } from '../src/lib/zoom';
import { syncDurations } from '../src/lib/catalog';
import { ensureMigrated } from '../src/lib/migrate';

// Zoom → Bunny → lecture, with Zoom and Bunny mocked. This checks USMLE100's own logic, not the real services.
const e = env as any;
const db = e.DB as D1Database;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
afterEach(() => vi.restoreAllMocks());

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
  it('a lecture recording is sent to Bunny, attached to that day, goes live when ready, and gets its length', async () => {
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
    expect(after.status).toBe('live');
    expect(after.duration_seconds).toBe(13512);
  });

  it('recordings of other meetings are ignored once class meeting IDs are saved', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await importRecording(e, recording('99999999999', '2026-10-08T23:00:00Z', 'file-personal'));
    expect(spy).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT 1 FROM zoom_imports WHERE zoom_file_id = 'file-personal'").first()).toBeNull();
  });

  it('a Zoom webhook with a bad signature is refused', async () => {
    const res = await worker.fetch(new Request('https://usmle100.test/zoom/webhook', {
      method: 'POST', body: JSON.stringify({ event: 'recording.completed', payload: {} }),
      headers: { 'x-zm-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-zm-signature': 'v0=bad' },
    }));
    expect(res.status).toBe(401);
  });
});
