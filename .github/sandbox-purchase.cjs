const R = (s) => console.log('RESULT ' + s);
(async () => {
  const r = await fetch('https://v12-frontend-usmle100.info-usmle100.workers.dev/__staging');
  const t = await r.text();
  for (let i = 0; i < Math.min(t.length, 700); i += 130) R(t.slice(i, i + 130));
})();
