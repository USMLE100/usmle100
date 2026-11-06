import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { knownPathCheck, routeRegex } from '../src/lib/knownPath';

// Owner's choices, 6 Nov 2026 (one-by-one review of the improvement list).
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const get = (path: string) => worker.fetch(new Request('https://usmle100.test' + path, { redirect: 'manual' }));
const page = async (path: string) => (await (await get(path)).text()).replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');

describe('homepage wording', () => {
  it('uses the chosen headings, lines and buttons', async () => {
    const h = await page('/');
    for (const s of [
      'Medical board prep, <em>taught live</em> by physicians.',
      'Live classes every weekday. One-on-one tutoring. A clear plan, so you always know what to study next.',
      'Taught by physicians', 'Live every weekday', '100-day curriculum', 'Progress tracking',
      'A Structured Approach to Medical Board Preparation',
      'Student experiences', 'In Our <em>Students’ Words</em>',
      '<h3>100-Day Programs</h3>', 'View programs', 'Learn more',
      'Begin Your Preparation With USMLE100', 'Compare our programs and start learning with physicians from Day 1.',
      'Questions? Join our WhatsApp group', 'Explore Programs',
      'We’re building a trusted platform for physicians at every stage of their careers',
    ]) expect(h, s).toContain(s);
    for (const s of ['Daily live classes', 'No endless video library', 'Live daily', 'One price', 'raving about us', 'Ready to start?', 'teaching yourself', 'See programs', 'btn-gold', 'most trusted'])
      expect(h, s).not.toContain(s);
    // The disclaimer stays word for word.
    const { TESTIMONIAL_DISCLAIMER } = await import('../src/views/testimonials');
    expect(h).toContain(TESTIMONIAL_DISCLAIMER);
  });
  it('footer: LLC copyright, trademark line naming ECFMG, reply time; contact rows unchanged', async () => {
    const h = await page('/');
    expect(h).toMatch(/© \d{4} USMLE100 LLC\. All rights reserved\./);
    expect(h).toContain('USMLE® is a registered trademark of FSMB and NBME, and COMLEX-USA® of NBOME. USMLE100 is not affiliated with or endorsed by them or by ECFMG.');
    expect(h).toContain('We usually reply within 24 hours.');
    expect(h).toContain('<small>Text</small>');
    expect(h).toContain('<small>WhatsApp</small>');
  });
});

describe('Programs page wording', () => {
  it('uses the chosen names, buttons and the Day 160 answer', async () => {
    const h = await page('/programs');
    for (const s of ['<h1>Our Programs</h1>', 'Full curriculum plus personal mentorship', 'Group practice test during the exam window', 'Live Evening Questions',
      'Your course access, including lectures, recordings and the question bank, lasts until Day 160', 'Personalized', 'Book a tutoring session'])
      expect(h, s).toContain(s);
    for (const s of ['Evening Q’s', 'Preparation Packages', 'Our most complete program', 'together during', 'Personalised', 'organised', 'Inquire about'])
      expect(h, s).not.toContain(s);
    expect(h).toContain('href="https://calendly.com/usmle100/usmle100-1-on-1-tutoring-60mins"');
  });
});

describe('page not found', () => {
  it('a mistyped address shows the 404 page, not the sign-in page', async () => {
    const r = await get('/progams');
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('We can’t find that page');
  });
  it('real pages still work, and portal pages still ask a visitor to sign in', async () => {
    for (const p of ['/', '/programs', '/sign-in', '/sign-up', '/webinars', '/free-lectures']) expect((await get(p)).status, p).not.toBe(404);
    for (const p of ['/dashboard', '/lectures', '/lectures/1', '/qbank', '/evening', '/course-book', '/account', '/admin/students']) {
      const r = await get(p);
      expect(r.status, p).toBeGreaterThanOrEqual(300);
      expect(r.status, p).toBeLessThan(400);
      expect(r.headers.get('location') ?? '', p).toContain('/sign-in');
    }
  });
  it('every route the app defines counts as known', async () => {
    await get('/');
    const { checkedRoutes } = await import('../src/lib/knownPath');
    const routes = checkedRoutes.map((r) => ({ ...r }));
    expect(routes.length).toBeGreaterThan(100);
    const known = knownPathCheck(routes);
    for (const r of routes) {
      if (r.method !== 'GET' || r.path.includes('*')) continue;
      const sample = r.path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, '12');
      expect(known(sample), r.path).toBe(true);
    }
  });
  it('route patterns', () => {
    expect(routeRegex('/lectures/:id{[0-9]+}')!.test('/lectures/5')).toBe(true);
    expect(routeRegex('/tests/:id{[0-9]+}/:pos{[0-9]+}')!.test('/tests/5/2')).toBe(true);
    expect(routeRegex('/programs')!.test('/progams')).toBe(false);
    expect(routeRegex('/a/:x?')).toBe(null);
    expect(knownPathCheck([{ method: 'GET', path: '/a/:x?' }])('/anything')).toBe(true);
  });
});
