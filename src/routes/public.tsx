import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { PublicLayout, Flash, Eyebrow } from '../views/layout';
import { createSession, destroySession, hashPassword, verifyPassword, requireUser } from '../lib/auth';
import { activateEnrollment, createCheckoutSession, retrieveCheckoutSession, verifyWebhook } from '../lib/stripe';
import { money } from '../lib/content';

type Pkg = { id: string; name: string; tagline: string; price_cents: number; one_on_one_sessions: number; evening_q_months: number; recommended: number };

// What each package includes. Kept in code so it is versioned with the site.
const INCLUDES: Record<string, string[]> = {
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

const INDIVIDUAL = [
  { name: 'Evening Questions', price: '$160', unit: 'per month', desc: 'Live, instructor-guided USMLE-style question review. Paid month by month.' },
  { name: 'One-on-one tutoring', price: '$50', unit: 'per 60-minute session', desc: 'Personalised tutoring on your own weak areas, question interpretation and clinical reasoning.' },
  { name: 'USMLE100 Course Book', price: '$199', unit: 'one-time', desc: 'A structured companion resource supporting organised review of high-yield concepts.' },
];

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/', (c) => {
  const user = c.get('user');
  return c.html(
    <PublicLayout title="Board prep, taught live by doctors" user={user}>
      <section class="hero">
        <div class="wrap">
          <Eyebrow>USMLE Step 1 · COMLEX · CBSE</Eyebrow>
          <h1>Board prep, taught live by doctors.</h1>
          <p>Join 1,400+ students preparing with USMLE100. A live structured review course, daily question practice and one-on-one help, in one 100-day program.</p>
          <div class="row">
            <a class="btn btn-gold" href="/programs">See programs</a>
            <a class="btn btn-ghost" style="color:#fff;border-color:#5C8A75" href="/sign-up">Create account</a>
          </div>
        </div>
      </section>
    </PublicLayout>,
  );
});

publicRoutes.get('/programs', async (c) => {
  const pkgs = (await c.env.DB.prepare('SELECT * FROM packages ORDER BY sort').all<Pkg>()).results;
  return c.html(
    <PublicLayout title="Programs" user={c.get('user')}>
      <section class="hero">
        <div class="wrap">
          <Eyebrow>Programs</Eyebrow>
          <h1>Find Your Path to USMLE Success</h1>
          <p>Comprehensive medical education, structured exam preparation and personalised academic support, built to help you strengthen clinical reasoning and prepare for your licensing examinations.</p>
        </div>
      </section>
      <main class="wrap page stack">
        <p>
          Every package is a <strong>one-time enrolment price</strong>, not a subscription. Click to know more details about each package.
        </p>
        {pkgs.map((p) => (
          <details class="pkg" data-recommended={p.recommended ? '' : undefined} open={!!p.recommended}>
            <summary>
              <span class="grow">
                <span class="row">
                  <span class="name">{p.name}</span>
                  {p.recommended ? <span class="chip chip-sand">Recommended</span> : null}
                </span>
                <span class="muted small">{p.tagline}</span>
              </span>
              <span class="price">
                {money(p.price_cents)} <span class="muted small">one-time</span>
              </span>
              <span class="plus" aria-hidden="true"></span>
            </summary>
            <div class="body">
              <ul>
                {(INCLUDES[p.id] ?? []).map((i) => (
                  <li>{i}</li>
                ))}
              </ul>
              <form method="post" action={`/enroll/${p.id}`}>
                <button class="btn btn-primary" type="submit">
                  Enroll in {p.name.replace('USMLE100 MedSchool ', '')}
                </button>
              </form>
            </div>
          </details>
        ))}
        <h2 style="margin-top:12px">Need something more specific?</h2>
        <div class="grid">
          {INDIVIDUAL.map((i) => (
            <div class="card">
              <h3>{i.name}</h3>
              <p>
                <strong style="font-size:26px">{i.price}</strong> <span class="muted small">{i.unit}</span>
              </p>
              <p class="muted small">{i.desc}</p>
              <a class="btn btn-outline" href="mailto:info.usmle100@gmail.com?subject=USMLE100%20enquiry">
                Ask about {i.name}
              </a>
            </div>
          ))}
        </div>
      </main>
    </PublicLayout>,
  );
});

// ---------- Accounts ----------

const AuthPage = (p: { mode: 'in' | 'up'; error?: string; email?: string; name?: string; next?: string; user: any }) => (
  <PublicLayout title={p.mode === 'in' ? 'Sign in' : 'Create account'} user={p.user}>
    <main class="wrap">
      <div class="card auth-card">
        <h1>{p.mode === 'in' ? 'Welcome back' : 'Create your account'}</h1>
        <p class="muted">{p.mode === 'in' ? 'Sign in to pick up where you left off.' : 'Create an account, then choose your program to unlock the portal.'}</p>
        {p.error && <Flash kind="error">{p.error}</Flash>}
        <form method="post" class="stack" style="gap:14px">
          {p.next && <input type="hidden" name="next" value={p.next} />}
          {p.mode === 'up' && (
            <label class="field">
              Full name
              <input type="text" name="name" required autocomplete="name" value={p.name ?? ''} />
            </label>
          )}
          <label class="field">
            Email
            <input type="email" name="email" required autocomplete="email" value={p.email ?? ''} />
          </label>
          <label class="field">
            Password
            <input type="password" name="password" required minlength={p.mode === 'up' ? 10 : undefined} autocomplete={p.mode === 'up' ? 'new-password' : 'current-password'} />
          </label>
          {p.mode === 'up' && <span class="muted small">At least 10 characters.</span>}
          <button class="btn btn-primary btn-block" type="submit">
            {p.mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p class="small">
          {p.mode === 'in' ? (
            <>
              New here? <a href="/sign-up">Create an account</a>
            </>
          ) : (
            <>
              Already have an account? <a href="/sign-in">Sign in</a>
            </>
          )}
        </p>
      </div>
    </main>
  </PublicLayout>
);

const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

publicRoutes.get('/sign-up', (c) => c.html(<AuthPage mode="up" user={c.get('user')} />));
publicRoutes.post('/sign-up', async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? '').trim();
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const again = (error: string) => c.html(<AuthPage mode="up" error={error} email={email} name={name} user={null} />, 400);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return again('Please enter your name and a valid email.');
  if (password.length < 10) return again('Your password needs at least 10 characters.');
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return again('An account with that email already exists. Try signing in.');
  const admins = (c.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const role = admins.includes(email) ? 'admin' : 'student';
  const { hash, salt } = await hashPassword(password);
  const r = await c.env.DB.prepare('INSERT INTO users (email, name, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)')
    .bind(email, name, hash, salt, role)
    .run();
  await createSession(c, Number(r.meta.last_row_id));
  return c.redirect(role === 'admin' ? '/dashboard' : '/enroll');
});

publicRoutes.get('/sign-in', (c) => c.html(<AuthPage mode="in" next={c.req.query('next')} user={c.get('user')} />));
publicRoutes.post('/sign-in', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const u = await c.env.DB.prepare('SELECT id, password_hash, password_salt FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; password_hash: string; password_salt: string }>();
  const ok = u ? await verifyPassword(password, u.password_hash, u.password_salt) : (await hashPassword(password), false);
  if (!u || !ok) return c.html(<AuthPage mode="in" error="That email and password don’t match." email={email} user={null} />, 401);
  await createSession(c, u.id);
  return c.redirect(safeNext(f.next));
});

publicRoutes.post('/sign-out', async (c) => {
  await destroySession(c);
  return c.redirect('/');
});

// ---------- Enrollment and payment ----------

publicRoutes.get('/enroll', requireUser, async (c) => {
  if (c.get('enrollment')) return c.redirect('/dashboard');
  const pkgs = (await c.env.DB.prepare('SELECT * FROM packages ORDER BY sort').all<Pkg>()).results;
  return c.html(
    <PublicLayout title="Choose your program" user={c.get('user')}>
      <main class="wrap page stack">
        <h1>Choose your program</h1>
        <p class="muted">Your portal unlocks as soon as payment goes through. Every package is a one-time payment.</p>
        {c.req.query('cancelled') && <Flash kind="error">Payment was cancelled. You have not been charged.</Flash>}
        <div class="grid">
          {pkgs.map((p) => (
            <form method="post" action={`/enroll/${p.id}`} class="card" style={p.recommended ? 'border:2px solid var(--gold)' : ''}>
              {p.recommended ? <span class="chip chip-sand" style="align-self:flex-start">Recommended</span> : null}
              <h2>{p.name}</h2>
              <p class="muted small">{p.tagline}</p>
              <p>
                <strong style="font-size:26px">{money(p.price_cents)}</strong> <span class="muted small">one-time</span>
              </p>
              <button class="btn btn-primary" type="submit">
                Continue to payment
              </button>
            </form>
          ))}
        </div>
        <p class="small muted">
          Not sure which fits? <a href="/programs">Compare what each includes</a>.
        </p>
      </main>
    </PublicLayout>,
  );
});

publicRoutes.post('/enroll/:pkg', requireUser, async (c) => {
  const user = c.get('user')!;
  if (c.get('enrollment')) return c.redirect('/dashboard');
  const pkg = await c.env.DB.prepare('SELECT * FROM packages WHERE id = ?').bind(c.req.param('pkg')).first<Pkg>();
  if (!pkg) return c.text('Not found', 404);
  const ins = await c.env.DB.prepare("INSERT INTO enrollments (user_id, package_id, status) VALUES (?, ?, 'pending')").bind(user.id, pkg.id).run();
  const enrollmentId = Number(ins.meta.last_row_id);

  if (c.env.DEV_FAKE_PAYMENTS === '1' && !c.env.SITE_URL.startsWith('https://')) {
    const fakeId = 'dev_' + enrollmentId;
    await c.env.DB.prepare('UPDATE enrollments SET stripe_session_id = ? WHERE id = ?').bind(fakeId, enrollmentId).run();
    await activateEnrollment(c.env.DB, fakeId, enrollmentId, pkg.price_cents);
    return c.redirect('/dashboard');
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.text('Payments are not set up yet.', 503);

  const session = await createCheckoutSession(c.env, {
    enrollmentId,
    email: user.email,
    name: user.name,
    amountCents: pkg.price_cents,
    productName: pkg.name,
  });
  await c.env.DB.prepare('UPDATE enrollments SET stripe_session_id = ? WHERE id = ?').bind(session.id, enrollmentId).run();
  return c.redirect(session.url, 303);
});

// The webhook is the source of truth; this page also checks Stripe directly in case the webhook is slow.
publicRoutes.get('/enroll/success', requireUser, async (c) => {
  const sid = c.req.query('session_id');
  if (sid && c.env.STRIPE_SECRET_KEY) {
    const s = await retrieveCheckoutSession(c.env, sid);
    const enr = await c.env.DB.prepare('SELECT id, user_id FROM enrollments WHERE stripe_session_id = ?').bind(sid).first<{ id: number; user_id: number }>();
    if (s && enr && enr.user_id === c.get('user')!.id && s.payment_status === 'paid' && String(enr.id) === s.client_reference_id) {
      await activateEnrollment(c.env.DB, sid, enr.id, s.amount_total);
    }
  }
  return c.redirect('/dashboard');
});

publicRoutes.post('/stripe/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return c.text('Webhook not configured', 503);
  const payload = await c.req.text();
  const ok = await verifyWebhook(payload, c.req.header('stripe-signature'), c.env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return c.text('Bad signature', 400);
  const event = JSON.parse(payload);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.client_reference_id) {
      await activateEnrollment(c.env.DB, s.id, Number(s.client_reference_id), s.amount_total);
    }
  }
  return c.json({ received: true });
});
