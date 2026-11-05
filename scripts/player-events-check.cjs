// Browser regression check for lecture progress tracking (owner, 4 Nov 2026: iPad Safari counted 0 s).
// Run against a local 'wrangler dev' on port 8810 with a signed-up, enrolled student; a stand-in Bunny player
// misbehaves like the iPad did ('late': ignores the first subscription; 'noevents': only answers progress questions).
// Usage: node scripts/player-events-check.cjs late|noevents|normal  (then check view_sessions.watched_seconds > 0).
const { chromium } = require('playwright');
const BASE='http://127.0.0.1:8810', mode=process.argv[2];
const fake = (mode) => `<!doctype html><html><body style="margin:0;background:#222;color:#fff">fake bunny (${mode})<script>
var t=0,paused=true,L={},readyAt=0,MODE=${JSON.stringify(mode)};
function send(o){o.context='player.js';o.version='0.0.11';parent.postMessage(JSON.stringify(o),'*')}
addEventListener('message',function(e){var d;try{d=JSON.parse(e.data)}catch(x){return}if(!d||d.context!=='player.js')return;
 if(d.method==='addEventListener'){if(MODE==='noevents')return;if(MODE==='late'&&Date.now()-readyAt<400)return;L[d.value]=d.listener;return}
 if(d.method==='getCurrentTime')send({event:'getCurrentTime',value:t,listener:d.listener});
 else if(d.method==='getPaused')send({event:'getPaused',value:paused,listener:d.listener});
 else if(d.method==='getDuration')send({event:'getDuration',value:3600,listener:d.listener});
 else if(d.method==='play')paused=false;else if(d.method==='pause')paused=true;});
setTimeout(function(){readyAt=Date.now();send({event:'ready',value:{}});setTimeout(function(){paused=false;if(L.play)send({event:'play',listener:L.play})},800)},300);
setInterval(function(){if(!paused){t+=0.25;if(L.timeupdate)send({event:'timeupdate',value:{seconds:t,duration:3600},listener:L.timeupdate})}},250);
</script></body></html>`;
(async()=>{const b=await chromium.launch();const c=await b.newContext({viewport:{width:1180,height:820}});const p=await c.newPage();
 await p.route('https://iframe.mediadelivery.net/**',r=>r.fulfill({status:200,contentType:'text/html',body:fake(mode)}));
 await p.route('https://assets.mediadelivery.net/**',r=>r.fulfill({status:404,body:''}));
 await p.goto(BASE+'/sign-in');await p.fill('input[name=email]','' + (process.env.QA_EMAIL || '') + '');await p.fill('input[name=password]','' + (process.env.QA_PASSWORD || '') + '');
 await Promise.all([p.waitForLoadState(),p.click('form button[type=submit]')]);
 await p.goto(BASE+'/lectures/1');await p.waitForTimeout(800);
 for (const t of ['Start lecture','Resume','Start']) { const el=p.getByRole('button',{name:t,exact:false}).first(); if(await el.count() && await el.isVisible()){await el.click();await p.waitForTimeout(1000);} }
 await p.waitForTimeout(40000);
 await b.close();})();
