import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { HOME_FAQ } from '../src/views/homeFaq';

const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const page = async (p: string) => (await worker.fetch(new Request('https://usmle100.test' + p))).text();
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');

describe('homepage FAQ (owner, 5 Nov 2026)', () => {
  it('shows the 18 questions in the owner’s order, in the accordion, with the approved #17 correction', async () => {
    expect(HOME_FAQ.length).toBe(18);
    const html = decode(await page('/'));
    let at = 0;
    for (const [q] of HOME_FAQ) {
      const i = html.indexOf(`<summary>${q}`, at);
      expect(i, q).toBeGreaterThan(at);
      at = i;
    }
    expect(HOME_FAQ[0][0]).toBe('I’ve tried UWorld, First Aid, and other USMLE prep resources. Why am I still struggling?');
    expect(HOME_FAQ[17][0]).toBe('What exactly is included in the 100-Day Program, and how do I enroll?');
    expect(HOME_FAQ[16][1].join(' ')).toContain('after Day 100 of the program');
    expect(html).not.toContain('100 instructional days');
    expect(html).toContain('<a href="/programs">Programs page</a>');
  });
  it('the Programs page FAQ is unchanged', async () => {
    const html = decode(await page('/programs'));
    for (const q of ['Are these one-time payments?', 'How long is the program?', 'Can I download the recordings?']) expect(html).toContain(q);
    expect(html).not.toContain('Why am I still struggling?');
  });
});
