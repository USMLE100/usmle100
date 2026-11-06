import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'hono/jsx/dom/server';
import { Testimonials, WHO, TESTIMONIALS } from '../src/views/homeSections';

// Restored V12 homepage sections (owner, 5 Nov 2026).
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const home = async () => (await (await worker.fetch(new Request('https://usmle100.test/'))).text()).replace(/&amp;/g, '&');

describe('who we teach', () => {
  it('shows the owner’s six labels in order, once each to readers, replacing the old three cards', async () => {
    expect(WHO.map((w) => w.label)).toEqual(['US Medical Students', 'IMGs & FMGs', 'Repeat Takers', 'CBSE & Comp Exam Students', 'Residency Applicants', 'USMLE Step 1, 2 & 3 Students']);
    const html = await home();
    const visible = [...html.matchAll(/<a class="hw-tile"(?![^>]*data-copy)[^>]*>[\s\S]*?<span class="hw-cap"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(visible).toEqual(WHO.map((w) => w.label));
    expect(html).not.toContain('class="aud-wrap"');
    // Copies used for the loop are hidden from screen readers and keyboard.
    for (const m of html.matchAll(/<a class="hw-tile"[^>]*data-copy[^>]*>/g)) expect(m[0]).toMatch(/aria-hidden="true"/);
    // Every card holds one complete drawn person: face, eyes, neck, coat and stethoscope.
    const figs = [...html.matchAll(/<span class="hw-pop">(<svg[\s\S]*?<\/svg>)<\/span>/g)].map((m) => m[1]);
    expect(figs.length).toBe(24);
    for (const f of figs.slice(0, 6)) {
      expect(f).toContain('viewBox="0 0 200 222"');
      expect(f).toContain('M100 50 C121 50');
      expect(f).toContain('ellipse cx="87" cy="93"');
      expect(f).toContain('#F7F6F2');
      expect(f).toContain('stroke="#3B4A55"');
    }
  });
});

describe('testimonials', () => {
  it('is not shown on the homepage until real, approved testimonials are added', async () => {
    expect(TESTIMONIALS.length).toBe(0);
    const html = await home();
    expect(html).not.toContain('class="hv"');
    expect(html).not.toContain('raving about us');
  });
  it('when given testimonials, shows each student’s exact words and name with no ratings', () => {
    const items = [{ name: 'A. Student', quote: 'Exact words.' }, { name: 'B. Student', quote: 'Other words.' }];
    const html = renderToString(Testimonials({ items }) as any);
    expect(html).toContain('There’s a reason students are');
    expect(html).toContain('“Exact words.”');
    expect(html).toContain('B. Student');
    expect(html).not.toMatch(/★|stars/);
  });
});
