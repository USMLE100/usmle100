const { chromium } = require('playwright');
const BASE = 'https://v12-frontend-usmle100.info-usmle100.workers.dev';
const R = (s) => console.log('RESULT ' + s);
(async () => {
  const b = await chromium.launch(); const c = await b.newContext(); const p = await c.newPage();
  try {
    const email = `sandbox-${Date.now()}@example.com`;
    await p.goto(BASE + '/sign-up');
    for (const [k, v] of [['first_name', 'Sandbox'], ['last_name', 'Buyer'], ['email', email], ['phone', '+15555550142'], ['password', 'correct-horse-battery-sandbox']]) await p.fill(`input[name=${k}]`, v);
    await p.selectOption('select[name=exam]', { index: 1 }); await p.selectOption('select[name=grad_year]', { index: 2 });
    await p.check('input[name=agree]');
    await Promise.all([p.waitForLoadState('domcontentloaded'), p.click('form button[type=submit]')]);
    R('1 signup -> ' + new URL(p.url()).pathname);
    await p.goto(BASE + '/enroll');
    const dashBefore = await (await p.request.get(BASE + '/dashboard', { maxRedirects: 0 })).status();
    R('2 before paying: dashboard ' + dashBefore + ' (302 expected); notice ' + ((await p.content()).includes('all sales are final') ? 'shown' : 'MISSING'));
    await Promise.all([p.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 }), p.click('form[action="/enroll/companion"] button')]);
    R('3 at Stripe checkout: ' + new URL(p.url()).host + ' amount ' + ((await p.textContent('body')).match(/\$1,999\.00/) ? '$1,999.00 ok' : 'not found'));
    await p.waitForSelector('#cardNumber', { timeout: 30000 });
    await p.fill('#cardNumber', '4242 4242 4242 4242'); await p.fill('#cardExpiry', '12 / 34'); await p.fill('#cardCvc', '123');
    if (await p.$('#billingName')) await p.fill('#billingName', 'Sandbox Buyer');
    if (await p.$('#billingPostalCode')) await p.fill('#billingPostalCode', '10001');
    if (await p.$('#billingCountry')) await p.selectOption('#billingCountry', 'US').catch(() => {});
    await p.click('.SubmitButton, button[type=submit]');
    await p.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 90000 });
    R('4 back on site: ' + new URL(p.url()).pathname);
    // The webhook enrolls the student; give it a few seconds, then open the portal.
    let st = 0, path = '';
    for (let i = 0; i < 12; i++) { await p.waitForTimeout(5000); await p.goto(BASE + '/dashboard'); path = new URL(p.url()).pathname; if (path === '/dashboard' || path === '/agreement') break; }
    R('5 after paying: lands on ' + path + ' (agreement or dashboard = enrolled)');
    if (path === '/agreement') {
      await p.fill('input[name=legal_name]', 'Sandbox Buyer'); await p.check('input[name=accept]');
      await Promise.all([p.waitForLoadState('domcontentloaded'), p.click('form[action="/agreement"] button[type=submit]')]);
      R('6 agreement signed -> ' + new URL(p.url()).pathname);
    }
    await p.goto(BASE + '/course-book'); const book = (await p.content()).includes('href="/buy/course-book"') ? 'LOCKED' : 'open';
    await p.goto(BASE + '/lectures'); const lec = new URL(p.url()).pathname;
    R('7 Companion access: Course Book ' + book + ' (open expected), lectures page ' + lec);
    const s = await (await p.request.get(BASE + '/__staging')).json().catch(() => null);
    R('8 staging purchases: ' + JSON.stringify(s && s.purchases ? s.purchases.enrollments : 'n/a') + ' stripe=' + (s && s.stripe) + ' webhook=' + (s && s.stripe_webhook));
  } catch (e) { R('ERROR at ' + p.url().slice(0, 60) + ': ' + String(e.message).slice(0, 70)); }
  await b.close();
})();
