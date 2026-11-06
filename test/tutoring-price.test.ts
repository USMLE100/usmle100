import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import sql from '../migrations/0035_tutoring_price.sql';
import { statements } from '../src/lib/migrate';

// Tutoring is $49.99 per session (owner, 5 Nov 2026); Evening Questions stays $160.
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const db = (env as any).DB as D1Database;
const page = async (p: string) => (await (await worker.fetch(new Request('https://usmle100.test' + p))).text()).replace(/&amp;/g, '&');
describe('tutoring price', () => {
  it('homepage and Programs page show $49.99 for tutoring and keep $160 for Evening Questions', async () => {
    for (const p of ['/', '/programs']) {
      const html = await page(p);
      expect(html, p).toContain('$49.99');
      expect(html, p).not.toMatch(/\$50(?![.\d])/);
      expect(html, p).toContain('$160');
    }
  });
  it('the Terms change only that one figure', async () => {
    const before = 'Current prices: MedSchool Refresher $1,500; one-on-one tutoring $50 per 60-minute session; Evening Questions $160 per month.';
    await db.prepare("INSERT INTO settings (key, value) VALUES ('terms_text', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(before).run();
    await db.batch(statements(sql).map((s) => db.prepare(s)));
    const after = (await db.prepare("SELECT value FROM settings WHERE key = 'terms_text'").first<{ value: string }>())!.value;
    expect(after).toBe(before.replace('$50 per', '$49.99 per'));
  });
});
