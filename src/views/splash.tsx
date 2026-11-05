/**
 * The original Build v4 USMLE100 loading screen (owner, 5 Nov 2026): dark emerald background, cream "USMLE" with gold
 * "100", a thin animated gold line. Reused from Build v4's own markup and styles, condensed so it never delays anyone:
 * it shows only on the first dashboard load after signing in, stays no longer than that load plus the short logo
 * entrance (about 1.4 s), can be skipped with a tap, and always removes itself, even if a script fails.
 * Purely visual: sign-in itself is untouched (the sign-in page only leaves a one-time note in this browser tab).
 */
const CSS = `
#u100-splash{position:fixed;inset:0;z-index:99999;overflow:hidden;display:grid;place-items:center;background:#112111;
  transition:opacity .6s cubic-bezier(.16,1,.3,1),filter .6s cubic-bezier(.16,1,.3,1);
  animation:u1Gone .5s 6s forwards}
#u100-splash[hidden]{display:none}
#u100-splash.u1-out{opacity:0;filter:blur(8px);pointer-events:none}
#u100-splash .u1-bg{position:absolute;inset:0;opacity:0;animation:u1Bg 1s .05s cubic-bezier(.16,1,.3,1) forwards;
  background-image:radial-gradient(60% 90% at 85% 0%,rgba(233,206,114,.3),transparent 62%),linear-gradient(140deg,#0b2217,#1b6549,#2e936f)}
#u100-splash .u1-orb{position:absolute;border-radius:50%;filter:blur(70px);opacity:0}
#u100-splash .u1-o1{width:520px;height:520px;top:-180px;left:-140px;background:#2E936F;animation:u1Orb 1.4s .2s ease-out forwards}
#u100-splash .u1-o2{width:420px;height:420px;bottom:-170px;right:-110px;background:#C6A673;animation:u1Orb 1.4s .35s ease-out forwards}
#u100-splash .u1-vig{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 22rem rgba(0,0,0,.66)}
#u100-splash .u1-inner{position:relative;text-align:center;padding:0 22px;animation:u1Push 1.6s cubic-bezier(.22,1,.26,1) both}
#u100-splash .u1-word{display:flex;align-items:baseline;justify-content:center;gap:1px;font:800 clamp(40px,8.5vw,82px)/1.1 var(--display);letter-spacing:-.05em;color:#FAF9F7}
#u100-splash .u1-word span{display:inline-block;opacity:0;transform:translateY(16px);animation:u1Up .7s cubic-bezier(.16,1,.3,1) forwards}
#u100-splash .u1-word .u1-h{color:#E0C79B}
#u100-splash .u1-line{height:3px;width:0;margin:20px auto 0;border-radius:3px;
  background:linear-gradient(90deg,transparent,#2E936F 18%,#C6A673 82%,transparent);animation:u1Line .9s .5s cubic-bezier(.16,1,.3,1) forwards}
#u100-splash .u1-tag{margin-top:18px;font:500 12.5px var(--text);letter-spacing:.3em;text-transform:uppercase;color:rgba(246,242,234,0);
  animation:u1Tag .8s .7s cubic-bezier(.16,1,.3,1) forwards}
#u100-splash button{position:absolute;right:20px;bottom:20px;z-index:2;border:0;cursor:pointer;background:rgba(255,255,255,.1);
  color:rgba(246,242,234,.85);font:500 12.5px var(--text);padding:9px 18px;border-radius:50px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
@keyframes u1Bg{to{opacity:1}}
@keyframes u1Orb{to{opacity:.55}}
@keyframes u1Push{from{transform:scale(1.08)}to{transform:scale(1)}}
@keyframes u1Up{to{opacity:1;transform:none}}
@keyframes u1Line{to{width:min(340px,62vw)}}
@keyframes u1Tag{to{color:rgba(246,242,234,.66);letter-spacing:.22em}}
@keyframes u1Gone{to{opacity:0;visibility:hidden;pointer-events:none}}
@media (prefers-reduced-motion:reduce){
  #u100-splash,#u100-splash *{animation:none!important;transition:none!important}
  #u100-splash .u1-bg,#u100-splash .u1-orb,#u100-splash .u1-word span{opacity:1;transform:none}
  #u100-splash .u1-orb{opacity:.55}
  #u100-splash .u1-line{width:min(340px,62vw)}
  #u100-splash .u1-tag{color:rgba(246,242,234,.66);letter-spacing:.22em}
}`;

const JS = `(function(){var el=document.getElementById('u100-splash');if(!el)return;var on=false;
try{on=sessionStorage.getItem('u100-splash')==='1';sessionStorage.removeItem('u100-splash')}catch(e){}
if(!on){el.remove();return}
el.hidden=false;var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var start=Date.now(),done=false,MIN=reduce?0:1400;
function hide(){if(done)return;done=true;el.classList.add('u1-out');setTimeout(function(){el.remove()},650)}
el.querySelector('button').addEventListener('click',hide);el.addEventListener('click',hide);
function loaded(){setTimeout(hide,Math.max(0,MIN-(Date.now()-start)))}
if(document.readyState==='complete')loaded();else window.addEventListener('load',loaded);
setTimeout(hide,4500)})();`;

/** On the dashboard: shown only when the sign-in page has just sent this browser tab here. */
export const Splash = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
    <div id="u100-splash" hidden aria-hidden="true">
      <span class="u1-bg"></span>
      <span class="u1-orb u1-o1"></span>
      <span class="u1-orb u1-o2"></span>
      <span class="u1-vig"></span>
      <div class="u1-inner">
        <div class="u1-word">
          {['U', 'S', 'M', 'L', 'E'].map((ch, i) => <span style={`animation-delay:${(i * 0.05).toFixed(2)}s`}>{ch}</span>)}
          {['1', '0', '0'].map((ch, i) => <span class="u1-h" style={`animation-delay:${(0.3 + i * 0.06).toFixed(2)}s`}>{ch}</span>)}
        </div>
        <div class="u1-line"></div>
        <div class="u1-tag">Exam Preparation</div>
      </div>
      <button type="button">Skip</button>
    </div>
    <script dangerouslySetInnerHTML={{ __html: JS }} />
  </>
);

/** On the sign-in page: leave a one-time note in this tab when the student signs in (password or passkey). */
export const SPLASH_FLAG_JS = `(function(){function mark(){try{sessionStorage.setItem('u100-splash','1')}catch(e){}}
var f=document.querySelector('main.auth-form form');if(f)f.addEventListener('submit',mark);
var p=document.getElementById('pk-signin');if(p)p.addEventListener('click',mark)})();`;
