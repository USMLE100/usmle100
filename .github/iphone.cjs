const { webkit, devices } = require('playwright');
const fs = require('fs'); fs.mkdirSync('shots', { recursive: true });
(async () => {
  const b = await webkit.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  await p.goto('https://usmle100.com/?v=' + Date.now(), { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(1500);
  const hv = p.locator('section.hv');
  await hv.scrollIntoViewIfNeeded();
  for (let k = 0; k < 4; k++) { await p.screenshot({ path: `shots/iphone-testimonials-${k}.png` }); await p.waitForTimeout(2500); }
  // Freeze and measure portraits: is the drawing there?
  const info = await p.evaluate(() => { document.getAnimations().forEach((a) => a.pause()); return [...document.querySelectorAll('.hv-photo')].slice(0, 6).map((e) => { const s = e.querySelector('svg'); const r = e.getBoundingClientRect(); const sr = s ? s.getBoundingClientRect() : null; return `${Math.round(r.width)}x${Math.round(r.height)} svg ${sr ? Math.round(sr.width) + 'x' + Math.round(sr.height) + ' top+' + Math.round(sr.top - r.top) : 'none'}`; }); });
  fs.writeFileSync('shots/iphone-portraits.txt', info.join('\n'));
  await p.locator('.cta-band').scrollIntoViewIfNeeded(); await p.screenshot({ path: 'shots/iphone-cta.png' });
  await p.locator('footer.footer').screenshot({ path: 'shots/iphone-footer.png' });
  await p.locator('section.ways').screenshot({ path: 'shots/iphone-ways.png' });
  await p.locator('section.home-faq').screenshot({ path: 'shots/iphone-faq.png' });
  await b.close();
})();
