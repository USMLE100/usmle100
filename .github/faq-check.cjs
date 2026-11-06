const { chromium } = require('playwright');
const approved = require('./approved-faq.json');
const R = (s) => console.log('RESULT ' + s);
const norm = (s) => s.replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  for (const [w, h, dev] of [[390, 844, 'mobile'], [1440, 900, 'desktop']]) {
    const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
    await p.goto('https://usmle100.com/', { waitUntil: 'networkidle' });
    const items = p.locator('.home-faq details');
    const n = await items.count();
    let ok = 0; const bad = [];
    for (let i = 0; i < n; i++) {
      const d = items.nth(i);
      await d.locator('summary').scrollIntoViewIfNeeded();
      await d.locator('summary').click();
      await p.waitForTimeout(80);
      const open = await d.evaluate((e) => e.open);
      const q = norm(await d.locator('summary').innerText());
      const paras = (await d.locator('p').allInnerTexts()).map(norm);
      const visible = await d.locator('p').evaluateAll((ps) => ps.every((x) => x.offsetHeight > 0 && getComputedStyle(x).visibility !== 'hidden'));
      const a = approved[i];
      const same = a && q === norm(a.q) && paras.length === a.a.length && paras.every((t, k) => t === norm(a.a[k]));
      if (same && open && visible) ok++; else bad.push(`#${i + 1}${!a ? ' extra' : q !== norm(a.q) ? ' question differs' : !open ? ' did not open' : !visible ? ' answer hidden' : ' answer differs'}`);
      if (dev === 'mobile') R(`${String(i + 1).padStart(2, '0')}. ${q}`);
    }
    R(`${dev}: ${n} questions on the page · ${ok} of 18 match the approved question and full answer and open fully${bad.length ? ' · problems: ' + bad.join(', ') : ''}`);
  }
  await b.close();
})();
