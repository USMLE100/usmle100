import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // The Worker imports its migration files as text (see [[rules]] in wrangler.toml); do the same under Vite.
    {
      name: 'sql-as-text',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (id.endsWith('.sql')) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { ZOOM_WEBHOOK_SECRET: 'test-secret', STRIPE_SECRET_KEY: 'sk_test_not_real', STRIPE_WEBHOOK_SECRET: 'whsec_test_not_real', BUNNY_API_KEY: 'bunny_test_not_real', BUNNY_TOKEN_KEY: 'bunny_token_test' } },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
