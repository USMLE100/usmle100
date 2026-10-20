import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './lib/types';
import { loadUser, sameOrigin } from './lib/auth';
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
app.use('*', loadUser);
app.use('*', sameOrigin);

app.route('/', publicRoutes);
app.route('/admin', admin);
app.route('/', portal);

app.notFound((c) => c.text('Page not found', 404));
app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong. Please try again.', 500);
});

export default app;
