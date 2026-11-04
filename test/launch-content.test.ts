import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import sql from '../migrations/0025_launch_content.sql';
import { statements } from '../src/lib/migrate';
import { sha256Hex } from '../src/lib/auth';

// Launch content migration: does nothing on staging/test databases, fills production once.
const db = (env as any).DB as D1Database;
const self = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const run = async () => { for (const s of statements(sql)) await db.prepare(s).run(); };
const val = async (k: string) => (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(k).first<{ value: string }>())?.value;

describe('launch content (0025)', () => {
  it('is a no-op on a development database', async () => {
    await self.fetch(new Request('https://usmle100.test/'));
    await db.prepare("INSERT INTO settings (key, value) VALUES ('db_environment', 'development') ON CONFLICT (key) DO UPDATE SET value = 'development'").run();
    const before = await db.prepare('SELECT COUNT(*) AS n FROM agreements').first<{ n: number }>();
    await run();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agreements').first<{ n: number }>())!.n).toBe(before!.n);
    expect(await val('terms_text')).toBeFalsy();
  });
  it('fills legal pages, tutoring link and contact, clears the student count, publishes the agreement once', async () => {
    await db.prepare("UPDATE settings SET value = 'production' WHERE key = 'db_environment'").run();
    await db.prepare("UPDATE settings SET value = '1,400+' WHERE key = 'student_count'").run();
    try {
      await run();
      await run(); // running twice changes nothing
      expect(await val('terms_text')).toMatch(/^Effective November 3, 2026\. These Terms are an agreement between you and USMLE100 LLC/);
      expect(await val('terms_text')).toContain('\n\n## 20. Disputes\n\n');
      expect(await val('privacy_text')).toMatch(/Privacy|personal information/);
      expect(await val('refund_text')).toMatch(/All sales are final/);
      expect(await val('calendly_url')).toBe('https://calendly.com/usmle100/usmle100-1-on-1-tutoring-60mins');
      expect(await val('contact_email')).toBe('info@usmle100.com');
      expect(await val('student_count')).toBe('');
      const ags = (await db.prepare("SELECT body, body_hash FROM agreements WHERE title = 'USMLE100 Student Content-Protection Agreement'").all<any>()).results;
      expect(ags.length).toBe(1);
      expect(await sha256Hex(ags[0].body)).toBe(ags[0].body_hash);
      expect(ags[0].body).not.toMatch(/date of birth|\*\*/);
      for (const t of [await val('terms_text'), await val('privacy_text'), await val('refund_text')]) expect(t).not.toMatch(/\*\*|\[BUSINESS|\[STATE|1,400/);
    } finally {
      await db.prepare("UPDATE settings SET value = 'development' WHERE key = 'db_environment'").run();
    }
  });
});
