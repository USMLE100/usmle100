import { Icon } from './icons';

/**
 * The protected lecture player. The page holds no video link: the script asks the server for one
 * (POST /play/claim), which also takes the one-protected-tab slot and opens a viewing session.
 * It then talks to the Bunny player through the player.js protocol to report what is actually watched,
 * pauses when the tab is hidden or progress can't be confirmed for 30 seconds, and keeps a moving watermark
 * (name, account number, viewing-session code) over the video, also in full screen.
 */
export const ProtectedPlayer = (p: { item: string; title: string }) => (
  <div class="pp" id="pp" data-item={p.item} data-title={p.title}>
    <div class="pp-stage">
      <div class="pp-frame"></div>
      <div class="pp-wm-faint" aria-hidden="true"></div>
      <div class="pp-wm" aria-hidden="true"></div>
      <div class="pp-overlay" role="status" aria-live="polite">
        <div class="pp-card">
          <p class="pp-msg">Loading the lecture…</p>
          <div class="pp-actions"></div>
        </div>
      </div>
    </div>
    <div class="pp-bar">
      <button type="button" class="btn btn-outline btn-sm" data-pp-end hidden><Icon name="close" size={18} />End Lecture</button>
      <button type="button" class="btn btn-ghost btn-sm" data-pp-fs hidden><Icon name="open" size={18} />Full screen</button>
      <span class="pp-done" data-pp-done hidden role="status"><Icon name="check" size={16} />Lecture completed</span>
    </div>
    {/* Bunny's own player.js client (bunny.net/docs/stream/playback-api). Optional: the player also speaks the protocol directly. */}
    <script async src="https://assets.mediadelivery.net/playerjs/playerjs-latest.min.js" onload="window.dispatchEvent(new Event('u100-pj'))"></script>
    <script dangerouslySetInnerHTML={{ __html: PLAYER_JS }} />
  </div>
);

export const PLAYER_JS = `(function(){
var root=document.getElementById('pp');if(!root||root.dataset.init)return;root.dataset.init='1';
var ITEM=root.dataset.item,box=root.querySelector('.pp-frame'),wm=root.querySelector('.pp-wm'),faint=root.querySelector('.pp-wm-faint'),ov=root.querySelector('.pp-overlay'),msg=root.querySelector('.pp-msg'),acts=root.querySelector('.pp-actions'),endB=root.querySelector('[data-pp-end]'),doneN=root.querySelector('[data-pp-done]'),fsB=root.querySelector('[data-pp-fs]'),stage=root.querySelector('.pp-stage');
function rand(){var a=new Uint8Array(12);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
var TAB;try{TAB=sessionStorage.getItem('u100tab');if(!TAB){TAB=rand();sessionStorage.setItem('u100tab',TAB)}}catch(e){TAB=rand()}
var D={lib:false,libReady:false,rawReady:false,msgs:0,ev:{},origins:[],other:0,sample:'',subs:0,answers:0};
var S={sid:null,nonce:null,frame:null,origin:'',ready:false,playing:false,last:null,ranges:[],pos:0,dur:0,okAt:Date.now(),block:null,resume:0,wasPlaying:false,timer:null,lid:0};
function post(u,b){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b)})}
function show(t,buttons){msg.textContent=t;acts.innerHTML='';(buttons||[]).forEach(function(b){var x=document.createElement(b.href?'a':'button');x.className='btn '+(b.primary?'btn-primary':'btn-outline');x.textContent=b.label;if(b.href)x.href=b.href;else{x.type='button';x.onclick=b.fn}acts.appendChild(x)});ov.hidden=false}
function hide(){ov.hidden=true}
function block(kind,t,buttons){S.block=kind;cmd('pause');setPlaying(false);show(t,buttons)}
function unblock(){S.block=null;hide()}
function setPlaying(v){S.playing=v;root.classList.toggle('pp-live',v)}
function cmd(m,v,l){if(!S.frame||!S.frame.contentWindow)return;if(S.pj&&D.libReady&&!l){try{if(m==='pause')S.pj.pause();else if(m==='play')S.pj.play();else if(m==='setCurrentTime')S.pj.setCurrentTime(v)}catch(x){}}var o={context:'player.js',version:'0.0.11',method:m};if(v!==undefined)o.value=v;if(l)o.listener=l;S.frame.contentWindow.postMessage(JSON.stringify(o),S.origin)}
function teardown(){S.pj=null;if(S.frame){S.frame.remove();S.frame=null}S.ready=false;setPlaying(false);S.last=null;clearTimeout(S.timer);endB.hidden=true;fsB.hidden=true}
function claim(){teardown();show('Loading the lecture…');post('/play/claim',{item:ITEM,tab:TAB,continue:S.completed&&S.sid?S.sid:undefined}).then(function(r){if(r.status===401){location.href='/sign-in?ended=idle&next='+encodeURIComponent(location.pathname);return null}return r.json()}).then(function(j){if(!j)return;handle(j)}).catch(function(){show('We couldn’t load the lecture. Check your connection.',[{label:'Try again',primary:true,fn:claim}])})}
function handle(j){
 if(j.state==='account'){location.href=j.url;return}
 if(j.state==='busy'){S.block='busy';show('Another lecture'+(j.title?' (“'+j.title+'”)':'')+' is open in another tab or window. Close it or press End Lecture there, then try again. A closed tab is released automatically within 2 minutes.',[{label:'Try again',primary:true,fn:claim}]);return}
 if(j.state==='locked'){S.block='locked';var b=[];if(j.request&&!j.requested)b.push({label:'Request additional access',primary:true,fn:function(){post('/play/request',{item:ITEM}).then(function(){j.requested=true;handle(j)})}});show(j.requested?'Your lecture access has been completed. Your request for additional access has been sent to USMLE100.':j.request?'Your lecture access has been completed.':'Your lecture access has been completed. Please contact USMLE100 if you need help.',b);return}
 if(j.state==='sharing'){S.block='sharing';show(j.locked?'Your account has been locked because your lectures were played on two devices in different places at the same time. Please contact USMLE100.':'This lecture is already playing on another device in a different place. Your account is for you alone: a warning has been recorded, and a repeat will lock your account.',j.locked?[{label:'OK',primary:true,href:'/account/suspended'}]:[{label:'Try again',primary:true,fn:claim}]);return}
 if(j.state==='redirect'){location.href=j.url;return}
 if(j.state==='profile'){show('Before you watch, please add your phone number, the exam you’re preparing for and your graduation year.',[{label:'Complete my details',primary:true,href:'/account?next='+encodeURIComponent(location.pathname)}]);return}
 if(j.state==='novideo'){show(j.message||'The video for this lecture isn’t available yet.');return}
 if(j.state!=='ok'){show('This lecture isn’t available to you.');return}
 S.sid=j.sid;S.nonce=j.nonce;S.completed=!!j.completed;doneN.hidden=!S.completed;S.resume=j.pos||0;S.okAt=Date.now();S.ttl=+j.ttl||900;S.linkAt=Date.now();S.fail=null;S.movedAt=0;
 wm.textContent=j.wm.name+' · ID '+j.wm.id;moveWm();var ft=('ID '+j.wm.id+' · '+j.wm.code).replace(/[<>&"']/g,'');faint.style.backgroundImage='url("data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text x="20" y="40" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#808080" fill-opacity="0.09">'+ft+'</text><text x="180" y="100" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#808080" fill-opacity="0.09">'+ft+'</text></svg>')+'")';
 if(j.first){show(j.notice,[{label:'Start lecture',primary:true,fn:function(){load(j.src)}}])}else load(j.src)}
function load(src){unblock();S.origin=new URL(src).origin;var f=document.createElement('iframe');f.src=src;f.title=root.dataset.title||'Lecture';f.setAttribute('allow',"autoplay; encrypted-media; picture-in-picture 'none'; fullscreen 'none'; display-capture 'none'");
// Sealed frame: the video player can run, but cannot open windows or tabs, download files, cast, or navigate this page.
f.setAttribute('sandbox','allow-scripts allow-same-origin');f.setAttribute('referrerpolicy','strict-origin');box.appendChild(f);S.frame=f;libAttach(f);endB.hidden=false;var fs=stage.requestFullscreen||stage.webkitRequestFullscreen;fsB.hidden=!fs;schedule(1000)}
addEventListener('message',function(e){if(!S.frame)return;var d=e.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){if(e.origin===S.origin){D.other++;if(!D.sample)D.sample=String(e.data).slice(0,40)}return}}if(!d||d.context!=='player.js'){if(e.origin===S.origin){D.other++;if(!D.sample)try{D.sample=Object.keys(d||{}).slice(0,6).join(',')}catch(x){}}return}D.msgs++;if(D.origins.indexOf(e.origin)<0&&D.origins.length<4)D.origins.push(e.origin);if(e.source!==S.frame.contentWindow&&e.origin!==S.origin)return;
 if(d.event==='ready'){D.rawReady=true;S.ready=true;subscribe();
  // On some devices (iPad Safari) a subscription sent the instant the player says "ready" is lost: repeat it until events arrive.
  [1500,4000,10000,20000].forEach(function(ms){setTimeout(function(){if(S.frame&&!Object.keys(D.ev).length)subscribe()},ms)});
  if(S.resume>5)cmd('setCurrentTime',S.resume);return}
 // Answers to our progress questions (see poll): where the video is, whether it is paused, how long it is.
 if(d.event==='getCurrentTime'||d.listener==='g1'){D.answers++;var tt=+d.value;if(isFinite(tt)&&!S.pollPaused)onEv('timeupdate',{seconds:tt,duration:S.dur||0},true);return}
 if(d.event==='getPaused'||d.listener==='g2'){D.answers++;var pz=d.value===true||d.value==='true';if(pz&&!S.pollPaused&&S.playing)onEv('pause',null,true);S.pollPaused=pz;return}
 if(d.event==='getDuration'||d.listener==='g3'){D.answers++;var du=+d.value;if(du>0)S.dur=du;return}
 onEv(d.event,d.value)});
function subscribe(){D.subs++;['play','pause','timeupdate','ended','error'].forEach(function(ev,i){cmd('addEventListener',ev,'u'+i)})}
// Fallback when the player sends no time updates: ask it every second where the video is (stops as soon as real updates arrive).
setInterval(function(){if(!S.frame||!(D.rawReady||D.libReady)||S.block||document.visibilityState==='hidden')return;if(S.tuAt&&Date.now()-S.tuAt<2500)return;if(!S.dur)cmd('getDuration',undefined,'g3');cmd('getPaused',undefined,'g2');cmd('getCurrentTime',undefined,'g1')},1000);
function onEv(ev,v,polled){if(!polled){D.ev[ev]=(D.ev[ev]||0)+1;if(ev==='timeupdate')S.tuAt=Date.now()}
 // A real playback error (not 'unknown command' 2 or 'autoplay blocked' 5) is a technical failure.
 if(ev==='error'){var code=v&&v.code;if(code!==2&&code!==5&&S.sid&&!S.fail){S.fail='player-error';schedule(0)}return}
 if(ev==='play'){if(S.block||document.visibilityState==='hidden'){cmd('pause');return}
  // Video links are short-lived. After a long pause, get a fresh one (same viewing, same place) instead of reusing an old link.
  if(!S.playing&&S.linkAt&&Date.now()-S.linkAt>(S.ttl-30)*1000){cmd('pause');D.refreshed=(D.refreshed||0)+1;claim();return}if(!S.playing){S.movedAt=Date.now();setPlaying(true);schedule(500)}return}
 if(ev==='pause'||ev==='ended'){if(S.playing){setPlaying(false);schedule(300)}return}
 if(ev==='timeupdate'&&v){var s=+v.seconds,du=+v.duration;if(du>0)S.dur=du;
  // Time moving forward in small steps means the video is playing, even if the play message was missed.
  if(!S.playing&&!S.block&&S.last!=null&&s>S.last&&s-S.last<=3&&document.visibilityState!=='hidden'){setPlaying(true);schedule(500)}
  if(S.last==null||s!==S.last)S.movedAt=Date.now();
  if(S.playing&&S.last!=null&&s>S.last&&s-S.last<=3)add(S.last,s);S.last=s;S.pos=s}}
// Frozen playback: the player says it is playing, the page is visible, but time hasn't moved for 25 seconds.
setInterval(function(){if(S.sid&&S.frame&&S.playing&&!S.block&&!S.fail&&document.visibilityState==='visible'&&S.movedAt&&Date.now()-S.movedAt>25000){S.fail='stalled';schedule(0)}},5000);
addEventListener('u100-pj',function(){if(S.frame&&!S.pj)libAttach(S.frame)});
function libAttach(f){if(!window.playerjs||!playerjs.Player)return;D.lib=true;try{var pj=new playerjs.Player(f);S.pj=pj;pj.on('ready',function(){if(S.pj!==pj)return;D.libReady=true;
  ['play','pause','ended'].forEach(function(ev){pj.on(ev,function(){if(S.pj===pj)onEv(ev)})});
  pj.on('timeupdate',function(v){if(S.pj===pj)onEv('timeupdate',v)});
  pj.on('error',function(v){if(S.pj===pj)onEv('error',v)});
  if(S.resume>5&&!D.rawReady)try{pj.setCurrentTime(S.resume)}catch(x){}})}catch(x){}}
function add(a,b){var r=S.ranges[S.ranges.length-1];if(r&&Math.abs(r[1]-a)<0.01)r[1]=b;else S.ranges.push([a,b])}
function schedule(ms){clearTimeout(S.timer);S.timer=setTimeout(beat,ms)}
var inflight=false;
function beat(){if(!S.sid||!S.frame){return}if(inflight){schedule(2000);return}inflight=true;var sent=S.ranges.slice();var n=sent.length;
 post('/play/beat',{sid:S.sid,tab:TAB,nonce:S.nonce,playing:S.playing,pos:S.pos,dur:S.dur,add:sent,diag:D,failed:S.fail||undefined}).then(function(r){if(r.status===401){location.href='/sign-in?ended=idle&next='+encodeURIComponent(location.pathname);return null}if(!r.ok&&r.status!==403&&r.status!==503)throw 0;return r.json()}).then(function(j){inflight=false;if(!j)return;S.ranges.splice(0,n);S.okAt=Date.now();
  if(j.state==='ok'){if(S.fail==='offline')S.fail=null;if(S.block==='offline'){unblock()}schedule(S.playing?30000:60000);return}
  if(j.state==='account'){location.href=j.url;return}
  if(j.state==='tab'){teardown();block('tab','This lecture was opened in another tab or window, so it stopped here.',[{label:'Watch here instead',primary:true,fn:claim}]);return}
  if(j.state==='interrupted'){teardown();S.fail=null;block('failed','A technical problem interrupted playback. Your viewing and your progress are kept, and nothing was used up. Press Try again to continue where it stopped.',[{label:'Try again',primary:true,fn:claim}]);return}
  if(j.state==='done'){
   // Used at 65%: the lecture keeps playing to the end, with a quiet "Lecture completed" note (owner, 4 Nov 2026).
   if(j.reason!=='expired'){S.completed=true;doneN.hidden=false;schedule(S.playing?30000:60000);return}
   teardown();S.sid=null;S.completed=false;doneN.hidden=true;block('done','This viewing has ended. Press Start lecture to continue where you stopped.',[{label:'Start lecture',primary:true,fn:claim}]);return}
  teardown();block('gone','This lecture is no longer available to you.')}).catch(function(){inflight=false;
  if(Date.now()-S.okAt>45000&&S.block!=='offline'){if(!S.fail)S.fail='offline';block('offline','Connection lost. The lecture is paused until we can confirm your progress again.')}schedule(5000)})}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){S.wasPlaying=S.playing;cmd('pause');schedule(200)}else{if(S.wasPlaying&&!S.block)cmd('play');S.wasPlaying=false}});
var spots=[['auto','3%','16%','auto'],['auto','9%','22%','auto'],['auto','17%','17%','auto'],['auto','5%','29%','auto'],['auto','13%','35%','auto']],cur=-1;
function moveWm(){var i;do{i=Math.floor(Math.random()*spots.length)}while(i===cur&&spots.length>1);cur=i;var p=spots[i];wm.style.top=p[0];wm.style.right=p[1];wm.style.bottom=p[2];wm.style.left=p[3]}
setInterval(moveWm,60000);
setInterval(function(){if(!S.frame)return;var cs=getComputedStyle(wm),fs=getComputedStyle(faint);if(!wm.isConnected||wm.parentNode!==stage||cs.display==='none'||cs.visibility==='hidden'||+cs.opacity<0.2||!wm.textContent||wm.getBoundingClientRect().width<20||!faint.isConnected||faint.parentNode!==stage||fs.display==='none'||fs.visibility==='hidden'||+fs.opacity<0.9||fs.backgroundImage.indexOf('svg')<0){teardown();block('wm','The lecture stopped because its watermark was changed. Reload the page to continue.')}},3000);
endB.onclick=function(){cmd('pause');var t=TAB,p=S.pos;teardown();post('/play/release',{tab:t,pos:p});S.block='ended';show('Lecture ended. You can come back and continue where you stopped.',[{label:'Resume',primary:true,fn:claim}])};
fsB.onclick=function(){if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}else{(stage.requestFullscreen||stage.webkitRequestFullscreen).call(stage)}};
addEventListener('pagehide',function(){if(S.frame&&navigator.sendBeacon)navigator.sendBeacon('/play/release',new Blob([JSON.stringify({tab:TAB,pos:S.pos})],{type:'application/json'}))});
addEventListener('pageshow',function(e){if(e.persisted)claim()});
claim();
})();`;
