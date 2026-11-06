// Read-only check of the live site after the 6 Nov polish launch.
const fs = require('fs');
const out = [];
const R = (s) => out.push(s);
(async () => {
  const base = 'https://usmle100.com';
  for (const p of ['/', '/programs', '/sign-in', '/sign-up', '/webinars', '/terms', '/share.jpg', '/styles.css']) R(`${p} ${(await fetch(base + p, { redirect: 'manual' })).status}`);
  for (const p of ['/dashboard', '/lectures', '/qbank', '/admin/students']) { const r = await fetch(base + p, { redirect: 'manual' }); R(`${p} ${r.status} -> ${r.headers.get('location')}`); }
  const typo = await fetch(base + '/progams', { redirect: 'manual' }); R(`/progams ${typo.status} notfound-page ${(await typo.text()).includes('find that page')}`);
  const dec = (t) => t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'");
  const home = dec(await (await fetch(base + '/')).text());
  const prog = dec(await (await fetch(base + '/programs')).text());
  const terms = dec(await (await fetch(base + '/terms')).text());
  const has = (t, s) => `${t.includes(s) ? 'OK ' : 'MISSING '}${s}`;
  const gone = (t, s) => `${t.includes(s) ? 'STILL THERE ' : 'gone '}${s}`;
  for (const s of ['<title>USMLE100 · Physician-Led USMLE, COMLEX & CBSE Preparation</title>', 'Medical board prep, <em>taught live</em> by physicians.', 'Live classes every weekday. One-on-one tutoring. A clear plan', 'Individual learning plans', 'Clinical reasoning', 'A Structured Approach to Medical Board Preparation', 'In Our <em>Students’ Words</em>', 'View programs', 'Learn more', 'Begin Your Preparation With USMLE100', 'Questions? Join our WhatsApp group', 'Explore Programs', 'USMLE100 LLC. All rights reserved.', 'or by ECFMG.', 'We usually reply within 24 hours.', 'a trusted platform for physicians', 'Testimonials are furnished in an individual capacity.']) R(has(home, s));
  for (const s of ['raving about us', 'Daily live classes', 'Ready to start?', '100-day curriculum', 'most trusted']) R(gone(home, s));
  for (const s of ['<h1>Our Programs</h1>', 'Full curriculum plus personal mentorship', 'Book a tutoring session', 'Ask about Evening Questions', 'lasts until Day 160', '$1,500', '$1,999', '$2,449', '$3,799', '$160', '$49.99']) R('programs ' + has(prog, s));
  for (const s of ['Evening Q’s', 'Inquire about', 'Personalised']) R('programs ' + gone(prog, s));
  R('terms ' + has(terms, 'USMLE Steps 1, 2 and 3, COMLEX and CBSE') + ' · $49.99 ' + terms.includes('$49.99 per 60-minute'));
  fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync('shots/live-polish.txt', out.join('\n') + '\n');
  console.log(out.join('\n'));
})();
