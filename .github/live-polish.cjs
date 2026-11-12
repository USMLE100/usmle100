const fs = require('fs');
(async () => {
  const css = await (await fetch('https://usmle100.com/styles.css', { cache: 'no-store' })).text();
  const out = `phone fullscreen css live: ${css.includes('.pp.pp-max .pp-stage')} · home ${(await fetch('https://usmle100.com/')).status}`;
  fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync('shots/live-fs.txt', out + '\n'); console.log(out);
})();
