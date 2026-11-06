import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CONTACT } from '../src/lib/contact';

// Social and contact links (owner, 5 Nov 2026).
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const page = async (p: string) => (await (await worker.fetch(new Request('https://usmle100.test' + p))).text()).replace(/&amp;/g, '&');

describe('contact and social links', () => {
  it('appear in the footer of public pages, open outside links safely, and the homepage links tutoring and the WhatsApp group', async () => {
    for (const p of ['/', '/programs', '/terms']) {
      const html = await page(p);
      for (const u of [CONTACT.facebook, CONTACT.instagram, CONTACT.whatsappGroup, CONTACT.tutoring, `mailto:${CONTACT.email}`, CONTACT.phoneSms, CONTACT.phoneWhatsApp]) expect(html, `${p} ${u}`).toContain(`href="${u}"`);
      for (const m of html.matchAll(/<a [^>]*target="_blank"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer"');
    }
    const home = await page('/');
    expect(home).toMatch(/<a class="addon tile-warm" href="https:\/\/calendly\.com\/usmle100\/usmle100-1-on-1-tutoring-60mins"/);
    expect(home).toContain('Join our WhatsApp group');
    expect(JSON.stringify(CONTACT)).not.toMatch(/utm_|mibextid|dlrf|\?s=/);
  });
});
