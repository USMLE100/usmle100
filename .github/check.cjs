const R = (s) => console.log('RESULT ' + s);
(async () => {
  for (const [tag, base] of [['staging', 'https://v12-frontend-usmle100.info-usmle100.workers.dev'], ['live', 'https://usmle100.com']]) {
    const st = [];
    for (const p of ['/', '/programs', '/sign-in', '/sign-up', '/dashboard', '/styles.css']) st.push(`${p} ${(await fetch(base + p, { redirect: 'manual' })).status}`);
    const home = (await (await fetch(base + '/')).text()).replace(/&amp;/g, '&');
    const css = await (await fetch(base + '/styles.css')).text();
    const labels = [...home.matchAll(/<a class="hw-tile"(?![^>]*data-copy)[^>]*>[\s\S]*?<span class="hw-cap"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    R(`${tag}: ${st.join(' · ')}`);
    R(`${tag}: characters ${labels.length}: ${labels.join(' | ')}`.slice(0, 138));
    R(`${tag}: old 3 cards gone ${!home.includes('aud-wrap')} · testimonials hidden ${!home.includes('class="hv"')} · FAQ ${(home.match(/<summary>/g) || []).length} · css has rail ${css.includes('.hw-rail')}`);
  }
})();
