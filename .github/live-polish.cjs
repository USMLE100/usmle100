const fs = require('fs');
(async () => {
  const h = (await (await fetch('https://usmle100.com/', { cache: 'no-store' })).text());
  const out = `point2 ${h.includes('Live interactive sessions taught by US physicians, where you can ask questions in real time</li>')}`;
  fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync('shots/live-wording2.txt', out + '\n'); console.log(out);
})();
