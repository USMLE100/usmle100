const R = (s) => console.log('RESULT ' + s);
(async () => {
  let all = '';
  for (const p of ['/', '/programs', '/faq', '/terms', '/refund-policy', '/sitemap.xml', '/robots.txt']) {
    const r = await fetch('https://usmle100.com' + p);
    all += (await r.text());
  }
  const t = all.replace(/<[^>]+>/g, ' ');
  R('public $1,500: ' + /\$1,500/.test(t) + ' · $1,300: ' + /1,300|1300\.00/.test(t) + ' · $1,381.50: ' + /1,381|1381/.test(t) + ' · buy.stripe.com links: ' + /buy\.stripe\.com/.test(all));
  for (const p of ['/admin/payment-links', '/admin/launch-check']) {
    const r = await fetch('https://usmle100.com' + p, { redirect: 'manual' });
    R(`${p} signed out: ${r.status} -> ${r.headers.get('location')}`);
  }
})();
