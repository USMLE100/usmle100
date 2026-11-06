const fs = require('fs');
(async () => {
  const h = (await (await fetch('https://usmle100.com/', { cache: 'no-store' })).text());
  const out = `intro ${h.includes('Live interactive classes. One-on-one tutoring. A clear plan')} · point ${h.includes('Live interactive sessions</li>')} · old intro gone ${!h.includes('Live classes every weekday')} · old point gone ${!h.includes('90 days of live lectures on weekdays')}`;
  fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync('shots/live-wording.txt', out + '\n'); console.log(out);
})();
