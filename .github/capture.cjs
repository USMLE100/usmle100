const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
fs.mkdirSync('cap', { recursive: true });
const sites = [
  ['v12', 'https://usmle100-build-v12-bootcamp-medvi.vercel.app/'],
  ['v4', 'https://usmle100-build-v4-cinematic-gold.vercel.app/dashboard'],
];
(async () => {
  const b = await chromium.launch();
  for (const [tag, url] of sites) {
    for (const [vw, vh, dev] of [[390, 844, 'mobile'], [1440, 900, 'desktop']]) {
      const ctx = await b.newContext({ viewport: { width: vw, height: vh }, recordVideo: dev === 'desktop' ? { dir: `cap/${tag}-video`, size: { width: 1280, height: 800 } } : undefined });
      const p = await ctx.newPage();
      const saved = new Set();
      p.on('response', async (r) => {
        try {
          const u = new URL(r.url());
          if (!/vercel\.app$/.test(u.host)) return;
          const ct = r.headers()['content-type'] || '';
          if (!/(javascript|css|svg|html|json|image|font)/.test(ct)) return;
          const name = (u.pathname.replace(/[^a-zA-Z0-9._-]/g, '_') || 'index').slice(-120);
          if (saved.has(name)) return; saved.add(name);
          fs.mkdirSync(`cap/${tag}-files`, { recursive: true });
          fs.writeFileSync(`cap/${tag}-files/${name}${/html/.test(ct) && !name.endsWith('.html') ? '.html' : ''}`, await r.body());
        } catch {}
      });
      const t0 = Date.now();
      await p.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      for (const ms of [100, 300, 600, 1000, 1500, 2200, 3000, 4500]) {
        await p.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
        await p.screenshot({ path: `cap/${tag}-${dev}-t${ms}.png` }).catch(() => {});
      }
      await p.waitForLoadState('networkidle').catch(() => {});
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `cap/${tag}-${dev}-full.png`, fullPage: true }).catch(() => {});
      fs.writeFileSync(`cap/${tag}-${dev}-dom.html`, await p.content());
      await ctx.close();
    }
  }
  await b.close();
})();
