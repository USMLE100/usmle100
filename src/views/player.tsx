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
      <div class="pp-wm-tile" aria-hidden="true"></div>
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
    </div>
    {/* Bunny's own player.js client (bunny.net/docs/stream/playback-api). Optional: the player also speaks the protocol directly. */}
    <script async src="https://assets.mediadelivery.net/playerjs/playerjs-latest.min.js" onload="window.dispatchEvent(new Event('u100-pj'))"></script>
    <script dangerouslySetInnerHTML={{ __html: PLAYER_JS }} />
  </div>
);

export const PLAYER_JS = `(function(){
var root=document.getElementById('pp');if(!root||root.dataset.init)return;root.dataset.init='1';
var ITEM=root.dataset.item,box=root.querySelector('.pp-frame'),wm=root.querySelector('.pp-wm'),tile=root.querySelector('.pp-wm-tile'),ov=root.querySelector('.pp-overlay'),msg=root.querySelector('.pp-msg'),acts=root.querySelector('.pp-actions'),endB=root.querySelector('[data-pp-end]'),fsB=root.querySelector('[data-pp-fs]'),stage=root.querySelector('.pp-stage');
function rand(){var a=new Uint8Array(12);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
var TAB;try{TAB=sessionStorage.getItem('u100tab');if(!TAB){TAB=rand();sessionStorage.setItem('u100tab',TAB)}}catch(e){TAB=rand()}
var D={lib:false,libReady:false,rawReady:false,msgs:0,ev:{},origins:[]};
var S={sid:null,nonce:null,frame:null,origin:'',ready:false,playing:false,last:null,ranges:[],pos:0,dur:0,okAt:Date.now(),block:null,resume:0,wasPlaying:false,timer:null,lid:0};
function post(u,b){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b)})}
function show(t,buttons){msg.textContent=t;acts.innerHTML='';(buttons||[]).forEach(function(b){var x=document.createElement(b.href?'a':'button');x.className='btn '+(b.primary?'btn-primary':'btn-outline');x.textContent=b.label;if(b.href)x.href=b.href;else{x.type='button';x.onclick=b.fn}acts.appendChild(x)});ov.hidden=false}
function hide(){ov.hidden=true}
function block(kind,t,buttons){S.block=kind;cmd('pause');setPlaying(false);show(t,buttons)}
function unblock(){S.block=null;hide()}
function setPlaying(v){S.playing=v;root.classList.toggle('pp-live',v)}
function cmd(m,v,l){if(!S.frame||!S.frame.contentWindow)return;if(S.pj&&D.libReady&&!l){try{if(m==='pause')S.pj.pause();else if(m==='play')S.pj.play();else if(m==='setCurrentTime')S.pj.setCurrentTime(v)}catch(x){}}var o={context:'player.js',version:'0.0.11',method:m};if(v!==undefined)o.value=v;if(l)o.listener=l;S.frame.contentWindow.postMessage(JSON.stringify(o),S.origin)}
function teardown(){S.pj=null;if(S.frame){S.frame.remove();S.frame=null}S.ready=false;setPlaying(false);S.last=null;clearTimeout(S.timer);endB.hidden=true;fsB.hidden=true}
function claim(){teardown();show('Loading the lecture…');post('/play/claim',{item:ITEM,tab:TAB}).then(function(r){if(r.status===401){location.href='/sign-in?ended=idle&next='+encodeURIComponent(location.pathname);return null}return r.json()}).then(function(j){if(!j)return;handle(j)}).catch(function(){show('We couldn’t load the lecture. Check your connection.',[{label:'Try again',primary:true,fn:claim}])})}
function handle(j){
 if(j.state==='account'){location.href=j.url;return}
 if(j.state==='busy'){S.block='busy';show('Another lecture'+(j.title?' (“'+j.title+'”)':'')+' is open in another tab or window. Close it or press End Lecture there, then try again. A closed tab is released automatically within 2 minutes.',[{label:'Try again',primary:true,fn:claim}]);return}
 if(j.state==='locked'){S.block='locked';var b=[];if(j.request)b.push({label:j.requested?'Request sent':'Ask for more views',primary:true,fn:function(){if(j.requested)return;post('/play/request',{item:ITEM}).then(function(){j.requested=true;handle(j)})}});show('You have used all '+j.allowed+' views of this lecture'+(j.requested?'. Your request for more views has been sent to USMLE100.':'. You can ask USMLE100 for more views.'),b);return}
 if(j.state==='sharing'){S.block='sharing';show(j.locked?'Your account has been locked because your lectures were played on two devices in different places at the same time. Please contact USMLE100.':'This lecture is already playing on another device in a different place. Your account is for you alone: a warning has been recorded, and a repeat will lock your account.',j.locked?[{label:'OK',primary:true,href:'/account/suspended'}]:[{label:'Try again',primary:true,fn:claim}]);return}
 if(j.state==='redirect'){location.href=j.url;return}
 if(j.state==='profile'){show('Before you watch, please add your phone number, the exam you’re preparing for and your graduation year.',[{label:'Complete my details',primary:true,href:'/account?next='+encodeURIComponent(location.pathname)}]);return}
 if(j.state==='novideo'){show(j.message||'The video for this lecture isn’t available yet.');return}
 if(j.state!=='ok'){show('This lecture isn’t available to you.');return}
 S.sid=j.sid;S.nonce=j.nonce;S.resume=j.pos||0;S.okAt=Date.now();S.ttl=+j.ttl||900;S.linkAt=Date.now();
 wm.innerHTML='';var a=document.createElement('span');a.className='pp-wm-main';a.textContent=j.wm.name+' · ID '+j.wm.id;var b2=document.createElement('span');b2.className='pp-wm-code';b2.textContent='Session '+j.wm.code;wm.appendChild(a);wm.appendChild(b2);moveWm();
 var tt='ID '+j.wm.id+' · '+j.wm.code+'   ';tile.textContent=new Array(61).join(tt);
 if(j.first){show(j.notice,[{label:'Start lecture',primary:true,fn:function(){load(j.src)}}])}else load(j.src)}
function load(src){unblock();S.origin=new URL(src).origin;var f=document.createElement('iframe');f.src=src;f.title=root.dataset.title||'Lecture';f.setAttribute('allow',"autoplay; encrypted-media; picture-in-picture 'none'; fullscreen 'none'; display-capture 'none'");
// Sealed frame: the video player can run, but cannot open windows or tabs, download files, cast, or navigate this page.
f.setAttribute('sandbox','allow-scripts allow-same-origin');f.setAttribute('referrerpolicy','strict-origin');box.appendChild(f);S.frame=f;libAttach(f);endB.hidden=false;var fs=stage.requestFullscreen||stage.webkitRequestFullscreen;fsB.hidden=!fs;schedule(1000)}
addEventListener('message',function(e){if(!S.frame)return;var d=e.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){return}}if(!d||d.context!=='player.js')return;D.msgs++;if(D.origins.indexOf(e.origin)<0&&D.origins.length<4)D.origins.push(e.origin);if(e.source!==S.frame.contentWindow&&e.origin!==S.origin)return;
 if(d.event==='ready'){D.rawReady=true;S.ready=true;['play','pause','timeupdate','ended'].forEach(function(ev,i){cmd('addEventListener',ev,'u'+i)});if(S.resume>5)cmd('setCurrentTime',S.resume);return}
 onEv(d.event,d.value)});
function onEv(ev,v){D.ev[ev]=(D.ev[ev]||0)+1;
 if(ev==='play'){if(S.block||document.visibilityState==='hidden'){cmd('pause');return}
  // Video links are short-lived. After a long pause, get a fresh one (same viewing, same place) instead of reusing an old link.
  if(!S.playing&&S.linkAt&&Date.now()-S.linkAt>(S.ttl-30)*1000){cmd('pause');D.refreshed=(D.refreshed||0)+1;claim();return}if(!S.playing){setPlaying(true);schedule(500)}return}
 if(ev==='pause'||ev==='ended'){if(S.playing){setPlaying(false);schedule(300)}return}
 if(ev==='timeupdate'&&v){var s=+v.seconds,du=+v.duration;if(du>0)S.dur=du;
  // Time moving forward in small steps means the video is playing, even if the play message was missed.
  if(!S.playing&&!S.block&&S.last!=null&&s>S.last&&s-S.last<=3&&document.visibilityState!=='hidden'){setPlaying(true);schedule(500)}
  if(S.playing&&S.last!=null&&s>S.last&&s-S.last<=3)add(S.last,s);S.last=s;S.pos=s}}
addEventListener('u100-pj',function(){if(S.frame&&!S.pj)libAttach(S.frame)});
function libAttach(f){if(!window.playerjs||!playerjs.Player)return;D.lib=true;try{var pj=new playerjs.Player(f);S.pj=pj;pj.on('ready',function(){if(S.pj!==pj)return;D.libReady=true;
  ['play','pause','ended'].forEach(function(ev){pj.on(ev,function(){if(S.pj===pj)onEv(ev)})});
  pj.on('timeupdate',function(v){if(S.pj===pj)onEv('timeupdate',v)});
  if(S.resume>5&&!D.rawReady)try{pj.setCurrentTime(S.resume)}catch(x){}})}catch(x){}}
function add(a,b){var r=S.ranges[S.ranges.length-1];if(r&&Math.abs(r[1]-a)<0.01)r[1]=b;else S.ranges.push([a,b])}
function schedule(ms){clearTimeout(S.timer);S.timer=setTimeout(beat,ms)}
var inflight=false;
function beat(){if(!S.sid||!S.frame){return}if(inflight){schedule(2000);return}inflight=true;var sent=S.ranges.slice();var n=sent.length;
 post('/play/beat',{sid:S.sid,tab:TAB,nonce:S.nonce,playing:S.playing,pos:S.pos,dur:S.dur,add:sent,diag:D}).then(function(r){if(r.status===401){location.href='/sign-in?ended=idle&next='+encodeURIComponent(location.pathname);return null}if(!r.ok&&r.status!==403&&r.status!==503)throw 0;return r.json()}).then(function(j){inflight=false;if(!j)return;S.ranges.splice(0,n);S.okAt=Date.now();
  if(j.state==='ok'){if(S.block==='offline'){unblock()}schedule(S.playing?10000:30000);return}
  if(j.state==='account'){location.href=j.url;return}
  if(j.state==='tab'){teardown();block('tab','This lecture was opened in another tab or window, so it stopped here.',[{label:'Watch here instead',primary:true,fn:claim}]);return}
  if(j.state==='done'){var why=j.reason==='expired'?'This viewing’s 24 hours have ended.':'You’ve watched this lecture through, so this viewing is complete.';teardown();S.sid=null;if(j.viewsLeft===0){block('done',why+' You’ve now used all the views of this lecture.',[{label:'Ask for more views',primary:true,fn:claim}])}else{block('done',why+' Starting again uses another view'+(j.viewsLeft>0?' ('+j.viewsLeft+' left)':'')+', and the lecture resumes where you stopped.',[{label:'Start another viewing',primary:true,fn:claim}])}return}
  teardown();block('gone','This lecture is no longer available to you.')}).catch(function(){inflight=false;
  if(Date.now()-S.okAt>30000&&S.block!=='offline'){block('offline','Connection lost. The lecture is paused until we can confirm your progress again.')}schedule(5000)})}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){S.wasPlaying=S.playing;cmd('pause');schedule(200)}else{if(S.wasPlaying&&!S.block)cmd('play');S.wasPlaying=false}});
var spots=[['6%','auto','auto','4%'],['6%','4%','auto','auto'],['auto','auto','18%','4%'],['auto','4%','18%','auto'],['42%','auto','auto','3%'],['42%','3%','auto','auto']],cur=-1;
function moveWm(){var i;do{i=Math.floor(Math.random()*spots.length)}while(i===cur&&spots.length>1);cur=i;var p=spots[i];wm.style.top=p[0];wm.style.right=p[1];wm.style.bottom=p[2];wm.style.left=p[3]}
setInterval(moveWm,10000);
setInterval(function(){if(!S.frame)return;var cs=getComputedStyle(wm);var ts=getComputedStyle(tile);if(!wm.isConnected||wm.parentNode!==stage||cs.display==='none'||cs.visibility==='hidden'||+cs.opacity<0.2||!wm.textContent||!tile.isConnected||tile.parentNode!==stage||ts.display==='none'||ts.visibility==='hidden'||+ts.opacity<0.05||!tile.textContent){teardown();block('wm','The lecture stopped because its watermark was changed. Reload the page to continue.')}},3000);
endB.onclick=function(){cmd('pause');var t=TAB;teardown();post('/play/release',{tab:t});S.block='ended';show('Lecture ended. Your viewing stays open until its 24 hours end, so you can come back without using another view.',[{label:'Resume',primary:true,fn:claim}])};
fsB.onclick=function(){if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}else{(stage.requestFullscreen||stage.webkitRequestFullscreen).call(stage)}};
addEventListener('pagehide',function(){if(S.frame&&navigator.sendBeacon)navigator.sendBeacon('/play/release',new Blob([JSON.stringify({tab:TAB})],{type:'application/json'}))});
addEventListener('pageshow',function(e){if(e.persisted)claim()});
claim();
})();`;
