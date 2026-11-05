const R = (s) => console.log('RESULT ' + s);
(async () => {
  const j = await (await fetch('https://v12-frontend-usmle100.info-usmle100.workers.dev/__staging')).json();
  R('P ' + JSON.stringify(j.purchases));
  for (const e of (j.recent_stripe_events || []).slice(0, 11)) R(`${e.at} ${e.source} ${e.type}: ${e.outcome}`);
})();
