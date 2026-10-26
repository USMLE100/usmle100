import type { Child } from 'hono/jsx';
import type { Shell, User } from '../lib/types';
import { isAdmin, isStaff } from '../lib/types';
import { Icon, type IconName } from './icons';

/** The USMLE100 "U" mark: a heavy U with an emerald dot (no white line through it). */
export const LogoMark = (p: { size?: number; light?: boolean }) => (
  <svg class="logo-u" width={(p.size ?? 32) * 0.8125} height={p.size ?? 32} viewBox="0 0 26 32" aria-hidden="true">
    <path d="M4 1.5v15.5a9 9 0 0 0 18 0V1.5" fill="none" stroke={p.light ? '#ffffff' : '#232220'} stroke-width="6" />
    <circle cx="13" cy="19.5" r="3.6" fill={p.light ? '#9fd8bf' : '#2e936f'} />
  </svg>
);

const Wordmark = () => (
  <a href="/" class="logo" aria-label="USMLE100 home">
    <LogoMark />
    <span class="logo-word">
      USMLE<span>100</span>
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

function Doc(props: { title: string; children: Child; bodyClass?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#ffffff" />
        <title>{props.title} · USMLE100</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@500;600;700;800&family=Red+Hat+Text:wght@400;500;600;700&display=swap" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body class={props.bodyClass}>{props.children}</body>
    </html>
  );
}

export function PublicLayout(props: { title: string; user: User | null; children: Child; bare?: boolean; plain?: boolean }) {
  return (
    <Doc title={props.title}>
      {!props.plain && (
      <header class="pub-top">
        <div class="wrap">
          <Wordmark />
          <nav aria-label="Main" class="pub-nav">
            <a class="lnk hide-sm" href="/programs">Programs</a>
            {props.user ? (
              <a class="btn btn-primary" href="/dashboard">
                Open portal
              </a>
            ) : (
              <>
                <a class="lnk" href="/sign-in">Sign in</a>
                <a class="btn btn-primary" href="/sign-up">
                  Create account
                </a>
              </>
            )}
          </nav>
        </div>
      </header>
      )}
      {props.children}
      {!props.bare && !props.plain && (
        <footer class="footer">
          <a href="/" class="logo" aria-label="USMLE100 home" style="justify-content:center;margin-bottom:14px"><LogoMark /><span class="logo-word">USMLE<span>100</span></span></a>
          <nav aria-label="Footer">
            <a href="/programs">Programs</a>
            <a href="/sign-in">Sign in</a>
            <a href="/sign-up">Create account</a>
          </nav>
          © {new Date().getUTCFullYear()} USMLE100 · Not affiliated with NBME, FSMB or ECFMG.
        </footer>
      )}
    </Doc>
  );
}

type NavItem = { key: string; label: string; href: string; icon: IconName };

const groups = (staff: boolean, admin: boolean): { label: string; items: NavItem[] }[] => [
  { label: '', items: [{ key: 'home', label: 'Home', href: '/dashboard', icon: 'home' }] },
  {
    label: 'Help',
    items: [
      { key: 'book', label: '1-on-1 Tutoring', href: '/book', icon: 'event' },
      { key: 'programs', label: 'Programs', href: '/programs', icon: 'premium' },
    ],
  },
  {
    label: 'Study',
    items: [
      { key: 'lectures', label: 'Lectures', href: '/lectures', icon: 'play_circle' },
      { key: 'evening', label: 'Evening Questions', href: '/evening', icon: 'videocam' },
      { key: 'qbank', label: 'Question Bank', href: '/qbank', icon: 'quiz' },
      { key: 'create', label: 'Create a Test', href: '/create-test', icon: 'filter' },
      { key: 'review', label: 'Review', href: '/review', icon: 'replay' },
    ],
  },
  {
    label: 'Progress',
    items: [
      { key: 'performance', label: 'Performance', href: '/performance', icon: 'monitoring' },
      { key: 'exam', label: 'Exam Window', href: '/exam-window', icon: 'calendar' },
    ],
  },
  ...(staff
    ? [
        {
          label: 'Admin',
          items: [
            { key: 'admin-lectures', label: 'Lectures admin', href: '/admin/lectures', icon: 'school' as IconName },
            { key: 'admin-evening', label: 'Evening Questions admin', href: '/admin/evening', icon: 'videocam' as IconName },
            { key: 'admin-questions', label: 'Questions admin', href: '/admin/questions', icon: 'quiz' as IconName },
            ...(admin
              ? [
                  { key: 'admin-students', label: 'Students', href: '/admin/students', icon: 'person' as IconName },
                  { key: 'admin-settings', label: 'Site settings', href: '/admin/settings', icon: 'info' as IconName },
                  { key: 'admin-team', label: 'Team', href: '/admin/team', icon: 'groups' as IconName },
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
  { key: 'qbank', label: 'Qbank', href: '/qbank', icon: 'quiz' },
  { key: 'review', label: 'Review', href: '/review', icon: 'replay' },
  { key: 'performance', label: 'Progress', href: '/performance', icon: 'monitoring' },
];
/** Pages that light up a bottom-nav tab other than their own key. */
const BOTTOM_ALIAS: Record<string, string> = { create: 'qbank', test: 'qbank', results: 'qbank' };

export function PortalLayout(props: { title: string; active: string; user: User; shell?: Shell; children: Child; wide?: boolean }) {
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
            {s && s.lecturesTotal > 0 && !isStaff(props.user) && (
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
            {groups(isStaff(props.user), isAdmin(props.user)).map((g) => (
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
            <div class="drawer-foot">© {new Date().getUTCFullYear()} USMLE100</div>
          </div>
        </nav>

        <header class="topbar-app">
          <label for="drawer" class="tb-btn tb-menu" aria-label="Menu">
            <Icon name="menu" />
          </label>
          <a href="/dashboard" class="tb-btn tb-btn-plain" aria-label="USMLE100 home">
            <LogoMark />
          </a>
          <span class="tb-spacer"></span>
          <form method="post" action="/qbank/quick">
            <button type="submit" class="tb-btn tb-green" aria-label="Start a quick 10-question block" title="Quick 10-question block">
              <Icon name="bolt" size={22} />
            </button>
          </form>
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
