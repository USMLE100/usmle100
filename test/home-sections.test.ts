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
  const decode = (h: string) => h.replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');
  it('shows all six students with name, school and their complete words exactly as supplied, and the disclaimer once', async () => {
    const { TESTIMONIALS: T, TESTIMONIAL_DISCLAIMER } = await import('../src/views/testimonials');
    expect(T.map((t) => t.name)).toEqual(['Mohammed', 'Maria', 'Elijah', 'Jennifer', 'Amelia', 'José']);
    expect(new Set(T.map((t) => t.portrait)).size).toBe(6);
    const html = decode(await home());
    for (const t of T) {
      expect(html, t.name).toContain(`<span class="hv-name">${t.name}</span><span class="sr-only">, </span><span class="hv-school">${t.school}</span>`);
      // The complete testimonial is in the page (shortened only visually, with Read more).
      expect(html, t.name).toContain(`“${t.quote}”`);
    }
    expect(html.split(TESTIMONIAL_DISCLAIMER).length - 1).toBe(1);
    expect(html.indexOf(TESTIMONIAL_DISCLAIMER)).toBeGreaterThan(html.lastIndexOf('class="hv-row b"'));
    expect(html).not.toMatch(/★|class="stars"/);
    // Only these six testimonials appear, reused for the loop; copies are hidden from screen readers.
    const names = [...html.matchAll(/<span class="hv-name">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(new Set(names.filter(Boolean))).toEqual(new Set(T.map((t) => t.name)));
    for (const m of html.matchAll(/<figure class="hv-card"[^>]*data-copy[^>]*>/g)) expect(m[0]).toContain('aria-hidden="true"');
    expect(html).toContain('<dialog id="hv-dialog"');
  });
});
