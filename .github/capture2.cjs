const { chromium } = require('playwright');
const fs = require('fs');
fs.mkdirSync('cap/start-files', { recursive: true });
(async () => {
  const b = await chromium.launch();
  for (const [vw, vh, dev] of [[390, 844, 'mobile'], [1440, 900, 'desktop']]) {
    const ctx = await b.newContext({ viewport: { width: vw, height: vh } });
    const p = await ctx.newPage();
    p.on('response', async (r) => {
      try {
        const u = new URL(r.url()); if (!/vercel\.app$/.test(u.host)) return;
        const ct = r.headers()['content-type'] || ''; if (!/(javascript|css|svg|json|image)/.test(ct)) return;
        fs.writeFileSync('cap/start-files/' + (u.pathname.replace(/[^a-zA-Z0-9._-]/g, '_') || 'index').slice(-120), await r.body());
      } catch {}
    });
    await p.goto('https://usmle100-build-v12-bootcamp-medvi.vercel.app/start', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(2000);
    // Scroll through slowly so on-scroll animations run, then full page.
    const H = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += Math.round(vh * 0.6)) { await p.evaluate((y) => window.scrollTo(0, y), y); await p.waitForTimeout(500); }
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(800);
    await p.screenshot({ path: `cap/start-${dev}-full.png`, fullPage: true });
    fs.writeFileSync(`cap/start-${dev}-dom.html`, await p.content());
    // Movement: the character strip and the testimonial area over a few seconds.
    for (const [sel, tag] of [['text=Repeat takers', 'chars'], ['text=raving about us', 'testi']]) {
      const el = p.locator(sel).first();
      if (await el.count()) {
        await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
        for (let k = 0; k < 6; k++) { await p.screenshot({ path: `cap/start-${dev}-${tag}-${k}.png` }); await p.waitForTimeout(700); }
      }
    }
    await ctx.close();
  }
  await b.close();
})();
