import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Env } from './lib/types';
import { syncImports } from './lib/zoom';
import { pruneLoginAttempts } from './lib/ratelimit';
import { pruneResetTokens } from './lib/reset';
import { zoom } from './routes/zoom';
import { loadUser, sameOrigin } from './lib/auth';
import { loadShell } from './lib/shell';
import { ensureMigrated } from './lib/migrate';
import { publicRoutes } from './routes/public';
import { portal } from './routes/portal';
import { admin } from './routes/admin';

const app = new Hono<AppEnv>();

app.use(
  '*',
  secureHeaders({
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ['https://iframe.mediadelivery.net'],
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

app.route('/', publicRoutes);
app.route('/zoom', zoom);
app.route('/admin', admin);
app.route('/', portal);

app.notFound((c) => c.text('Page not found', 404));
app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong. Please try again.', 500);
});

export default {
  fetch: app.fetch,
  /** Every few minutes: link Zoom recordings that Bunny has copied and put finished ones live. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      ensureMigrated(env.DB).then(() => Promise.all([syncImports(env), pruneLoginAttempts(env.DB), pruneResetTokens(env.DB)])),
    );
  },
};
