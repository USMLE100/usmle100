const fs = require('fs');
(async () => {
  const css = await (await fetch('https://usmle100.com/styles.css', { cache: 'no-store' })).text();
  const out = `css has fix ${css.includes('.footer > nav a, .footer a.fine')} · old rule gone ${!css.includes('.footer nav a, .footer a.fine')} · home ${(await fetch('https://usmle100.com/')).status}`;
  fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync('shots/live-footer.txt', out + '\n'); console.log(out);
})();
