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
      miniflare: { bindings: { ZOOM_WEBHOOK_SECRET: 'test-secret' } },
    }),
  ],
});
