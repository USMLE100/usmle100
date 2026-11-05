const R = (s) => console.log('RESULT ' + s);
(async () => {
  const out = [];
  for (const p of ['/', '/programs', '/sign-in', '/sign-up', '/dashboard', '/terms', '/privacy', '/refund-policy']) {
    const r = await fetch('https://usmle100.com' + p, { redirect: 'manual' });
    out.push(`${p} ${r.status}`);
  }
  R(out.join(' · '));
  const t = (await (await fetch('https://usmle100.com/programs')).text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = t.match(/[^.]{0,60}November \d+, 2026[^.]{0,40}/g) || [];
  R('programs dates: ' + (m.join(' | ') || 'no November date shown').slice(0, 130));
  R('Nov 2 mentioned: ' + /November 2, 2026/.test(t) + ' · Nov 9 mentioned: ' + /November 9, 2026/.test(t) + ' · error page: ' + /Something went wrong/.test(t));
})();
