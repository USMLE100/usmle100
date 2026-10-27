import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { readChapter } from './reader';
import { makeOwner } from './owner';

// Phase 2 access rules: who may see books, notes, feedback, cards and the new admin pages.
const BASE = 'https://usmle100.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;

async function req(path: string, opts: { cookie?: string; form?: Record<string, string>; body?: FormData } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { headers, redirect: 'manual' };
  if (opts.form) {
    init.method = 'POST';
    init.body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (opts.body) {
    init.method = 'POST';
    init.body = opts.body;
  }
  return worker.fetch(new Request(BASE + path, init));
}

let n = 0;
async function account(role: 'student' | 'faculty' | 'admin' | 'owner', pkg: string | null = 'max') {
  const email = `p2user${++n}@example.com`;
  const res = await req('/sign-up', { form: { name: 'Phase Two', email, password: 'correct-horse-battery' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const u = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>();
  if (role === 'owner') await makeOwner(db, email);
  else if (role !== 'student') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, u!.id).run();
  if (role === 'student' && pkg) {
    await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at) VALUES (?, ?, 'active', datetime('now'))").bind(u!.id, pkg).run();
  }
  return { cookie, id: u!.id, email };
}

const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

let admin: Awaited<ReturnType<typeof account>>;
let chapterId = 0;

beforeAll(async () => {
  admin = await account('owner');
  const fd = new FormData();
  fd.set('number', '1');
  fd.set('title', 'Test chapter');
  fd.set('live', '1');
  fd.set('pdf', new File([pdfBytes], 'chapter.pdf', { type: 'application/pdf' }));
  const res = await req('/admin/book', { cookie: admin.cookie, body: fd });
  expect(res.status).toBe(302);
  chapterId = (await db.prepare("SELECT id FROM book_chapters WHERE title = 'Test chapter'").first<{ id: number }>())!.id;
});

describe('new admin pages', () => {
  it('faculty may manage sections, lecture details and flash cards, nothing else new', async () => {
    const fac = await account('faculty');
    for (const p of ['/admin/sections', '/admin/cards']) expect((await req(p, { cookie: fac.cookie })).status, p).toBe(200);
    for (const p of ['/admin/book', '/admin/book/new', '/admin/tutoring', '/admin/home-content']) expect((await req(p, { cookie: fac.cookie })).status, p).toBe(404);
    for (const [p, form] of [
      ['/admin/book-access', { email: 'x@example.com' }],
      ['/admin/tutoring', { email: 'x@example.com', held_on: '2026-10-01' }],
      ['/admin/faq', { question: 'x', answer: 'y' }],
      ['/admin/articles', { title: 'x' }],
      [`/admin/book/${chapterId}/delete`, {}],
    ] as [string, Record<string, string>][]) {
      expect((await req(p, { cookie: fac.cookie, form })).status, p).toBe(404);
    }
    expect((await req('/admin/sections', { cookie: fac.cookie, form: { subject_id: '1', title: 'Faculty section' } })).status).toBe(302);
    expect(await db.prepare("SELECT 1 FROM sections WHERE title = 'Faculty section'").first()).not.toBeNull();
  });

  it('students cannot reach any of them', async () => {
    const s = await account('student');
    for (const p of ['/admin/sections', '/admin/cards', '/admin/book', '/admin/tutoring', '/admin/home-content', '/admin/lectures/1']) {
      expect((await req(p, { cookie: s.cookie })).status, p).toBe(404);
    }
  });

  it('a file pretending to be a PDF is refused', async () => {
    const fd = new FormData();
    fd.set('number', '2');
    fd.set('title', 'Fake');
    fd.set('pdf', new File(['<html><script>alert(1)</script>'], 'fake.pdf', { type: 'application/pdf' }));
    const res = await req('/admin/book', { cookie: admin.cookie, body: fd });
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('not a PDF');
    expect(await db.prepare("SELECT 1 FROM book_chapters WHERE title = 'Fake'").first()).toBeNull();
  });
});

describe('Course Book access', () => {
  it('included with Companion and above; Refresher only when given it', async () => {
    const max = await account('student', 'max');
    const got = await readChapter(req, max.cookie, chapterId);
    expect(got.status).toBe(200);
    expect(got.bytes!.slice(0, 5)).toEqual(pdfBytes.slice(0, 5));

    const ref = await account('student', 'refresher');
    expect((await readChapter(req, ref.cookie, chapterId)).bytes).toBeNull();
    expect((await req(`/course-book/${chapterId}/data?s=x`, { cookie: ref.cookie })).status).toBe(404);
    expect(await (await req('/course-book', { cookie: ref.cookie })).text()).toContain('$199');
    await req('/admin/book-access', { cookie: admin.cookie, form: { email: ref.email } });
    expect((await readChapter(req, ref.cookie, chapterId)).status).toBe(200);
  });

  it('unpaid accounts are sent to enroll', async () => {
    const s = await account('student', null);
    expect((await req('/course-book', { cookie: s.cookie })).headers.get('location')).toBe('/enroll');
  });
});

describe('notes are private', () => {
  it('a student cannot see or open another student’s note, but everyone sees faculty notes', async () => {
    const a = await account('student');
    const b = await account('student');
    const fd = new FormData();
    fd.set('title', 'Private note of A');
    fd.set('file', new File(['secret text'], 'a.txt', { type: 'text/plain' }));
    expect((await req('/notes', { cookie: a.cookie, body: fd })).status).toBe(302);
    const note = (await db.prepare("SELECT id FROM notes WHERE title = 'Private note of A'").first<{ id: number }>())!;
    expect((await req(`/notes/${note.id}/file`, { cookie: a.cookie })).status).toBe(200);
    expect((await req(`/notes/${note.id}/file`, { cookie: b.cookie })).status).toBe(404);
    expect(await (await req('/notes', { cookie: b.cookie })).text()).not.toContain('Private note of A');
    expect(await (await req('/search?q=private+note', { cookie: b.cookie })).text()).not.toContain('Private note of A');
    await req(`/notes/${note.id}/delete`, { cookie: b.cookie, form: {} });
    expect(await db.prepare('SELECT 1 FROM notes WHERE id = ?').bind(note.id).first()).not.toBeNull();

    const fac = await account('faculty');
    await req('/notes', { cookie: fac.cookie, form: { title: 'Faculty handout X', body: 'shared' } });
    expect(await (await req('/notes', { cookie: b.cookie })).text()).toContain('Faculty handout X');
  });

  it('only allowed file types are stored', async () => {
    const a = await account('student');
    const fd = new FormData();
    fd.set('title', 'Script');
    fd.set('file', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
    const res = await req('/notes', { cookie: a.cookie, body: fd });
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('isn’t allowed');
  });
});

describe('Ask the Room', () => {
  it('feedback is visible only to its author and staff; staff can hide discussion threads', async () => {
    const a = await account('student');
    const b = await account('student');
    await req('/ask', { cookie: a.cookie, form: { kind: 'feedback', title: 'Feedback from A', body: 'Please add something.' } });
    const fb = (await db.prepare("SELECT id FROM threads WHERE title = 'Feedback from A'").first<{ id: number }>())!;
    expect((await req(`/ask/${fb.id}`, { cookie: a.cookie })).status).toBe(200);
    expect((await req(`/ask/${fb.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await req(`/ask/${fb.id}/reply`, { cookie: b.cookie, form: { body: 'sneaky' } })).status).toBe(404);
    const fac = await account('faculty');
    expect((await req(`/ask/${fb.id}`, { cookie: fac.cookie })).status).toBe(200);

    await req('/ask', { cookie: a.cookie, form: { kind: 'discussion', title: 'Discussion from A', body: 'A question for everyone.' } });
    const d = (await db.prepare("SELECT id FROM threads WHERE title = 'Discussion from A'").first<{ id: number }>())!;
    expect((await req(`/ask/${d.id}`, { cookie: b.cookie })).status).toBe(200);
    // Another student can't resolve or delete it.
    expect((await req(`/ask/${d.id}/status`, { cookie: b.cookie, form: {} })).status).toBe(404);
    expect((await req(`/ask/${d.id}/delete`, { cookie: b.cookie, form: {} })).status).toBe(404);
    await req(`/ask/${d.id}/delete`, { cookie: fac.cookie, form: {} });
    expect((await req(`/ask/${d.id}`, { cookie: b.cookie })).status).toBe(404);
    expect(await (await req('/ask', { cookie: b.cookie })).text()).not.toContain('Discussion from A');
  });

  it('posts are escaped, not rendered as HTML', async () => {
    const a = await account('student');
    await req('/ask', { cookie: a.cookie, form: { kind: 'discussion', title: 'XSS test <img src=x onerror=alert(1)>', body: '<script>alert(1)</script> body' } });
    const html = await (await req('/ask', { cookie: a.cookie })).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('progress can only come from real activity', () => {
  it('flash cards from unwatched lectures, and lectures that are not live, cannot be logged', async () => {
    const s = await account('student');
    const cohort = await db.prepare("INSERT INTO cohorts (name, start_date) VALUES ('P2', '2026-10-05')").run();
    const cid = Number(cohort.meta.last_row_id);
    const l = await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status) VALUES (?, 1, 'Not live yet', 'processing')").bind(cid).run();
    const lid = Number(l.meta.last_row_id);
    await req(`/lectures/${lid}/done`, { cookie: s.cookie, form: {} });
    expect(await db.prepare('SELECT 1 FROM lecture_progress WHERE user_id = ? AND lecture_id = ?').bind(s.id, lid).first()).toBeNull();

    const card = await db.prepare("INSERT INTO flashcards (front, back, lecture_id) VALUES ('Q', 'A', ?)").bind(lid).run();
    await req(`/cards/${card.meta.last_row_id}/rate`, { cookie: s.cookie, form: { rating: 'easy' } });
    expect(await db.prepare('SELECT 1 FROM flashcard_log WHERE user_id = ?').bind(s.id).first()).toBeNull();
  });

  it('a streak freeze can’t be used without a missed day to cover', async () => {
    const s = await account('student');
    await req('/rewards/freeze', { cookie: s.cookie, form: {} });
    expect(await db.prepare('SELECT 1 FROM streak_freezes WHERE user_id = ?').bind(s.id).first()).toBeNull();
  });
});

describe('no remember me (R088-R091)', () => {
  it('the sign-in cookie lasts only for the browser session, even if asked to remember', async () => {
    const s = await account('student');
    const on = await req('/sign-in', { form: { email: s.email, password: 'correct-horse-battery', remember: '1' } });
    expect(on.headers.get('set-cookie')).not.toMatch(/expires=|max-age=/i);
    expect(await (await req('/sign-in')).text()).not.toContain('Remember me');
  });
});
