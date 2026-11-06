import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// Share preview (owner, 5 Nov 2026): what WhatsApp and Facebook show when usmle100.com is posted.
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
describe('share preview', () => {
  it('the homepage tells apps which picture, title and sentence to show', async () => {
    const html = await (await worker.fetch(new Request('https://usmle100.test/'))).text();
    expect(html).toContain('<meta property="og:image" content="https://usmle100.com/share.jpg"/>');
    expect(html).toContain('<meta property="og:title" content="USMLE100 · Board prep, taught live by doctors"/>');
    expect(html).toContain('<meta property="og:description" content="Live daily classes taught by doctors, one-on-one tutoring and a structured 100-day program."/>');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  });
});
