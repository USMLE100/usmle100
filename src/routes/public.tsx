import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { PublicLayout, PortalLayout, Flash, LogoMark } from '../views/layout';
import { Icon } from '../views/icons';
import { createSession, destroySession, hashPassword, verifyPassword, requireUser, sha256Hex } from '../lib/auth';
import { checkDevice, deviceLabel, deviceToken, type DeviceCheck } from '../lib/devices';
import { signInRisk, RISK_TEXT } from '../lib/risk';
import { emailReady, notify, sendCode, sendEmail, smsReady, checkCode } from '../lib/messaging';
import { accountLocked, clearFailures, rateHit, unlockAccount, emailKey, ipKey, lockedFor, recordFailure } from '../lib/ratelimit';
import { MIN_PASSWORD, passwordProblem } from '../lib/passwords';
import { EXAMS, MARKETING_TEXT, gradYears, normalizePhone, validName } from '../lib/profile';
import { audit } from '../lib/audit';
import { consumeResetToken, createResetToken, resetTokenUser } from '../lib/reset';
import { handleDispute, handleRefund, activateEnrollment, createCheckoutSession, fulfil, fulfilBookPurchase, retrieveCheckoutSession, verifyWebhook } from '../lib/stripe';
import { BOOK_PRICE_CENTS, hasBook } from '../lib/book';
import { currentCohort, dayDate, fmtDate, money, todayUtc, ymdToUtc } from '../lib/content';
import { getSettings } from '../lib/settings';
import { enrollingCohort, enrollingLine } from '../lib/enrolling';

export type Pkg = { id: string; name: string; tagline: string; price_cents: number; one_on_one_sessions: number; evening_q_months: number; recommended: number };

// What each package includes. Kept in code so it is versioned with the site.
export const INCLUDES: Record<string, string[]> = {
  refresher: [
    '100-day program: 90 days of live lectures, then a 10-day exam window',
    'Live instruction on each scheduled class day',
    'Integrated review of foundational sciences and the major organ systems',
    'USMLE-style question interpretation and clinical reasoning',
    'Lecture recordings for review',
    'Group practice test together during the exam window',
  ],
  companion: [
    'Everything in Refresher, plus:',
    '4 months of live Evening Q’s',
    'USMLE100 Comprehensive Course Book',
    'Discussion of commonly tested distractors and misconceptions',
    'Training in NBME-style clinical reasoning',
  ],
  complete: [
    'Everything in Companion, plus:',
    '10 private one-on-one sessions (60 min each)',
    'Personalised identification and remediation of knowledge gaps',
    'Individual NBME- and UWorld-style question breakdowns',
    'Flexible session scheduling',
  ],
  max: [
    'Everything in Complete, plus:',
    '40 private one-on-one sessions (60 min each)',
    'Comprehensive assessment of academic strengths and weaknesses',
    'Personalised study planning and preparation priorities',
    'Exam-readiness guidance and progress review',
    'Test-day strategy: pacing, breaks and exam-day organisation',
  ],
};

export const INDIVIDUAL = [
  { name: 'Evening Questions', price: '$160', unit: 'per month', desc: 'Live, instructor-guided USMLE-style question review. Paid month by month.' },
  { name: 'One-on-one tutoring', price: '$50', unit: 'per 60-minute session', desc: 'Personalised tutoring on your own weak areas, question interpretation and clinical reasoning.' },
  { name: 'USMLE100 Course Book', price: money(BOOK_PRICE_CENTS), unit: 'one-time', desc: 'A structured companion resource supporting organised review of high-yield concepts.' },
];

export const publicRoutes = new Hono<AppEnv>();

/** Simple flat portrait used on the audience cards (original drawing, no photos). */
const Bust = (p: { skin: string; hair: string; shirt: string; bg: string; long?: boolean }) => (
  <svg viewBox="0 0 200 150" class="bust" aria-hidden="true" style={`background:${p.bg}`}>
    {p.long && <path d="M62 52c0-30 18-44 38-44s38 14 38 44v58H62z" fill={p.hair} />}
    <path d="M40 150c4-34 28-52 60-52s56 18 60 52z" fill={p.shirt} />
    <rect x="88" y="78" width="24" height="30" rx="10" fill={p.skin} filter="brightness(.9)" />
    <ellipse cx="100" cy="58" rx="28" ry="32" fill={p.skin} />
    {!p.long && <path d="M72 54c-2-26 14-36 28-36s30 10 28 36c-6-12-16-16-28-16s-22 4-28 16z" fill={p.hair} />}
    {p.long && <path d="M72 58c0-24 12-34 28-34s28 10 28 34c-8-14-18-18-28-18s-20 4-28 18z" fill={p.hair} />}
    <path d="M90 104l10 10 10-10" fill="#fff" opacity=".9" />
  </svg>
);

publicRoutes.get('/', async (c) => {
  const user = c.get('user');
  const settings = await getSettings(c.env.DB);
  const pkgs = (await c.env.DB.prepare('SELECT price_cents FROM packages ORDER BY price_cents LIMIT 1').all<{ price_cents: number }>()).results;
  const from = pkgs[0] ? money(pkgs[0].price_cents) : null;
  // Titles only: the videos themselves need an account (owner: register before watching anything).
  const free = (await c.env.DB.prepare('SELECT id, title, category FROM free_videos WHERE published = 1 ORDER BY sort, id LIMIT 6').all<{ id: number; title: string; category: string }>()).results;
  return c.html(
    <PublicLayout title="Board prep, taught live by doctors" user={user} legal={{ terms: !!settings.terms_text, privacy: !!settings.privacy_text, refunds: !!settings.refund_text }}>
      <section class="hero hero-dark">
        <div class="wrap">
          {settings.student_count && <p class="join">Join <strong>{settings.student_count}</strong> students preparing with USMLE100</p>}
          <h1>Board prep, <em>taught live</em> by doctors.</h1>
          <p class="exams">USMLE Step 1 · COMLEX · CBSE</p>
          <p class="lead">Daily live classes. One-on-one tutoring. No endless video library. No guessing what to study next.</p>
          <div class="row">
            <a class="btn btn-gold" href="/programs">See programs</a>
            <a class="btn btn-ghost-light" href={user ? '/dashboard' : '/sign-up'}>{user ? 'Open portal' : 'Create account'}</a>
          </div>
        </div>
      </section>

      <section class="aud-wrap" aria-label="Who it is for">
        <div class="aud">
          <a href="/programs"><Bust bg="#deece0" skin="#e9c39f" hair="#3a2a20" shirt="#2e936f" /><span class="lbl">Medical students <Icon name="arrow_forward" class="gic" /></span></a>
          <a href="/programs"><Bust bg="#e3ecf2" skin="#c98c62" hair="#1f1a17" shirt="#8cb0b2" long /><span class="lbl">IMGs &amp; FMGs <Icon name="arrow_forward" class="gic" /></span></a>
          <a href="/programs"><Bust bg="#f2e6ec" skin="#8a5a3b" hair="#2b1d16" shirt="#9b6bb0" /><span class="lbl">Repeat takers <Icon name="arrow_forward" class="gic" /></span></a>
        </div>
      </section>

      <div class="trust">
        <span><Icon name="verified" size={20} />Taught by doctors</span>
        <span><Icon name="videocam" size={20} />Live daily</span>
        <span><Icon name="monitoring" size={20} />Progress tracking</span>
        <span><Icon name="premium" size={20} />One price</span>
      </div>

      <section class="pass">
        <div class="wrap">
          <h2>Pass your boards without teaching yourself.</h2>
          <ul>
            <li><Icon name="check" />90 days of live lectures on weekdays, then a 10-day exam window</li>
            <li><Icon name="check" /><span><strong>Every class is recorded</strong>, so you can catch up or rewatch</span></li>
            <li><Icon name="check" />A question bank that tracks your results by system and discipline</li>
            <li><Icon name="check" />Evening question sessions and private one-on-one tutoring</li>
          </ul>
        </div>
      </section>

      <section class="ways">
        <div class="wrap">
          <h2>Three ways in</h2>
          <div class="addons">
            <a class="addon tile-green" href="/programs"><span class="ti"><Icon name="school" size={22} /></span><h3>100-day programs</h3><p>Live lectures, recordings and the question bank, with Evening Questions and tutoring in the larger packages.</p>{from && <span class="p">From {from} <small>one-time</small></span>}</a>
            <a class="addon tile-sky" href="/programs#addons"><span class="ti"><Icon name="videocam" size={22} /></span><h3>Evening Questions</h3><p>Live question sessions on Monday, Wednesday and Friday evenings.</p><span class="p">$160 <small>per month</small></span></a>
            <a class="addon tile-warm" href="/programs#addons"><span class="ti"><Icon name="person" size={22} /></span><h3>One-on-one tutoring</h3><p>A private hour on your own weak areas, over Zoom.</p><span class="p">$50 <small>per session</small></span></a>
          </div>
        </div>
      </section>

      {free.length > 0 && (
        <section class="ways" id="free-lectures">
          <div class="wrap">
            <h2>Watch free lectures</h2>
            <p class="muted" style="margin-top:-8px">See how we teach before you enroll. Create a free account to watch.</p>
            <div class="addons">
              {free.map((f) => (
                <a class="addon tile-green" href={user ? `/free-lectures/${f.id}` : `/sign-up?next=${encodeURIComponent('/free-lectures/' + f.id)}`}>
                  <span class="ti"><Icon name="play" size={22} /></span>
                  <h3>{f.title}</h3>
                  <p>{f.category === 'info' ? 'About USMLE100' : f.category === 'evening' ? 'Evening Questions class' : f.category === 'sample' ? 'Sample class' : 'Free lecture'}</p>
                  <span class="p">{user ? 'Watch now' : 'Free with an account'}</span>
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      <section class="wrap" style="padding-bottom:56px">
        <div class="cta-band">
          <h2>Ready to start?</h2>
          <p>Pick a program, and your portal opens as soon as payment goes through.</p>
          <a class="btn btn-primary" href="/programs">See programs</a>
        </div>
      </section>
    </PublicLayout>,
  );
});

/** Short line above each package name. */
export const KICKER: Record<string, string> = {
  refresher: 'Comprehensive foundational review',
  companion: 'Comprehensive learning and structured question practice',
  complete: 'Learning plus private tutoring',
  max: 'Our most complete program',
};
/** How many lines of the package list show before "Show full feature list". */
const SHOW = 4;

type Row = { label: string; cells: (string | boolean)[] };
const COMPARE: Row[] = [
  { label: '90 days of live lectures + 10-day exam window', cells: [true, true, true, true] },
  { label: 'Lecture recordings for review', cells: [true, true, true, true] },
  { label: 'USMLE-style question interpretation and clinical reasoning', cells: [true, true, true, true] },
  { label: 'Group practice test in the exam window', cells: [true, true, true, true] },
  { label: 'Live Evening Q’s', cells: [false, '4 months', '4 months', '4 months'] },
  { label: 'USMLE100 Comprehensive Course Book', cells: [false, true, true, true] },
  { label: 'Private one-on-one sessions (60 min)', cells: [false, false, '10', '40'] },
  { label: 'Personalised study planning and test-day strategy', cells: [false, false, false, true] },
];

const FAQ = (p: { start: string | null }) => {
  const qa: [string, string][] = [
    ['Are these one-time payments?', 'Yes. Each package is a one-time enrollment price, not a subscription. Evening Questions bought on its own is paid month by month.'],
    ['How long is the program?', `100 days: 90 weekday lecture days, then a 10-weekday exam window.${p.start ? ` The next cohort starts on ${p.start}.` : ''}`],
    ['How long can I watch the lecture recordings?', 'Until 60 days after the last day of your program (Day 100).'],
    [
      'How many times can I watch each recording?',
      'Recordings stream in your portal only; they can’t be downloaded. Each lecture can be watched up to 5 times per enrollment. A viewing counts once you’ve watched 65% of it, or 24 hours after you press play, and you can pause and come back within those 24 hours. Your name and account number appear on the video, and your account works on up to 2 registered devices.',
    ],
    ['How do Evening Questions work?', 'Live question sessions on Monday, Wednesday and Friday evenings. Each month covers the next 12 classes from your start date, and you can rewatch them until 2 days after the 12th class goes up. Companion, Complete and MAX include 4 months.'],
    ['How many tutoring sessions are included?', 'Complete includes 10 private one-on-one sessions and MAX includes 40, each 60 minutes. Extra sessions are $50 each.'],
    ['Can I buy tutoring, Evening Questions or the Course Book separately?', 'Yes: one-on-one tutoring is $50 per session, Evening Questions is $160 per month and the Course Book is $199. Use the buttons above to ask us.'],
  ];
  return (
    <div class="faq">
      {qa.map(([q, a]) => (
        <details>
          <summary>{q}<span class="pl"><Icon name="close" size={16} /></span></summary>
          <p>{a}</p>
        </details>
      ))}
    </div>
  );
};

publicRoutes.get('/programs', async (c) => {
  const user = c.get('user');
  const pkgs = (await c.env.DB.prepare('SELECT * FROM packages ORDER BY sort').all<Pkg>()).results;
  const settings = await getSettings(c.env.DB);
  const cohort = await currentCohort(c.env.DB);
  const start = cohort && ymdToUtc(cohort.start_date) >= todayUtc() ? fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : null;
  const short = (n: string) => n.replace('USMLE100 MedSchool ', '');
  const enrolled = !!c.get('enrollment');
  const body = (
    <>
      <div class="page-head">
        <div class="eyebrow">Programs &amp; tuition</div>
        <h1>Preparation Packages</h1>
        <p>Structured live instruction, question review and one-on-one tutoring. Every package is a one-time enrollment fee.</p>
      </div>
      <div class="pkgs">
        {pkgs.map((p) => {
          const list = INCLUDES[p.id] ?? [];
          return (
            <section class={'card pkg' + (p.recommended ? ' rec' : '')}>
              {p.recommended ? <span class="badge">Recommended</span> : p.id === 'max' ? <span class="badge badge-soft">Most comprehensive</span> : null}
              {KICKER[p.id] && <div class="kick">{KICKER[p.id]}</div>}
              <h2>{p.name}</h2>
              <p class="desc">{p.tagline}</p>
              <div class="price"><b>{money(p.price_cents)}</b><span>one-time enrollment</span></div>
              {(p.one_on_one_sessions > 0 || p.evening_q_months > 0) && (
                <div class="counts">
                  {p.evening_q_months > 0 && <span><Icon name="videocam" size={18} />{p.evening_q_months} months of Evening Q’s</span>}
                  {p.one_on_one_sessions > 0 && <span><Icon name="person" size={18} />{p.one_on_one_sessions} one-on-one sessions</span>}
                </div>
              )}
              <div class="checks-label">{list[0]?.startsWith('Everything') ? list[0].replace(/,? plus:$/, ', plus') : 'Core curriculum includes'}</div>
              <ul class="checks">
                {list.filter((i) => !i.startsWith('Everything')).slice(0, SHOW).map((i) => <li><Icon name="check_circle" size={20} />{i}</li>)}
              </ul>
              {list.filter((i) => !i.startsWith('Everything')).length > SHOW && (
                <details class="more">
                  <summary>Show full feature list <Icon name="down" size={18} /></summary>
                  <ul class="checks">
                    {list.filter((i) => !i.startsWith('Everything')).slice(SHOW).map((i) => <li><Icon name="check_circle" size={20} />{i}</li>)}
                  </ul>
                </details>
              )}
              {!enrolled && (
                <form method="post" action={`/enroll/${p.id}`}>
                  <button class={'btn btn-block ' + (p.recommended ? 'btn-primary' : 'btn-outline')} type="submit">Enroll in {short(p.name)}</button>
                </form>
              )}
            </section>
          );
        })}
      </div>

      <h2 class="section-title">Side-by-Side Comparison</h2>
      <div class="compare" role="region" aria-label="Package comparison" tabindex={0}>
        <table>
          <thead>
            <tr><th scope="col">Included feature</th>{pkgs.map((p) => <th scope="col">{short(p.name)}</th>)}</tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr>
                <td>{r.label}</td>
                {pkgs.map((_, i) => {
                  const v = r.cells[i];
                  return <td>{v === true ? <Icon name="check_circle" size={22} label="Included" /> : v === false || v == null ? <span class="dash" aria-label="Not included">–</span> : v}</td>;
                })}
              </tr>
            ))}
            <tr><td><strong>Tuition (one-time)</strong></td>{pkgs.map((p) => <td><strong>{money(p.price_cents)}</strong></td>)}</tr>
          </tbody>
        </table>
      </div>

      <h2 class="section-title" id="addons">Standalone Courses &amp; Add-Ons</h2>
      <div class="addons">
        {INDIVIDUAL.map((i, k) => (
          <div class={'addon ' + ['tile-olive', 'tile-warm', 'tile-sky'][k % 3]}>
            <h3>{i.name}</h3>
            <span class="p">{i.price} <small>{i.unit}</small></span>
            <p>{i.desc}</p>
            {settings.contact_email && (
              i.name === 'USMLE100 Course Book' ? <a class="btn btn-primary" href="/buy/course-book">Buy the Course Book</a> : <a class="btn btn-primary" href={`mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: ' + i.name)}`}>Inquire about {i.name}</a>
            )}
          </div>
        ))}
      </div>

      <h2 class="section-title">Frequently Asked Questions</h2>
      <FAQ start={start} />
    </>
  );
  if (user) {
    return c.html(
      <PortalLayout shell={c.get('shell')} title="Programs" active="programs" user={user} wide>
        {body}
      </PortalLayout>,
    );
  }
  return c.html(
    <PublicLayout title="Programs" user={null} legal={{ terms: !!settings.terms_text, privacy: !!settings.privacy_text, refunds: !!settings.refund_text }}>
      <main class="wrap page stack" style="gap:20px;max-width:1000px">{body}</main>
    </PublicLayout>,
  );
});

// ---------- Terms and Privacy (text set in Admin -> Site settings) ----------

const legalPage = (title: string, key: 'terms_text' | 'privacy_text' | 'refund_text') => async (c: any) => {
  const settings = await getSettings(c.env.DB);
  const text = settings[key];
  if (!text) return c.notFound();
  return c.html(
    <PublicLayout title={title} user={c.get('user')} legal={{ terms: !!settings.terms_text, privacy: !!settings.privacy_text, refunds: !!settings.refund_text }}>
      <main class="wrap page legal">
        <h1>{title}</h1>
        {text.split(/\n\s*\n/).map((p: string) => <p>{p.trim()}</p>)}
      </main>
    </PublicLayout>,
  );
};
publicRoutes.get('/terms', legalPage('Terms of Service', 'terms_text'));
publicRoutes.get('/privacy', legalPage('Privacy Policy', 'privacy_text'));
publicRoutes.get('/refunds', legalPage('Refund Policy', 'refund_text'));

// ---------- Accounts ----------

const AuthBrand = () => (
  <aside class="auth-brand">
    <a href="/" class="lw" style="color:#fff;text-decoration:none" aria-label="USMLE100 home"><LogoMark size={44} light /><b>USMLE<span>100</span></b></a>
    <div class="auth-tag">Get In. Get Out. Get Licensed.</div>
    <h2>Everything you need for your boards, in one place.</h2>
    <ul>
      <li><Icon name="play_circle" /><span><strong>Live video lectures</strong><span>A class every weekday, recorded so you can rewatch.</span></span></li>
      <li><Icon name="quiz" /><span><strong>Question bank</strong><span>Tutor, timed and untimed tests with explanations.</span></span></li>
      <li><Icon name="videocam" /><span><strong>Evening Questions</strong><span>Live question sessions on Monday, Wednesday and Friday.</span></span></li>
      <li><Icon name="event" /><span><strong>One-on-one tutoring</strong><span>Private sessions on your weakest areas.</span></span></li>
      <li><Icon name="monitoring" /><span><strong>Progress that means something</strong><span>See what’s left, not just what exists.</span></span></li>
    </ul>
  </aside>
);

const PwField = (p: { label: string; name: string; autocomplete: string; minlength?: number }) => (
  <label class="field">
    {p.label}
    <span class="pw-wrap">
      <input type="password" name={p.name} required minlength={p.minlength} autocomplete={p.autocomplete} />
      <button type="button" class="pw-eye" aria-label="Show password" data-eye><Icon name="visibility" size={22} /></button>
    </span>
  </label>
);
const EYE_JS = `document.querySelectorAll('[data-eye]').forEach(function(b){b.addEventListener('click',function(){var i=b.previousElementSibling,show=i.type==='password';i.type=show?'text':'password';b.setAttribute('aria-label',show?'Hide password':'Show password');b.classList.toggle('on',show);});});`;

/** Students may use 2 registered devices; staff are not limited but their device is still recorded. */
async function deviceGate(c: Context<AppEnv>, userId: number, role: string): Promise<DeviceCheck> {
  if (role !== 'student') return { ok: true, hash: await sha256Hex(deviceToken(c)) };
  return checkDevice(c, userId);
}
const DEVICE_MSG: Record<'new' | 'pending' | 'declined', string> = {
  new: 'This is a new device. Your account can be used on 2 registered devices and both are in use, so USMLE100 must approve replacing one. We’ve sent the request. Until it’s approved, please sign in on one of your registered devices.',
  pending: 'This device is still waiting for USMLE100 to approve it. Until then, please sign in on one of your registered devices.',
  declined: 'This device wasn’t approved for your account. Please sign in on one of your registered devices, or contact USMLE100.',
};

const ENDED: Record<string, string> = {
  idle: 'You were signed out after 30 minutes without activity. Please sign in again.',
  expired: 'For your security, sign-ins last at most 24 hours. Please sign in again.',
  out: 'You have been signed out.',
  password: 'Your password was changed and you were signed out everywhere. Please sign in with your new password.',
  revoked: 'That sign-in was ended. Please sign in again.',
  verify: 'That sign-in was blocked because the security codes weren’t confirmed. If it was you, contact USMLE100.',
};

type SignupForm = { turnstile?: string; first?: string; last?: string; phone?: string; exam?: string; grad?: string; marketing?: boolean };
const AuthPage = (p: { mode: 'in' | 'up'; selfReset?: boolean; error?: string; notice?: string; email?: string; name?: string; form?: SignupForm; next?: string; user: any; contact?: string }) => (
  <PublicLayout title={p.mode === 'in' ? 'Sign in' : 'Create account'} user={p.user} plain>
    <div class="auth">
      <AuthBrand />
      <main class="auth-form">
        <h1>{p.mode === 'in' ? 'Welcome back' : 'Create your account'}</h1>
        <p class="sub">{p.mode === 'in' ? 'Sign in to pick up where you left off.' : 'Create an account, then choose your program to unlock the portal.'}</p>
        {p.notice && !p.error && <Flash kind="ok">{p.notice}</Flash>}
        {p.error && <Flash kind="error">{p.error}</Flash>}
        <form method="post" class="stack" style="gap:14px">
          {p.next && <input type="hidden" name="next" value={p.next} />}
          {p.mode === 'up' && (
            <div class="grid" style="gap:12px">
              <label class="field">First name<input type="text" name="first_name" required maxlength={60} autocomplete="given-name" value={p.form?.first ?? ''} /></label>
              <label class="field">Last name<input type="text" name="last_name" required maxlength={60} autocomplete="family-name" value={p.form?.last ?? ''} /></label>
            </div>
          )}
          <label class="field">
            Email
            <input type="email" name="email" required autocomplete="email" value={p.email ?? ''} />
          </label>
          {p.mode === 'up' && (
            <>
              <label class="field">Mobile phone<input type="tel" name="phone" required autocomplete="tel" maxlength={25} placeholder="+1 555 123 4567" value={p.form?.phone ?? ''} /><span class="muted small" style="font-weight:500">Include your country code if you’re outside the US.</span></label>
              <div class="grid" style="gap:12px">
                <label class="field">Preparing for<select name="exam" required><option value="">Choose…</option>{EXAMS.map((e) => <option value={e} selected={p.form?.exam === e}>{e}</option>)}</select></label>
                <label class="field">Graduation year<select name="grad_year" required><option value="">Choose…</option>{gradYears().map((y) => <option value={String(y)} selected={p.form?.grad === String(y)}>{y}</option>)}</select></label>
              </div>
            </>
          )}
          <PwField label="Password" name="password" autocomplete={p.mode === 'up' ? 'new-password' : 'current-password'} minlength={p.mode === 'up' ? MIN_PASSWORD : undefined} />
          {p.mode === 'up' && <span class="muted small">At least {MIN_PASSWORD} characters. A short phrase of a few words works well.</span>}
          {p.mode === 'up' && <label class="check"><input type="checkbox" name="marketing" value="1" checked={!!p.form?.marketing} /> {MARKETING_TEXT} (optional)</label>}
          {p.mode === 'up' && p.form?.turnstile && (
            <>
              <div class="cf-turnstile" data-sitekey={p.form.turnstile}></div>
              <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            </>
          )}
          {p.mode === 'in' && (
            <div class="auth-links">
              {p.selfReset ? <a href="/forgot">Forgot your password?</a> : p.contact && <a href={`mailto:${p.contact}?subject=${encodeURIComponent('USMLE100: password reset')}`}>Forgot your password?</a>}
            </div>
          )}
          <button class="btn btn-primary btn-block" type="submit">
            {p.mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {p.mode === 'in' && p.contact && !p.selfReset && (
          <p class="small muted">To reset your password, email us from the address you signed up with and we’ll send you a link.</p>
        )}
        <p class="small" style="text-align:center">
          {p.mode === 'in' ? <>New here? <a href={p.next ? `/sign-up?next=${encodeURIComponent(p.next)}` : '/sign-up'}>Create an account</a></> : <>Already have an account? <a href={p.next ? `/sign-in?next=${encodeURIComponent(p.next)}` : '/sign-in'}>Sign in</a></>}
        </p>
        <p class="small" style="text-align:center"><a href="/programs">See programs</a> · <a href="/">Home</a></p>
      </main>
    </div>
    <script dangerouslySetInnerHTML={{ __html: EYE_JS }} />
  </PublicLayout>
);

const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

publicRoutes.get('/sign-up', (c) => c.html(<AuthPage mode="up" user={c.get('user')} next={c.req.query('next')} form={{ turnstile: c.env.TURNSTILE_SITE_KEY }} />));

/** Cloudflare Turnstile (free bot check), only when its keys are set. */
async function humanCheck(c: Context<AppEnv>, token: unknown) {
  if (!c.env.TURNSTILE_SECRET) return true;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: String(token ?? ''), remoteip: c.req.header('cf-connecting-ip') ?? '' }),
    });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}
publicRoutes.post('/sign-up', async (c) => {
  const f = await c.req.parseBody();
  const first = String(f.first_name ?? '').trim().replace(/\s+/g, ' ');
  const last = String(f.last_name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const phoneRaw = String(f.phone ?? '');
  const exam = String(f.exam ?? '');
  const grad = String(f.grad_year ?? '');
  const marketing = f.marketing === '1';
  const form: SignupForm = { first, last, phone: phoneRaw, exam, grad, marketing, turnstile: c.env.TURNSTILE_SITE_KEY };
  const again = (error: string, status: 400 | 429 = 400) => c.html(<AuthPage mode="up" error={error} email={email} form={form} user={null} next={typeof f.next === 'string' ? f.next : undefined} />, status);
  // Generous limit per network address, so a school network still works but bots can't flood the student list.
  const ip = c.req.header('cf-connecting-ip') ?? null;
  if (ip && !(await rateHit(c.env.DB, `signup:${ip}`, 10, 3600))) return again('Too many new accounts from your network in the last hour. Please try again later.', 429);
  if (!(await humanCheck(c, f['cf-turnstile-response']))) return again('Please complete the check that you’re not a robot.');
  if (!validName(first) || !validName(last)) return again('Please enter your first and last name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return again('Please enter a valid email.');
  const phone = normalizePhone(phoneRaw);
  if (!phone) return again('Please enter a valid mobile number. Outside the US, start with + and your country code.');
  if (!EXAMS.includes(exam)) return again('Please choose the exam you’re preparing for.');
  if (!gradYears().includes(Number(grad))) return again('Please choose your graduation year.');
  const name = `${first} ${last}`;
  const bad = await passwordProblem(password);
  if (bad) return again(bad);
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return again('An account with that email already exists. Try signing in.');
  // Public sign-up always creates a student. Faculty and admin roles are only given by an admin (Admin -> Team).
  const { hash, salt } = await hashPassword(password);
  const source = typeof f.next === 'string' && f.next.startsWith('/free-lectures') ? 'free-lectures' : typeof f.next === 'string' && f.next.startsWith('/buy/') ? 'course-book' : typeof f.next === 'string' && f.next.startsWith('/webinars') ? 'webinar' : 'sign-up';
  const r = await c.env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, password_salt, role, first_name, last_name, phone, exam, grad_year, signup_source, marketing_opt_in, marketing_consent_at, marketing_consent_text)
     VALUES (?, ?, ?, ?, 'student', ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END, ?)`,
  )
    .bind(email, name, hash, salt, first, last, phone, exam, Number(grad), source, marketing ? 1 : 0, marketing ? 1 : 0, marketing ? MARKETING_TEXT : null)
    .run();
  await createSession(c, Number(r.meta.last_row_id), (await deviceGate(c, Number(r.meta.last_row_id), 'student')).hash);
  await audit(c.env.DB, { actorId: Number(r.meta.last_row_id), action: 'account.created', targetUserId: Number(r.meta.last_row_id), ip: c.req.header('cf-connecting-ip') ?? null });
  // Someone who signed up for something specific (the Course Book, free lectures, a webinar) goes back to it.
  return c.redirect(typeof f.next === 'string' && /^\/(buy|free-lectures|webinars)(\/|$)/.test(f.next) ? safeNext(f.next) : '/enroll');
});

const contactEmail = async (db: D1Database) => (await getSettings(db)).contact_email || undefined;

publicRoutes.get('/sign-in', async (c) =>
  c.html(<AuthPage mode="in" next={c.req.query('next')} notice={ENDED[c.req.query('ended') ?? '']} user={c.get('user')} contact={await contactEmail(c.env.DB)} selfReset={emailReady(c.env)} />),
);
publicRoutes.post('/sign-in', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  // Cloudflare sets CF-Connecting-IP to the visitor's address; visitors cannot override it.
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const contact = await contactEmail(c.env.DB);
  const lockedMsg = 'Too many sign-in attempts. This account is locked for your protection until USMLE100 unlocks it. Please contact us.';
  if (await accountLocked(c.env.DB, email)) {
    return c.html(<AuthPage mode="in" error={lockedMsg} email={email} user={null} contact={contact} />, 429);
  }
  const wait = await lockedFor(c.env.DB, [emailKey(email), ...(ip ? [ipKey(ip)] : [])]);
  if (wait > 0) {
    // Refused before the password is checked, so guessing gains nothing while locked.
    const minutes = Math.max(1, Math.ceil(wait / 60));
    return c.html(<AuthPage mode="in" error={`Too many sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`} email={email} user={null} contact={contact} />, 429);
  }
  const u = await c.env.DB.prepare('SELECT id, role, password_hash, password_salt FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; role: string; password_hash: string; password_salt: string }>();
  const ok = u ? await verifyPassword(password, u.password_hash, u.password_salt) : (await hashPassword(password), false);
  if (!u || !ok) {
    const nowLocked = await recordFailure(c.env.DB, email, ip);
    await audit(c.env.DB, { action: nowLocked ? 'signin.locked' : 'signin.failed', targetUserId: u?.id ?? null, detail: { email }, ip });
    if (nowLocked) return c.html(<AuthPage mode="in" error={lockedMsg} email={email} user={null} contact={contact} />, 429);
    return c.html(<AuthPage mode="in" error="That email and password don’t match." email={email} user={null} contact={contact} />, 401);
  }
  await clearFailures(c.env.DB, email);
  const where = { country: c.req.header('cf-ipcountry') ?? null, device: deviceLabel(c.req.header('user-agent') ?? '') };
  const dev = await deviceGate(c, u.id, u.role);
  if (!dev.ok) {
    await audit(c.env.DB, { actorId: u.id, action: 'signin.device_blocked', targetUserId: u.id, detail: { ...where, reason: dev.reason }, ip });
    return c.html(<AuthPage mode="in" error={DEVICE_MSG[dev.reason]} email={email} user={null} contact={contact} />, 403);
  }
  // Risky sign-ins get an extra email/phone code check before protected content opens (when email is set up).
  const risk = u.role === 'student' ? await signInRisk(c.env.DB, u.id, where.country, !!dev.fresh) : null;
  const check = risk && emailReady(c.env) ? risk : null;
  await createSession(c, u.id, dev.hash, check);
  await audit(c.env.DB, { actorId: u.id, action: 'signin.ok', targetUserId: u.id, detail: { ...where, risk }, ip });
  if (risk === 'new-device' || risk === 'new-country') {
    await notify(c.env, u.id, { kind: 'security', title: 'New sign-in to your account', body: `${RISK_TEXT[risk]} ${where.device}${where.country ? ` in ${where.country}` : ''}. If this wasn’t you, open My account, press “This wasn’t me” and change your password.` });
  }
  return c.redirect(check ? '/account/check-sign-in' : safeNext(f.next));
});

// ---------- Password reset (one-time links made by an admin) ----------

const ResetPage = (p: { token?: string; name?: string; error?: string; invalid?: boolean; phone?: string | null }) => (
  <PublicLayout title="Reset password" user={null} plain>
    <div class="auth">
      <AuthBrand />
      <main class="auth-form">
        <h1>Choose a new password</h1>
        {p.invalid ? (
          <>
            <Flash kind="error">This reset link has expired or has already been used.</Flash>
            <p class="small">Ask us for a new link, or <a href="/sign-in">sign in</a> if you remember your password.</p>
          </>
        ) : (
          <>
            <p class="sub">For {p.name}. This link works once and expires 1 hour after it was made.</p>
            {p.error && <Flash kind="error">{p.error}</Flash>}
            <form method="post" action="/reset-password" class="stack" style="gap:14px">
              <input type="hidden" name="token" value={p.token} />
              {p.phone && <label class="field">Code we texted to {p.phone}<input type="text" name="sms_code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required /></label>}
              <PwField label="New password" name="password" autocomplete="new-password" minlength={MIN_PASSWORD} />
              <PwField label="Type it again" name="again" autocomplete="new-password" minlength={MIN_PASSWORD} />
              <span class="muted small">At least {MIN_PASSWORD} characters. A short phrase of a few words works well.</span>
              <button class="btn btn-primary btn-block" type="submit">Save new password</button>
            </form>
          </>
        )}
      </main>
    </div>
    <script dangerouslySetInnerHTML={{ __html: EYE_JS }} />
  </PublicLayout>
);

publicRoutes.get('/reset-password', async (c) => {
  // The link's secret is in the address. The site-wide Referrer-Policy (strict-origin-when-cross-origin) means
  // other sites, such as the font server, only ever see https://<site>/ and never the path or token.
  c.header('Cache-Control', 'no-store');
  const token = c.req.query('token') ?? '';
  const u = await resetTokenUser(c.env.DB, token);
  if (!u) return c.html(<ResetPage invalid />, 400);
  // Recovery uses both the email (this link) and the verified phone (a texted code), when SMS is set up (R: password resets).
  const phone = await resetPhone(c, u.id);
  if (phone) {
    const active = await c.env.DB.prepare("SELECT 1 FROM otp_codes WHERE user_id = ? AND purpose = 'reset' AND channel = 'sms' AND used_at IS NULL AND expires_at > ?").bind(u.id, Math.floor(Date.now() / 1000)).first();
    if (!active) await sendCode(c.env, u.id, 'sms', 'reset', phone);
  }
  return c.html(<ResetPage token={token} name={u.name} phone={phone ? maskPhone(phone) : null} />);
});

async function resetPhone(c: Context<AppEnv>, userId: number) {
  if (!smsReady(c.env)) return null;
  const u = await c.env.DB.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').bind(userId).first<{ phone: string | null; phone_verified_at: string | null }>();
  return u?.phone && u.phone_verified_at ? u.phone : null;
}
const maskPhone = (p: string) => p.replace(/^(\+\d{1,3})\d+(\d{2})$/, '$1•••••$2');

// ---------- Self-service "Forgot password" (once email sending is set up) ----------

const ForgotPage = (p: { sent?: boolean; error?: string; contact?: string }) => (
  <PublicLayout title="Forgot password" user={null} plain>
    <div class="auth">
      <AuthBrand />
      <main class="auth-form">
        <h1>Forgot your password?</h1>
        {p.sent ? (
          <Flash kind="ok">If an account uses that email, we’ve sent it a link to choose a new password. It works once, for 1 hour.</Flash>
        ) : (
          <>
            <p class="sub">Enter the email you signed up with and we’ll send you a link.</p>
            {p.error && <Flash kind="error">{p.error}</Flash>}
            <form method="post" action="/forgot" class="stack" style="gap:14px">
              <label class="field">Email<input type="email" name="email" required autocomplete="email" /></label>
              <button class="btn btn-primary btn-block" type="submit">Send the link</button>
            </form>
          </>
        )}
        <p class="small" style="text-align:center"><a href="/sign-in">Back to sign in</a></p>
      </main>
    </div>
  </PublicLayout>
);

publicRoutes.get('/forgot', async (c) => (emailReady(c.env) ? c.html(<ForgotPage />) : c.redirect('/sign-in')));

publicRoutes.post('/forgot', async (c) => {
  if (!emailReady(c.env)) return c.redirect('/sign-in');
  const email = String((await c.req.parseBody()).email ?? '').trim().toLowerCase();
  const ip = c.req.header('cf-connecting-ip') ?? 'none';
  // The same answer whether or not the account exists; limited per network and per email.
  if (!(await rateHit(c.env.DB, `forgot:ip:${ip}`, 10, 3600)) || !(await rateHit(c.env.DB, `forgot:email:${email}`, 3, 3600))) return c.html(<ForgotPage sent />);
  const u = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND email NOT LIKE '%.invalid'").bind(email).first<{ id: number; email: string }>();
  if (u) {
    const token = await createResetToken(c.env.DB, u.id, null);
    const link = new URL('/reset-password?token=' + token, c.env.SITE_URL || c.req.url).toString();
    await sendEmail(c.env, u.email, 'Reset your USMLE100 password', `Someone asked to reset the password for your USMLE100 account.\n\nChoose a new password here (works once, for 1 hour):\n${link}\n\nIf this wasn’t you, ignore this email: your password hasn’t changed.`);
    await audit(c.env.DB, { action: 'password.reset_requested', targetUserId: u.id, ip });
  }
  return c.html(<ForgotPage sent />);
});

publicRoutes.post('/reset-password', async (c) => {
  c.header('Cache-Control', 'no-store');
  const f = await c.req.parseBody();
  const token = String(f.token ?? '');
  const password = String(f.password ?? '');
  const u = await resetTokenUser(c.env.DB, token);
  if (!u) return c.html(<ResetPage invalid />, 400);
  const bad = await passwordProblem(password);
  if (bad) return c.html(<ResetPage token={token} name={u.name} error={bad} />, 400);
  if (password !== String(f.again ?? '')) return c.html(<ResetPage token={token} name={u.name} error="The two passwords don’t match." />, 400);
  const phone = await resetPhone(c, u.id);
  if (phone) {
    const r = await checkCode(c.env.DB, u.id, 'sms', 'reset', String(f.sms_code ?? ''));
    if (r !== 'ok') return c.html(<ResetPage token={token} name={u.name} phone={maskPhone(phone)} error={r === 'locked' ? 'Too many wrong codes. Ask for a new link.' : 'The texted code isn’t right.'} />, 400);
  }
  if (!(await consumeResetToken(c.env.DB, token, u.id))) return c.html(<ResetPage invalid />, 400);
  const { hash, salt } = await hashPassword(password);
  // New password, and every existing sign-in for this account is ended.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, u.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  // A reset link is made by an administrator, so using it also lifts a sign-in lock (R029).
  await unlockAccount(c.env.DB, u.email, null);
  const role = (await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(u.id).first<{ role: string }>())?.role ?? 'student';
  const dev = await deviceGate(c, u.id, role);
  if (!dev.ok) return c.html(<AuthPage mode="in" notice={'Your new password is saved. ' + DEVICE_MSG[dev.reason]} user={null} />, 403);
  await createSession(c, u.id, dev.hash);
  await audit(c.env.DB, { actorId: u.id, action: 'password.reset', targetUserId: u.id, ip: c.req.header('cf-connecting-ip') ?? null });
  await notify(c.env, u.id, { kind: 'security', title: 'Password changed', body: 'Your password was reset with a recovery link and other devices were signed out. If this wasn’t you, contact USMLE100 right away.', sms: true });
  return c.redirect('/dashboard');
});

publicRoutes.post('/sign-out', async (c) => {
  await destroySession(c);
  return c.redirect('/');
});

// ---------- Enrollment and payment ----------

publicRoutes.get('/enroll', requireUser, async (c) => {
  if (c.get('enrollment')) return c.redirect('/dashboard');
  const pkgs = (await c.env.DB.prepare('SELECT * FROM packages ORDER BY sort').all<Pkg>()).results;
  const contact = (await getSettings(c.env.DB)).contact_email || undefined;
  const enrolling = await enrollingCohort(c.env.DB);
  return c.html(
    <PublicLayout title="Choose your program" user={c.get('user')}>
      <main class="wrap page stack" style="gap:18px;max-width:1000px">
        <div class="page-head">
          <div class="eyebrow">Enrollment</div>
          <h1>Choose your program</h1>
          <p>Your portal unlocks as soon as payment goes through. Every package is a one-time payment.</p>
        </div>
        {c.req.query('cancelled') && <Flash kind="error">Payment was cancelled. You have not been charged.</Flash>}
        {c.req.query('closed') && <Flash kind="error">Enrollment for this cohort has closed. Please contact us about the next one.</Flash>}
        {enrolling && <section class={'card' + (enrolling.closed ? ' flash-error' : '')} style="flex-direction:row;gap:10px;align-items:center"><Icon name="calendar" size={22} /><p style="margin:0"><strong>{enrollingLine(enrolling)}</strong></p></section>}
        <div class="pkgs">
          {pkgs.map((p) => (
            <form method="post" action={`/enroll/${p.id}`} class={'card pkg' + (p.recommended ? ' rec' : '')}>
              {p.recommended ? <span class="badge">Recommended</span> : null}
              <h2>{p.name}</h2>
              <p class="desc">{p.tagline}</p>
              <div class="price"><b>{money(p.price_cents)}</b><span>one-time</span></div>
              <button class={'btn btn-block ' + (p.recommended ? 'btn-primary' : 'btn-outline')} type="submit">
                Continue to payment
              </button>
            </form>
          ))}
        </div>
        <p class="small muted">
          Not sure which fits? <a href="/programs">Compare what each includes</a>.
        </p>
        <ViewingTerms />
        {contact && <RefundContact email={contact} />}
      </main>
    </PublicLayout>,
  );
});

publicRoutes.post('/enroll/:pkg', requireUser, async (c) => {
  const user = c.get('user')!;
  if (c.get('enrollment')) return c.redirect('/dashboard');
  const pkg = await c.env.DB.prepare('SELECT * FROM packages WHERE id = ?').bind(c.req.param('pkg')).first<Pkg>();
  if (!pkg) return c.text('Not found', 404);
  if (!paymentsReady(c)) return c.text('Payments are not set up yet.', 503);
  const enrolling = await enrollingCohort(c.env.DB);
  // With no cohort scheduled yet, the student is placed in the first one when payment is confirmed.
  if (enrolling?.closed) return c.redirect('/enroll?closed=1');
  // The price and the cohort shown on the page are saved with the pending enrollment; payment activates exactly these.
  const ins = await c.env.DB.prepare("INSERT INTO enrollments (user_id, package_id, status, amount_cents, cohort_id) VALUES (?, ?, 'pending', ?, ?)")
    .bind(user.id, pkg.id, pkg.price_cents, enrolling?.cohort.id ?? null)
    .run();
  const enrollmentId = Number(ins.meta.last_row_id);

  const siteUrl = (c.env.SITE_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  if (c.env.DEV_FAKE_PAYMENTS === '1' && new URL(c.req.url).protocol === 'http:') {
    const fakeId = 'dev_' + enrollmentId;
    await c.env.DB.prepare('UPDATE enrollments SET stripe_session_id = ? WHERE id = ?').bind(fakeId, enrollmentId).run();
    await activateEnrollment(c.env.DB, fakeId, enrollmentId, pkg.price_cents);
    return c.redirect('/welcome');
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.text('Payments are not set up yet.', 503);

  const session = await createCheckoutSession(c.env, {
    ref: String(enrollmentId),
    kind: 'enrollment',
    email: user.email,
    amountCents: pkg.price_cents,
    productName: pkg.name,
    successPath: '/enroll/success',
    cancelPath: '/enroll?cancelled=1',
    siteUrl,
  });
  await c.env.DB.prepare('UPDATE enrollments SET stripe_session_id = ? WHERE id = ?').bind(session.id, enrollmentId).run();
  return c.redirect(session.url, 303);
});

// ---------- The Course Book on its own ($199) ----------

const BookCheckout = (p: { user: any; owned: boolean; cancelled?: boolean; pending?: boolean; ready: boolean; legal: { terms: boolean; privacy: boolean; refunds: boolean }; contact?: string }) => (
  <PublicLayout title="USMLE100 Course Book" user={p.user} legal={p.legal}>
    <main class="wrap page stack" style="gap:18px;max-width:640px">
      <div class="page-head">
        <div class="eyebrow">Course Book</div>
        <h1>USMLE100 Course Book</h1>
        <p>A structured companion resource supporting organised review of high-yield concepts: written chapters you read online in your portal, personalised to you. It can’t be downloaded or shared.</p>
      </div>
      {p.cancelled && <Flash kind="error">Payment was cancelled. You have not been charged.</Flash>}
      {p.pending && <Flash>We haven’t received confirmation of your payment yet. If you were charged, your book unlocks as soon as Stripe confirms it — refresh in a minute.</Flash>}
      <section class="card addon tile-sky">
        <span class="p">{money(BOOK_PRICE_CENTS)} <small>one-time</small></span>
        <p>Already included with Companion, Complete and MAX.</p>
        {p.owned ? (
          <a class="btn btn-primary" href="/course-book">Open the Course Book</a>
        ) : p.ready ? (
          <form method="post" action="/buy/course-book">
            <button class="btn btn-primary btn-block" type="submit">Continue to payment</button>
          </form>
        ) : (
          <p class="small"><strong>Online payment isn’t switched on yet.</strong> Please contact us to buy the Course Book.</p>
        )}
        {(p.legal.terms || p.legal.refunds) && !p.owned && (
          <p class="small muted">By paying you agree to the {p.legal.terms && <a href="/terms">Terms of Service</a>}{p.legal.terms && p.legal.refunds && ' and '}{p.legal.refunds && <a href="/refunds">Refund Policy</a>}.</p>
        )}
        {p.contact && !p.owned && <RefundContact email={p.contact} />}
      </section>
    </main>
  </PublicLayout>
);

/** Refunds are decided by USMLE100 and issued by hand in Stripe; the site only tells students who to contact. */
/** Disclosed before checkout (R053 hides remaining counts in the portal until a lecture locks, so they're explained here). */
const ViewingTerms = () => (
  <p class="small muted">
    Lecture recordings stream in the portal only, with no downloads. Each lecture can be watched up to 5 times per enrollment; a viewing counts once you’ve watched 65% of it or 24
    hours after you press play. Your account is for you alone and works on up to 2 registered devices.
  </p>
);

const RefundContact = (p: { email: string }) => (
  <p class="small muted">To ask for a refund, email <a href={`mailto:${p.email}?subject=${encodeURIComponent('USMLE100: refund request')}`}>{p.email}</a>.</p>
);

const legalFlags = async (db: D1Database) => {
  const s = await getSettings(db);
  return { terms: !!s.terms_text, privacy: !!s.privacy_text, refunds: !!s.refund_text };
};
const paymentsReady = (c: any) => !!c.env.STRIPE_SECRET_KEY || (c.env.DEV_FAKE_PAYMENTS === '1' && new URL(c.req.url).protocol === 'http:');

publicRoutes.get('/buy/course-book', requireUser, async (c) => {
  const user = c.get('user')!;
  const owned = await hasBook(c.env.DB, user, c.get('enrollment'));
  return c.html(<BookCheckout user={user} owned={owned} cancelled={!!c.req.query('cancelled')} pending={!!c.req.query('pending')} ready={paymentsReady(c)} legal={await legalFlags(c.env.DB)} contact={(await getSettings(c.env.DB)).contact_email || undefined} />);
});

publicRoutes.post('/buy/course-book', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  if (await hasBook(db, user, c.get('enrollment'))) return c.redirect('/course-book');
  if (!paymentsReady(c)) return c.redirect('/buy/course-book');
  const ins = await db.prepare("INSERT INTO book_purchases (user_id, amount_cents) VALUES (?, ?)").bind(user.id, BOOK_PRICE_CENTS).run();
  const purchaseId = Number(ins.meta.last_row_id);
  if (!c.env.STRIPE_SECRET_KEY) {
    // Local development only (DEV_FAKE_PAYMENTS on plain http): pretend Stripe confirmed the payment.
    const fakeId = 'dev_book_' + purchaseId;
    await db.prepare('UPDATE book_purchases SET stripe_session_id = ? WHERE id = ?').bind(fakeId, purchaseId).run();
    await fulfilBookPurchase(db, fakeId, purchaseId, BOOK_PRICE_CENTS);
    return c.redirect('/course-book');
  }
  const session = await createCheckoutSession(c.env, {
    ref: `book-${purchaseId}`,
    kind: 'book',
    email: user.email,
    amountCents: BOOK_PRICE_CENTS,
    productName: 'USMLE100 Course Book',
    successPath: '/buy/course-book/success',
    cancelPath: '/buy/course-book?cancelled=1',
    siteUrl: (c.env.SITE_URL || new URL(c.req.url).origin).replace(/\/$/, ''),
  });
  await db.prepare('UPDATE book_purchases SET stripe_session_id = ? WHERE id = ?').bind(session.id, purchaseId).run();
  return c.redirect(session.url, 303);
});

// Like enrollments, the webhook is the source of truth; this also asks Stripe directly in case the webhook is slow.
publicRoutes.get('/buy/course-book/success', requireUser, async (c) => {
  const user = c.get('user')!;
  const sid = c.req.query('session_id');
  if (sid && c.env.STRIPE_SECRET_KEY) {
    const own = await c.env.DB.prepare('SELECT id FROM book_purchases WHERE stripe_session_id = ? AND user_id = ?').bind(sid, user.id).first<{ id: number }>();
    const s = own ? await retrieveCheckoutSession(c.env, sid) : null;
    if (s && own && s.client_reference_id === `book-${own.id}`) await fulfil(c.env.DB, s);
  }
  return c.redirect((await hasBook(c.env.DB, user, c.get('enrollment'))) ? '/course-book' : '/buy/course-book?pending=1');
});

// The webhook is the source of truth; this page also checks Stripe directly in case the webhook is slow.
publicRoutes.get('/enroll/success', requireUser, async (c) => {
  const sid = c.req.query('session_id');
  if (sid && c.env.STRIPE_SECRET_KEY) {
    const s = await retrieveCheckoutSession(c.env, sid);
    const enr = await c.env.DB.prepare('SELECT id, user_id FROM enrollments WHERE stripe_session_id = ?').bind(sid).first<{ id: number; user_id: number }>();
    if (s && enr && enr.user_id === c.get('user')!.id && String(enr.id) === s.client_reference_id) await fulfil(c.env.DB, s);
  }
  return c.redirect('/welcome');
});

publicRoutes.post('/stripe/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return c.text('Webhook not configured', 503);
  const payload = await c.req.text();
  const ok = await verifyWebhook(payload, c.req.header('stripe-signature'), c.env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return c.text('Bad signature', 400);
  const event = JSON.parse(payload);
  // Access is given only for a fully paid session. Card payments arrive as checkout.session.completed;
  // delayed methods (bank debits) arrive later as async_payment_succeeded. Each purchase is fulfilled once.
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await fulfil(c.env.DB, event.data.object);
  }
  // Refunds are issued by the owner in the Stripe Dashboard only. A full refund removes that purchase's access.
  if (event.type === 'charge.refunded') {
    console.log('stripe refund', event.data.object?.id, await handleRefund(c.env, event.data.object));
  }
  // Chargebacks suspend the disputed purchase at once; the owner decides on restoring it.
  if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed' || event.type === 'charge.dispute.funds_reinstated') {
    console.log('stripe dispute', event.data.object?.id, await handleDispute(c.env, event.data.object, event.type));
  }
  return c.json({ received: true });
});
