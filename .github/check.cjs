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
    const names = [...new Set([...home.matchAll(/<span class="hv-name">([^<]+)<\/span><span class="hv-school">([^<]+)<\/span>/g)].map((m) => m[1] + ' (' + m[2].replace(/&#39;|&#x27;/g, "'").split(' ').slice(0, 2).join(' ') + ')'))];
    R(`${tag}: testimonials ${names.length}: ${names.join(', ')}`.slice(0, 138));
    const og = (home.match(/property="og:image" content="([^"]+)"/) || [])[1] || 'none';
    const img = og !== 'none' ? (await fetch(og.replace('https://usmle100.com', base))).status : 0;
    R(`${tag}: FAQ#8 "${(home.match(/<summary>(How will USMLE100 teach me[^<]*)/) || [])[1]}" · shown first ${(home.slice(0, home.indexOf('faq-more')).match(/<summary>/g) || []).length} · share image ${img} · social ${home.includes('class="social"')} · whatsapp group ${home.includes('chat.whatsapp.com/L1gfbXeVnQ60i5kOSeaN8v')}`.slice(0, 138));
    const nav = (home.match(/<nav aria-label="Footer">([\s\S]*?)<\/nav>/) || [])[1] || '';
    R(`${tag}: heading Our programs ${home.includes('<h2>Our programs</h2>')} · Three ways in gone ${!home.includes('Three ways in')} · Refunds in footer links ${nav.includes('/refunds')} · Refund policy in fine print ${home.includes('class="fine" href="/refunds"')}`);
    R(`${tag}: disclaimer ${home.split('Testimonials are furnished in an individual capacity').length - 1} · characters ${labels.length} · FAQ ${(home.match(/<summary>/g) || []).length} · css ${css.includes('.hv-more')}`);
  }
})();
