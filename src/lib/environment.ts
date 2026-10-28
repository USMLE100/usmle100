/**
 * Production vs preview safety.
 *
 * wrangler.toml sets ENVIRONMENT = "production" for the live Worker and "preview" under [previews.vars]
 * for Cloudflare Worker Previews (branch builds). Anything that is not exactly "production" is treated as a
 * test environment and is fenced off from live money and live services here, even if someone copies a
 * production secret into the preview settings by mistake:
 *
 *  - Stripe: only test-mode keys (sk_test_ / rk_test_) are kept. A live key is dropped, so payments show
 *    "not set up" instead of charging a real card.
 *  - Bunny: the API key (which can add, rename and change videos) is dropped when it points at the live
 *    video library. Playback signing still works.
 *  - Zoom (unless PREVIEW_ALLOW_ZOOM = "1") and the marketing-list sync (Sender) are switched off: both act on
 *    the business's real accounts.
 *  - The database must be a development database (see checkDatabase): a preview refuses to run against a
 *    database that is marked as production or already holds accounts it did not create.
 */
import type { Env } from './types';

/** The live Bunny video library (wrangler.toml [vars]). A preview may read from it but never write to it. */
export const LIVE_BUNNY_LIBRARY_ID = '785730';

export const isProduction = (env: Pick<Env, 'ENVIRONMENT'>) => env.ENVIRONMENT === 'production';

export function safeEnv(env: Env): Env {
  if (isProduction(env)) return env;
  const out: Env = { ...env };
  if (out.STRIPE_SECRET_KEY && !/^(sk|rk)_test_/.test(out.STRIPE_SECRET_KEY)) {
    console.warn('Preview: ignoring a Stripe key that is not a test-mode key.');
    delete out.STRIPE_SECRET_KEY;
    delete out.STRIPE_WEBHOOK_SECRET;
  }
  if (out.BUNNY_API_KEY && (out.BUNNY_LIBRARY_ID ?? '') === LIVE_BUNNY_LIBRARY_ID) delete out.BUNNY_API_KEY;
  // Zoom acts on the business's real Zoom account. Off on previews unless the owner opts in
  // (PREVIEW_ALLOW_ZOOM = "1" under [previews.vars]) to test the recording-approval flow with a staging Zoom app.
  if (out.PREVIEW_ALLOW_ZOOM !== '1') {
    delete out.ZOOM_ACCOUNT_ID;
    delete out.ZOOM_CLIENT_ID;
    delete out.ZOOM_CLIENT_SECRET;
    delete out.ZOOM_WEBHOOK_SECRET;
  }
  delete out.SENDER_API_KEY;
  return out;
}

let checked: string | null | undefined; // once per Worker instance; null = fine

const tableExists = async (db: D1Database, name: string) =>
  !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());

/**
 * Runs BEFORE migrations, so a preview that has been pointed at the live database stops before it changes anything.
 * The live Worker marks its database as production; a preview only runs on a database marked as development,
 * or on a brand-new empty one (which it then marks as development). Returns a reason to refuse, or null.
 */
export async function checkDatabase(env: Env): Promise<string | null> {
  if (checked !== undefined) return checked;
  if (isProduction(env)) return (checked = null);
  const db = env.DB;
  const mark = (await tableExists(db, 'settings'))
    ? (await db.prepare("SELECT value FROM settings WHERE key = 'db_environment'").first<{ value: string }>())?.value
    : undefined;
  if (mark === 'development') return (checked = null);
  if (mark === 'production') return (checked = 'This preview is connected to the production database, so it has been stopped. Bind previews to the development database.');
  const users = (await tableExists(db, 'users')) ? ((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0) : 0;
  if (users > 0) return (checked = 'This preview’s database already holds accounts and is not marked as a development database, so it has been stopped.');
  return (checked = null);
}

let marked = false;
/** Runs after migrations: records which kind of database this is. */
export async function markDatabase(env: Env) {
  if (marked) return;
  const db = env.DB;
  if (isProduction(env)) await db.prepare("INSERT INTO settings (key, value) VALUES ('db_environment', 'production') ON CONFLICT (key) DO UPDATE SET value = 'production'").run();
  else await db.prepare("INSERT INTO settings (key, value) VALUES ('db_environment', 'development') ON CONFLICT (key) DO NOTHING").run();
  marked = true;
}

/** For tests only. */
export const _resetDatabaseCheck = () => {
  checked = undefined;
  marked = false;
};
