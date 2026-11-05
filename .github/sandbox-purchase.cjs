const R = (s) => console.log('RESULT ' + s);
(async () => {
  const out = [];
  for (const p of ['/', '/programs', '/enroll', '/sign-in', '/dashboard', '/admin/payment-links', '/terms']) {
    const r = await fetch('https://usmle100.com' + p, { redirect: 'manual' });
    out.push(`${p} ${r.status}`);
  }
  R(out.join(' · '));
})();
