import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// Share preview (owner, 5 Nov 2026): what WhatsApp and Facebook show when usmle100.com is posted.
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
describe('share preview', () => {
  it('the homepage tells apps which picture, title and sentence to show', async () => {
    const html = await (await worker.fetch(new Request('https://usmle100.test/'))).text();
    expect(html).toContain('<meta property="og:image" content="https://usmle100.com/share.jpg"/>');
    expect(html).toContain('<meta property="og:title" content="USMLE100 · Physician-Led USMLE, COMLEX &amp; CBSE Preparation"/>');
    expect(html).toContain('<meta property="og:description" content="Live interactive classes taught by physicians, one-on-one tutoring and a structured 100-day program."/>');
    expect(html).toContain('<title>USMLE100 · Physician-Led USMLE, COMLEX &amp; CBSE Preparation</title>');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  });
});
