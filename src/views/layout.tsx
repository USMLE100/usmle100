import type { Child } from 'hono/jsx';
import type { User } from '../lib/types';
import { isStaff } from '../lib/types';

const Logo = () => (
  <a href="/" class="logo" aria-label="USMLE100 home">
    <span class="logo-mark" aria-hidden="true">U</span>
    <span class="logo-word">
      USMLE<span>100</span>
    </span>
  </a>
);

function Doc(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · USMLE100</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export function PublicLayout(props: { title: string; user: User | null; children: Child }) {
  return (
    <Doc title={props.title}>
      <header class="topbar">
        <div class="wrap topbar-row">
          <Logo />
          <nav aria-label="Main" class="topnav">
            <a href="/programs">Programs</a>
            {props.user ? (
              <a class="btn btn-primary" href="/dashboard">
                Open portal
              </a>
            ) : (
              <>
                <a href="/sign-in">Sign in</a>
                <a class="btn btn-primary" href="/sign-up">
                  Create account
                </a>
              </>
            )}
          </nav>
        </div>
      </header>
      {props.children}
      <footer class="footer wrap">© {new Date().getUTCFullYear()} USMLE100 · Not affiliated with NBME, FSMB or ECFMG.</footer>
    </Doc>
  );
}

type NavItem = { key: string; label: string; sub: string; href: string };

const groups = (staff: boolean): { label: string; items: NavItem[] }[] => [
  {
    label: '',
    items: [
      { key: 'home', label: 'Home', sub: 'Today at a glance', href: '/dashboard' },
      { key: 'exam', label: 'Exam window', sub: 'Days 91 to 100', href: '/exam-window' },
    ],
  },
  {
    label: 'Help',
    items: [
      { key: 'book', label: '1-on-1', sub: 'Book with Dr. Khan', href: '/book' },
      { key: 'programs', label: 'Programs', sub: 'Packages and pricing', href: '/programs' },
    ],
  },
  { label: 'Study', items: [{ key: 'lectures', label: 'Lectures', sub: "Watch today's class", href: '/lectures' }] },
  { label: 'Practice', items: [{ key: 'create', label: 'Create a test', sub: 'Pick your pools', href: '/create-test' }] },
  { label: 'Progress', items: [{ key: 'performance', label: 'Performance', sub: 'Scores by system', href: '/performance' }] },
  ...(staff
    ? [
        {
          label: 'Admin',
          items: [
            { key: 'admin-lectures', label: 'Lectures', sub: 'Add Day 1, Day 2…', href: '/admin/lectures' },
            { key: 'admin-questions', label: 'Questions', sub: 'Write, import, approve', href: '/admin/questions' },
            { key: 'admin-settings', label: 'Site settings', sub: 'Prices, links, dates', href: '/admin/settings' },
          ],
        },
      ]
    : []),
];

export function PortalLayout(props: { title: string; active: string; user: User; children: Child }) {
  return (
    <Doc title={props.title}>
      <div class="portal">
        <nav class="sidebar" aria-label="Portal">
          <div class="sidebar-top">
            <Logo />
            <input type="checkbox" id="nav-toggle" class="sr" />
            <label for="nav-toggle" class="btn btn-ghost menu-btn">Menu</label>
          </div>
          <div class="nav-body">
          {groups(isStaff(props.user)).map((g) => (
            <div class="nav-group">
              {g.label && <div class="nav-label">{g.label}</div>}
              {g.items.map((i) => (
                <a href={i.href} class={'nav-item' + (i.key === props.active ? ' active' : '')} aria-current={i.key === props.active ? 'page' : undefined}>
                  <span class="nav-title">{i.label}</span>
                  <span class="nav-sub">{i.sub}</span>
                </a>
              ))}
            </div>
          ))}
          <form method="post" action="/sign-out" class="nav-exit">
            <button type="submit" class="btn btn-ghost btn-block">
              Exit
            </button>
          </form>
          </div>
        </nav>
        <main class="portal-main">{props.children}</main>
      </div>
    </Doc>
  );
}

export const Eyebrow = (p: { children: Child }) => <div class="eyebrow">{p.children}</div>;

export const Flash = (p: { kind?: 'error' | 'ok'; children: Child }) => (
  <p class={'flash ' + (p.kind === 'error' ? 'flash-error' : 'flash-ok')} role={p.kind === 'error' ? 'alert' : 'status'}>
    {p.children}
  </p>
);
