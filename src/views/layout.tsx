import { CONTACT } from '../lib/contact';
import type { Child } from 'hono/jsx';
import type { Shell, User } from '../lib/types';
import { isAdmin, isOwner, isStaff } from '../lib/types';
import { Icon, type IconName } from './icons';

/** The official USMLE100 "U" mark (traced from the owner's logo): split U with the gold dot. */
export const LogoMark = (p: { size?: number; light?: boolean }) => {
  const h = p.size ?? 32;
  return <img class="logo-u" src={p.light ? '/brand/mark-light.svg' : '/brand/mark.svg'} width={Math.round((h * 198) / 243)} height={h} alt="" />;
};

/** The official "USMLE100" wordmark ("100" in the brand gold), traced from the owner's logo. */
export const LogoWord = (p: { height?: number; light?: boolean }) => {
  const h = p.height ?? 20;
  return <img class="logo-word" src={p.light ? '/brand/wordmark-light.svg' : '/brand/wordmark.svg'} width={Math.round((h * 905) / 135)} height={h} alt="USMLE100" />;
};

export const LogoTagline = (p: { height?: number; light?: boolean }) => {
  const h = p.height ?? 14;
  return <img class="logo-tag" src={p.light ? '/brand/tagline-light.svg' : '/brand/tagline.svg'} width={Math.round((h * 690) / 52)} height={h} alt="Get In. Get Out. Get Licensed." />;
};

/** The full lockup from the owner's logo: mark | wordmark with the tagline underneath. */
const Wordmark = () => (
  <a href="/" class="logo logo-lockup" aria-label="USMLE100 home">
    <LogoMark />
    <span class="logo-rule" aria-hidden="true" />
    <span class="logo-stack">
      <LogoWord />
      <LogoTagline height={10} />
    </span>
  </a>
);

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'U';

const SHARE_TEXT = 'Live classes every weekday taught by physicians, one-on-one tutoring and a structured 100-day program.';

function Doc(props: { title: string; fullTitle?: string; children: Child; bodyClass?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#ffffff" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{props.fullTitle ?? `${props.title} · USMLE100`}</title>
        {/* Share preview (owner, 5 Nov 2026): the card WhatsApp, Facebook and others show when usmle100.com is posted. */}
        <meta name="description" content={SHARE_TEXT} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="USMLE100" />
        <meta property="og:title" content={props.fullTitle ?? `USMLE100 · ${props.title}`} />
        <meta property="og:description" content={SHARE_TEXT} />
        <meta property="og:image" content="https://usmle100.com/share.jpg" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="USMLE100: Medical board prep, taught live by physicians" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@500;600;700;800&family=Red+Hat+Text:wght@400;500;600;700&display=swap" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body class={props.bodyClass}>{props.children}</body>
    </html>
  );
}

/** Social and contact links (owner, 5 Nov 2026). Outside links open in a new tab. */
const ext = { target: '_blank', rel: 'noopener noreferrer' };
const IC = {
  fb: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M13.3 19v-6h2l.3-2.4h-2.3V9.1c0-.7.2-1.2 1.2-1.2h1.2V5.8c-.2 0-1-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.8h-2V13h2v6z" fill="#fff"/></svg>,
  ig: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor"/><circle cx="12" cy="12" r="4.4" fill="none" stroke="#fff" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.3" fill="#fff"/></svg>,
  wa: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.6A10.3 10.3 0 0 0 3.2 17.3L1.8 22.4l5.3-1.4A10.3 10.3 0 1 0 12 1.6z" fill="currentColor"/><path d="M8.6 6.9c.2 0 .5 0 .7.5l1 2.3c.1.2.1.4 0 .6l-.5.7c-.1.2-.2.3 0 .6.5.9 1.2 1.7 2 2.3.6.4 1.1.7 1.4.8.2.1.4.1.5-.1l.8-.9c.2-.2.4-.2.6-.1l2.2 1c.3.2.4.3.4.5 0 .5-.1 1.2-.7 1.7-.6.5-1.6.9-2.6.6-2.3-.6-4.4-2.2-5.8-4.2-.7-1-1.2-2.1-1.2-3.2 0-1 .5-1.8 1-2.2.3-.3.5-.3.7-.3z" fill="#fff"/></svg>,
  mail: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>,
  text: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 19 17.5H10l-4.5 3.5v-3.5H5A2.5 2.5 0 0 1 2.5 15V7A2.5 2.5 0 0 1 5 4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>,
  cal: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>,
};
/** Footer contact block: social links, then one line each for email, text, WhatsApp and tutoring. */
export const ContactRow = () => (
  <div class="contact">
    <p class="reply-time">We usually reply within 24 hours.</p>
    <nav class="social" aria-label="USMLE100 on social media">
      <a href={CONTACT.facebook} {...ext}>{IC.fb}<span>Facebook</span></a>
      <a href={CONTACT.whatsappGroup} {...ext}>{IC.wa}<span>WhatsApp group</span></a>
      <a href={CONTACT.instagram} {...ext}>{IC.ig}<span>Instagram</span></a>
    </nav>
    <ul class="reach" aria-label="Contact USMLE100">
      <li><a href={`mailto:${CONTACT.email}`}>{IC.mail}<span><small>Email</small>{CONTACT.email}</span></a></li>
      <li><a href={CONTACT.phoneSms}>{IC.text}<span><small>Text</small>{CONTACT.phoneDisplay}</span></a></li>
      <li><a href={CONTACT.phoneWhatsApp} {...ext}>{IC.wa}<span><small>WhatsApp</small>{CONTACT.phoneDisplay}</span></a></li>
      <li><a href={CONTACT.tutoring} {...ext}>{IC.cal}<span><small>Tutoring</small>Book a tutoring session</span></a></li>
    </ul>
  </div>
);

export function PublicLayout(props: { title: string; fullTitle?: string; user: User | null; children: Child; bare?: boolean; plain?: boolean; legal?: { terms: boolean; privacy: boolean; refunds?: boolean }; portalLink?: { href: string; label: string } }) {
  return (
    <Doc title={props.title} fullTitle={props.fullTitle} bodyClass="pub">
      {!props.plain && (
      <header class="pub-top">
        <div class="wrap">
          <Wordmark />
          <nav aria-label="Main" class="pub-nav">
            <a class="lnk hide-sm" href="/programs">Programs</a>
            <a class="lnk hide-sm" href="/webinars">Webinars</a>
            {props.user ? (
              <a class="btn btn-primary" href={props.portalLink?.href ?? '/dashboard'}>
                {props.portalLink?.label ?? 'Open portal'}
              </a>
            ) : (
              <>
                <a class="lnk hide-sm" href="/sign-in">Sign in</a>
                <a class="btn btn-primary hide-sm" href="/sign-up">
                  Create account
                </a>
              </>
            )}
            {/* Phones: the other links live in a menu, as in the V12 design. */}
            <details class="pub-menu">
              <summary aria-label="Menu"><Icon name="menu" /></summary>
              <div class="pub-menu-list">
                <a href="/programs">Programs</a>
                <a href="/webinars">Webinars</a>
                {props.user ? <a href="/free-lectures">Free lectures</a> : <a href="/sign-in">Sign in</a>}
                {props.user ? <a href="/account">My account</a> : <a href="/sign-up">Create account</a>}
              </div>
            </details>
          </nav>
        </div>
      </header>
      )}
      {props.children}
      {!props.bare && !props.plain && (
        <footer class="footer">
          <a href="/" class="logo" aria-label="USMLE100 home" style="justify-content:center;margin-bottom:14px"><LogoMark /><LogoWord /></a>
          <nav aria-label="Footer">
            <a href="/programs">Programs</a>
            <a href="/sign-in">Sign in</a>
            <a href="/sign-up">Create account</a>
            {props.legal?.terms && <a href="/terms">Terms</a>}
            {props.legal?.privacy && <a href="/privacy">Privacy</a>}
          </nav>
          <ContactRow />
          <p class="copy">
            © {new Date().getUTCFullYear()} USMLE100 LLC. All rights reserved.
            {props.legal?.refunds && <> · <a class="fine" href="/refunds">Refund policy</a></>}
          </p>
          <p class="tm">USMLE® is a registered trademark of FSMB and NBME, and COMLEX-USA® of NBOME. USMLE100 is not affiliated with or endorsed by them or by ECFMG.</p>
        </footer>
      )}
    </Doc>
  );
}

type NavItem = { key: string; label: string; href: string; icon: IconName };

const groups = (staff: boolean, admin: boolean, owner = false): { label: string; items: NavItem[] }[] => [
  { label: '', items: [{ key: 'home', label: 'Home', href: '/dashboard', icon: 'home' }] },
  {
    label: 'Help',
    items: [
      { key: 'ask', label: 'Ask the Room', href: '/ask', icon: 'forum' },
      { key: 'book', label: '1-on-1 Tutoring', href: '/book', icon: 'event' },
      { key: 'programs', label: 'Explore Programs', href: '/programs', icon: 'premium' },
      { key: 'plans', label: 'Plans', href: '/plans', icon: 'description' },
      { key: 'map', label: 'Portal Map', href: '/map', icon: 'apps' },
    ],
  },
  {
    label: 'Study',
    items: [
      { key: 'lectures', label: 'My Courses', href: '/lectures', icon: 'play_circle' },
      { key: 'free-lectures', label: 'Free Lectures', href: '/free-lectures', icon: 'live' },
      { key: 'webinars', label: 'Live webinars', href: '/webinars', icon: 'videocam' },
      { key: 'topics', label: 'Topics', href: '/topics', icon: 'menu_book' },
      { key: 'book-library', label: 'USMLE100 Book', href: '/course-book', icon: 'book' },
      { key: 'warmup', label: 'Daily Warmup', href: '/warmup', icon: 'bolt' },
      { key: 'qbank', label: 'Question Bank', href: '/qbank', icon: 'quiz' },
      { key: 'create', label: 'Create a Test', href: '/create-test', icon: 'filter' },
      { key: 'cards', label: 'Flash Cards', href: '/cards', icon: 'cards' },
      { key: 'review', label: 'Review', href: '/review', icon: 'psychology' },
      { key: 'evening', label: 'Evening Questions', href: '/evening', icon: 'videocam' },
    ],
  },
  {
    label: 'Progress',
    items: [
      { key: 'performance', label: 'Performance', href: '/performance', icon: 'monitoring' },
      { key: 'rewards', label: 'Rewards', href: '/rewards', icon: 'trophy' },
      { key: 'notes', label: 'My Notes', href: '/notes', icon: 'edit_note' },
      { key: 'exam', label: 'Exam Window', href: '/exam-window', icon: 'calendar' },
    ],
  },
  ...(staff
    ? [
        {
          label: 'Admin',
          items: [
            { key: 'admin-lectures', label: 'Lectures admin', href: '/admin/lectures', icon: 'school' as IconName },
            { key: 'admin-sections', label: 'Topics & sections', href: '/admin/sections', icon: 'menu_book' as IconName },
            { key: 'admin-cards', label: 'Flash cards admin', href: '/admin/cards', icon: 'cards' as IconName },
            { key: 'admin-evening', label: 'Evening Questions admin', href: '/admin/evening', icon: 'videocam' as IconName },
            { key: 'admin-questions', label: 'Questions admin', href: '/admin/questions', icon: 'quiz' as IconName },
            ...(admin
              ? [
                  { key: 'admin-book', label: 'Course Book admin', href: '/admin/book', icon: 'book' as IconName },
                  { key: 'admin-tutoring', label: 'Tutoring sessions', href: '/admin/tutoring', icon: 'event' as IconName },
                  { key: 'admin-home', label: 'Home page content', href: '/admin/home-content', icon: 'home' as IconName },
                  { key: 'admin-students', label: 'Students', href: '/admin/students', icon: 'person' as IconName },
                  { key: 'admin-payments', label: 'Payments check', href: '/admin/payments', icon: 'check_circle' as IconName },
                  { key: 'admin-settings', label: 'Site settings', href: '/admin/settings', icon: 'info' as IconName },
                  { key: 'admin-team', label: 'Team', href: '/admin/team', icon: 'groups' as IconName },
                  { key: 'admin-requests', label: 'Requests & alerts', href: '/admin/requests', icon: 'flag' as IconName },
                  { key: 'admin-security', label: 'Security', href: '/admin/security', icon: 'shield' as IconName },
                  { key: 'admin-views', label: 'Lecture views', href: '/admin/views', icon: 'play_circle' as IconName },
                  { key: 'admin-free', label: 'Free lectures', href: '/admin/free-lectures', icon: 'live' as IconName },
                  { key: 'admin-cases', label: 'Appeals and disputes', href: '/admin/cases', icon: 'flag' as IconName },
                  { key: 'admin-webinars', label: 'Webinars', href: '/admin/webinars', icon: 'videocam' as IconName },
                  { key: 'admin-agreement', label: 'Student agreement', href: '/admin/agreement', icon: 'description' as IconName },
                  ...(owner ? [{ key: 'admin-launch', label: 'Launch check', href: '/admin/launch-check', icon: 'check_circle' as IconName }] : []),
                ]
              : []),
          ],
        },
      ]
    : []),
];

const BOTTOM: NavItem[] = [
  { key: 'home', label: 'Home', href: '/dashboard', icon: 'home' },
  { key: 'lectures', label: 'Lectures', href: '/lectures', icon: 'play_circle' },
  { key: 'book-library', label: 'Book', href: '/course-book', icon: 'menu_book' },
  { key: 'qbank', label: 'Qbank', href: '/qbank', icon: 'quiz' },
  { key: 'ask', label: 'Ask', href: '/ask', icon: 'forum' },
];
/** Pages that light up a bottom-nav tab other than their own key. */
const BOTTOM_ALIAS: Record<string, string> = { create: 'qbank', test: 'qbank', results: 'qbank', warmup: 'qbank', topics: 'lectures', book: 'book-tutoring' };

/** Inactivity (30 min, warning at 25) and 24-hour sign-in limit (warning 5 min before), R088–R091. */
const SESSION_JS = "(function(){\nvar WARN_IDLE=25*60e3,IDLE=30*60e3,WARN_ABS=5*60e3,last=Date.now(),lastPing=Date.now(),absEnd=0,mode='',m=document.getElementById('sess-modal'),msg=document.getElementById('sess-msg'),btn=document.getElementById('sess-stay');\nif(!m)return;\nfunction out(why){fetch('/session/end',{method:'POST',credentials:'same-origin'}).finally(function(){location.href='/sign-in?ended='+why+'&next='+encodeURIComponent(location.pathname)})}\nfunction show(k,t){mode=k;msg.textContent=t;btn.textContent=k==='idle'?'Stay logged in':'OK';m.hidden=false;btn.focus()}\nfunction ping(){lastPing=Date.now();fetch('/session/ping',{method:'POST',credentials:'same-origin'}).then(function(r){if(r.status===401)out('idle');return r.json()}).then(function(j){if(j&&j.absoluteLeft!=null)absEnd=Date.now()+j.absoluteLeft*1e3}).catch(function(){})}\nfunction act(){if(mode==='idle')return;last=Date.now();if(Date.now()-lastPing>60e3)ping()}\n['click','keydown','scroll','touchstart','pointermove'].forEach(function(e){addEventListener(e,act,{passive:true})});\nbtn.addEventListener('click',function(){var k=mode;m.hidden=true;mode=k==='abs'?'abs-seen':'';if(k==='idle'){last=Date.now();ping()}});\nfetch('/session/status',{credentials:'same-origin'}).then(function(r){if(r.status===401){out('idle');return null}return r.json()}).then(function(j){if(j)absEnd=Date.now()+j.absoluteLeft*1e3}).catch(function(){});\nfunction mmss(ms){var s=Math.max(0,Math.ceil(ms/1e3));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}\nsetInterval(function(){var now=Date.now();\n if(document.visibilityState==='visible'&&document.querySelector('iframe[data-lecture],.pp-live'))act();\n if(absEnd&&now>=absEnd)return out('expired');\n if(now-last>=IDLE)return out('idle');\n if(now-last>=WARN_IDLE){if(mode!=='idle')show('idle','');msg.textContent='You have been inactive. For your security you will be signed out in '+mmss(IDLE-(now-last))+'.';return}\n if(absEnd&&absEnd-now<=WARN_ABS&&mode===''){show('abs','For your security, sign-ins last at most 24 hours. You will be signed out in '+mmss(absEnd-now)+'. Please save your work.')}\n},1000);\ndocument.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')fetch('/session/status',{credentials:'same-origin'}).then(function(r){if(r.status===401)out('idle')}).catch(function(){})});\n})();";

export function PortalLayout(props: { title: string; active: string; user: User; shell?: Shell; children: Child; wide?: boolean; focus?: boolean }) {
  // Onboarding steps are shown on their own, centred, without the portal chrome (as in the V12 design).
  if (props.focus) {
    return (
      <Doc title={props.title}>
        <main class="focus-main">
          <div class="focus-inner">{props.children}</div>
        </main>
      </Doc>
    );
  }
  const s = props.shell;
  const pct = s && s.lecturesTotal ? Math.min(100, Math.round((s.lecturesDone / s.lecturesTotal) * 100)) : 0;
  const bottomActive = BOTTOM_ALIAS[props.active] ?? props.active;
  return (
    <Doc title={props.title}>
      <div class="app">
        <input type="checkbox" id="drawer" class="drawer-toggle" aria-label="Open menu" />
        <label for="drawer" class="drawer-scrim" aria-hidden="true"></label>
        <nav class="drawer" aria-label="Portal">
          <div class="drawer-head">
            <span class="avatar avatar-dark">{initials(props.user.name)}</span>
            <div class="who">
              <strong>{props.user.name}</strong>
              <span>{props.user.email}</span>
            </div>
            <label for="drawer" class="drawer-close" aria-label="Close menu">
              <Icon name="close" size={28} />
            </label>
          </div>
          <div class="drawer-body">
            {s && s.enrolled === false && !isStaff(props.user) && (
              <a href="/enroll" class="progress-card progress-card-locked">
                <span class="num">No active program</span>
                <span class="hint">Choose a program to unlock lectures and practice</span>
              </a>
            )}
            {s && s.enrolled !== false && s.lecturesTotal > 0 && !isStaff(props.user) && (
              <div class="progress-card">
                <span class="num">
                  <b>{s.lecturesDone}</b> of {s.lecturesTotal} lectures
                </span>
                <div class="bar">
                  <i style={`width:${pct}%`}></i>
                </div>
                <span class="hint">{s.lecturesDone ? `${pct}% of the course watched` : 'Finish one lecture to start'}</span>
              </div>
            )}
            {groups(isStaff(props.user), isAdmin(props.user), isOwner(props.user)).map((g) => (
              <>
                {g.label && <div class="nav-label">{g.label}</div>}
                {g.items.map((i) => (
                  <a href={i.href} class={'nav-item' + (i.key === props.active ? ' active' : '')} aria-current={i.key === props.active ? 'page' : undefined}>
                    <Icon name={i.icon} />
                    {i.label}
                    <Icon name="chevron_right" class="chev" />
                  </a>
                ))}
              </>
            ))}
            <div class="nav-label"></div>
            <a href="/account" class={'nav-item' + (props.active === 'account' ? ' active' : '')}>
              <Icon name="person" />
              My account
              <Icon name="chevron_right" class="chev" />
            </a>
            <form method="post" action="/sign-out">
              <button type="submit" class="nav-item" style="width:100%;border:0;background:none;cursor:pointer">
                <Icon name="logout" />
                Exit
                <Icon name="chevron_right" class="chev" />
              </button>
            </form>
            {s?.contact && (
              <a class="nav-item" href={`mailto:${s.contact}`}>
                <Icon name="mail" />
                Contact
                <Icon name="chevron_right" class="chev" />
              </a>
            )}
            <div class="drawer-foot">© {new Date().getUTCFullYear()} USMLE100{s?.terms && <> · <a href="/terms">Terms</a></>}{s?.privacy && <> · <a href="/privacy">Privacy</a></>}{s?.refunds && <> · <a href="/refunds">Refunds</a></>}</div>
          </div>
        </nav>

        <header class="topbar-app">
          <label for="drawer" class="tb-btn tb-menu" aria-label="Menu">
            <Icon name="menu" />
          </label>
          <a href="/dashboard" class="tb-btn tb-btn-plain" aria-label="USMLE100 home">
            <LogoMark />
          </a>
          <a href="/search" class="tb-btn" aria-label="Search">
            <Icon name="search" size={24} />
          </a>
          <span class="tb-spacer"></span>
          <a href="/warmup" class="tb-btn tb-green" aria-label="Daily Warmup: 10 questions" title="Daily Warmup">
            <Icon name="bolt" size={22} />
          </a>
          {s && (
            <a href="/dashboard#streak" class={'tb-streak' + (s.streak ? ' on' : '')} aria-label={`Study streak: ${s.streak} day${s.streak === 1 ? '' : 's'}`}>
              <Icon name="fire" size={20} />
              {s.streak}
            </a>
          )}
          <label for="drawer" class="avatar" aria-label="Account menu">
            {initials(props.user.name)}
          </label>
          {s?.contact && (
            <a href={`mailto:${s.contact}`} class="tb-btn tb-btn-plain" aria-label="Help">
              <Icon name="help" size={28} />
            </a>
          )}
        </header>

        <div class="app-main-wrap">
          <main class={'app-main' + (props.wide ? ' wide' : '')}>{props.children}</main>
        </div>

        <div id="sess-modal" class="sess-modal" role="alertdialog" aria-modal="true" aria-labelledby="sess-title" aria-describedby="sess-msg" hidden>
          <div class="sess-box">
            <h2 id="sess-title">Are you still there?</h2>
            <p id="sess-msg"></p>
            <button type="button" id="sess-stay" class="btn btn-primary btn-block">Stay logged in</button>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: SESSION_JS }} />

        <nav class="bottom-nav" aria-label="Quick navigation">
          {BOTTOM.map((i) => (
            <a href={i.href} class={i.key === bottomActive ? 'active' : ''} aria-current={i.key === bottomActive ? 'page' : undefined}>
              <Icon name={i.icon} size={24} />
              {i.label}
            </a>
          ))}
        </nav>
      </div>
    </Doc>
  );
}

export const Eyebrow = (p: { children: Child }) => <div class="eyebrow">{p.children}</div>;

export const PageHead = (p: { eyebrow?: string; title: Child; sub?: Child }) => (
  <div class="page-head">
    {p.eyebrow && <div class="eyebrow">{p.eyebrow}</div>}
    <h1>{p.title}</h1>
    {p.sub && <p>{p.sub}</p>}
  </div>
);

export const Flash = (p: { kind?: 'error' | 'ok'; children: Child }) => (
  <p class={'flash ' + (p.kind === 'error' ? 'flash-error' : 'flash-ok')} role={p.kind === 'error' ? 'alert' : 'status'}>
    {p.children}
  </p>
);
