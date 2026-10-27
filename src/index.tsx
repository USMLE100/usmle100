import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Env } from './lib/types';
import { syncImports } from './lib/zoom';
import { syncDurations } from './lib/catalog';
import { pruneLoginAttempts } from './lib/ratelimit';
import { pruneResetTokens } from './lib/reset';
import { zoom } from './routes/zoom';
import { loadUser, sameOrigin } from './lib/auth';
import { loadShell } from './lib/shell';
import { ensureMigrated } from './lib/migrate';
import { publicRoutes } from './routes/public';
import { portal } from './routes/portal';
import { admin } from './routes/admin';
import { learn } from './routes/learn';
import { content } from './routes/content';
import { library } from './routes/library';
import { community } from './routes/community';
import { account } from './routes/account';
import { play } from './routes/play';
import { webinars, webinarAdmin } from './routes/webinars';
import { security } from './routes/security';
import { freeAdmin } from './routes/freeAdmin';
import { studentsAdmin } from './routes/students';
import { accountGate } from './lib/gate';
import { pruneAudit } from './lib/audit';
import { emailStaffAlerts, retryNotices, syncMarketing } from './lib/messaging';
import { PublicLayout } from './views/layout';

const app = new Hono<AppEnv>();

app.use(
  '*',
  secureHeaders({
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
      frameSrc: ['https://iframe.mediadelivery.net', 'https://challenges.cloudflare.com'],
      connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
      workerSrc: ["'self'", 'blob:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      formAction: ["'self'", 'https://checkout.stripe.com'],
    },
  }),
);
app.use('*', async (c, next) => {
  await ensureMigrated(c.env.DB);
  await next();
});
app.use('*', loadUser);
app.use('*', sameOrigin);
// Top-bar and menu data (study streak, lecture progress) for signed-in page views.
app.use('*', async (c, next) => {
  const user = c.get('user');
  if (user && c.req.method === 'GET') c.set('shell', await loadShell(c.env.DB, user.id, c.get('enrollment')?.cohort_id ?? null));
  await next();
});

// Suspension, emergency lockdown, warnings and the student agreement (lib/gate).
app.use('*', accountGate);

app.route('/', publicRoutes);
app.route('/', account);
app.route('/zoom', zoom);
app.route('/admin', security);
app.route('/admin', freeAdmin);
app.route('/admin', studentsAdmin);
app.route('/admin', webinarAdmin);
app.route('/admin', admin);
app.route('/admin', content);
app.route('/', play);
app.route('/', webinars);
app.route('/', portal);
app.route('/', learn);
app.route('/', library);
app.route('/', community);

app.notFound((c) =>
  c.html(
    <PublicLayout title="Page not found" user={c.get('user') ?? null}>
      <main class="wrap page" style="text-align:center;padding-top:72px;padding-bottom:96px">
        <div class="eyebrow">404</div>
        <h1 style="margin:10px 0 12px">We can’t find that page</h1>
        <p class="muted" style="margin-bottom:22px">The link may be old or mistyped.</p>
        <a class="btn btn-primary" href={c.get('user') ? '/dashboard' : '/'}>{c.get('user') ? 'Back to the portal' : 'Go to the home page'}</a>
      </main>
    </PublicLayout>,
    404,
  ),
);
app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong. Please try again.', 500);
});

export default {
  fetch: app.fetch,
  /** Every few minutes: link Zoom recordings that Bunny has copied and put finished ones live. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      ensureMigrated(env.DB).then(() => Promise.all([syncImports(env).then(() => syncDurations(env)), pruneLoginAttempts(env.DB), pruneResetTokens(env.DB), pruneAudit(env.DB), retryNotices(env).catch(console.error), emailStaffAlerts(env).catch(console.error), syncMarketing(env).catch(console.error)])),
    );
  },
};
