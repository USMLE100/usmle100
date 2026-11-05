const R = (s) => console.log('RESULT ' + s);
(async () => {
  for (const [tag, base] of [['staging', 'https://v12-frontend-usmle100.info-usmle100.workers.dev'], ['live', 'https://usmle100.com']]) {
    const st = [];
    for (const p of ['/', '/programs', '/sign-in', '/sign-up', '/dashboard']) st.push(`${p} ${(await fetch(base + p, { redirect: 'manual' })).status}`);
    const home = await (await fetch(base + '/')).text();
    const signin = await (await fetch(base + '/sign-in')).text();
    const prog = await (await fetch(base + '/programs')).text();
    R(`${tag}: ${st.join(' · ')}`);
    R(`${tag}: home FAQ questions ${(home.match(/<summary>/g) || []).length} · first ok ${home.includes('Why am I still struggling?')} · Day 100 fix ${home.includes('after Day 100 of the program')} · programs FAQ kept ${prog.includes('Are these one-time payments?')}`);
    R(`${tag}: sign-in note script ${signin.includes("sessionStorage.setItem('u100-splash','1')")} · passkey script ${signin.includes('/sign-in/passkey/options')} · splash on home ${home.includes('u100-splash')}`);
  }
})();
