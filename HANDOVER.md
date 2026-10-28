# USMLE100 — handover

This is everything a replacement developer needs to run, change, deploy and recover the site without the original author. For the owner's one-time setup steps, see `LAUNCH.md`. For what each requirement maps to, see `REQUIREMENTS.md`.

## Architecture

- **One Cloudflare Worker** (`src/index.tsx`) serves the public site, the student portal and the admin area.
  - It is server-rendered HTML with Hono 4 JSX. There is no front-end build step.
  - Small inline scripts handle the player, the session timer, passkeys and the Course Book reader.
- **One D1 database** (binding `DB`) holds everything: users, payments, progress, uploaded PDFs (stored in chunks), the audit log and settings.
- **External services:**
  - Stripe Checkout (payments, through webhooks).
  - Bunny Stream (video, with signed embed links).
  - Zoom (recordings, through the `recording.completed` webhook).
  - Optional, switched off until keys are added: Resend (email), Twilio (SMS), Sender (marketing) and Cloudflare Turnstile (bot check).
- **Static files** in `public/`: the stylesheet and the self-hosted pdf.js legacy build in `public/vendor/pdfjs-5.7.284-legacy`.
- **Schedule:** a cron runs every 5 minutes (`scheduled()` in `src/index.tsx`). It:
  - imports Zoom recordings and fills in lecture lengths;
  - prunes old login attempts, reset tokens, sessions and audit entries older than 24 months;
  - retries email and SMS, and emails staff alerts to the owner;
  - syncs marketing opt-ins and escalates overdue appeals and disputes.

### Request pipeline

Every request passes through these steps, in this order (see `src/index.tsx`):

1. Security headers and CSP.
2. `ensureMigrated`: runs pending migrations.
3. `loadUser`: loads the session and ends it after 30 idle minutes or 24 hours.
4. `sameOrigin`: blocks cross-site POSTs.
5. The shell data for the top bar.
6. `accountGate`, in this order:
   - the staff passkey step and mandatory passkey setup;
   - the risk check;
   - suspension;
   - lockdown;
   - warning;
   - the agreement.
7. The routers, mounted in this order: `publicRoutes`, `account`, `zoom`, then the `/admin` routers (`security`, `freeAdmin`, `casesAdmin`, `studentsAdmin`, `webinarAdmin`, `admin`, `content`), then `passkeyRoutes`, `casesStudent`, `play`, `webinars`, `portal`, `learn`, `library`, `community`.
   - **Order matters:** `portal.use('*')` requires an enrollment for every router mounted after it.

### Permissions

These rules live in `src/lib/auth.ts`:

- **Students:** portal only.
- **Faculty:** only the admin paths listed in `FACULTY_ALLOWED` (deny by default).
- **Admins:** all admin pages.
- **Owner:** everything in `OWNER_ONLY`, after a fresh passkey confirmation.
- Every staff POST is written to the hash-chained audit log (`src/lib/audit.ts`).

### Code map (`src/`)

| Area | Files |
|---|---|
| Sign-in, sessions, roles, owner-only list | `lib/auth.ts`, `lib/gate.ts`, `lib/passwords.ts`, `lib/ratelimit.ts`, `lib/risk.ts`, `lib/devices.ts`, `lib/passkeys.ts`, `routes/passkeys.tsx`, `routes/account.tsx` |
| Payments | `lib/stripe.ts` (checkout, webhooks, refunds, disputes), `lib/enrolling.ts` (cohort choice), `routes/public.tsx` |
| Video viewing rules and player | `lib/viewing.ts`, `routes/play.tsx`, `views/player.tsx`, `routes/freeAdmin.tsx` |
| Lectures, Topics, Workbench, Path | `routes/learn.tsx`, `lib/catalog.ts`, `lib/content.ts` |
| Course Book reader | `routes/library.tsx`, `views/reader.tsx`, `lib/files.ts` |
| Qbank, Evening Questions, dashboard | `routes/portal.tsx`, `lib/qbank.ts`, `lib/evening.ts` |
| Community, rewards, onboarding | `routes/community.tsx`, `lib/rewards.ts`, `lib/activity.ts` |
| Zoom import and recording approval | `lib/zoom.ts`, `routes/admin.tsx` |
| Admin: security, agreement, views, requests, alerts | `routes/security.tsx` |
| Admin: students directory and CSV | `routes/students.tsx` |
| Appeals and disputes | `lib/cases.ts`, `routes/cases.tsx` |
| Webinars | `routes/webinars.tsx` |
| Email, SMS, codes, notices, Sender | `lib/messaging.ts` |
| Anti-scraping | `lib/abuse.ts` |

## Dependency inventory

Exact versions are pinned in `package-lock.json`.

- **Runtime:** `hono` 4 and `@simplewebauthn/server` 13.1.1 (pure JavaScript).
- **Development:**
  - `wrangler` 4;
  - `vitest` 4 with `@cloudflare/vitest-plugin` (the tests run inside workerd);
  - `typescript` 5;
  - `@cloudflare/workers-types`.
- **Self-hosted static files:** pdf.js 5.7.284 legacy build (Apache-2.0, licence included).
- Icons are inline SVG (Material Symbols, Apache-2.0).

## Build, test, run

```
npm ci                 # Node 22
npm run typecheck      # tsc --noEmit
npm test               # 13 files, 128 tests, all external services simulated
npx wrangler dev       # local site; add .dev.vars with DEV_FAKE_PAYMENTS=1 to try enrolling without Stripe
```

- `.dev.vars` is git-ignored. Never put real keys in it.
- In tests, `test/setup.ts` turns off the staff passkey requirement, because most tests create staff directly. `test/passkeys.test.ts` turns it back on.

## Database migrations

- Migrations are SQL files in `migrations/`, applied in order by the Worker itself on its first request (`src/lib/migrate.ts`, which records them in the `_migrations` table).
- **To add one:**
  1. Create `migrations/00NN_name.sql`. Statements are split on `;` followed by a newline.
  2. Import it in `migrate.ts` and append it to the list.
- **Rules:**
  - Only add tables and columns.
  - Never edit a migration that has reached production.
  - Test it with `npm test`, which builds a fresh database.
- Production is on **0013**. Deploying this branch applies **0014–0022** automatically.
  - They only add tables and columns, plus small `UPDATE`s: the first admin becomes the owner, and existing sessions get timestamps.

## Deploy and rollback

- **Deploy:** the GitHub repository is connected to Cloudflare Workers Builds. Pushing to `main` builds and deploys in about a minute. Merge `v12-frontend` into `main` only with the owner's approval.
- **Before the first deploy of this branch:**
  1. Note the time: `date +%s` gives the Unix timestamp to restore to.
  2. In Cloudflare, check that `DEV_FAKE_PAYMENTS` is **not** set.
- **Code rollback:** revert the merge commit on `main` and push, or use Cloudflare → Workers → usmle100 → Deployments → roll back to the previous version.
  - The database migrations stay. They are additive, so the old code keeps working with the extra tables.
- **Database rollback:** use D1 Time Travel, below.

## Backups and restore

- **D1 Time Travel** is always on and free. It can restore the database to any minute within the last **7 days** (Workers Free) or **30 days** (Workers Paid).
  - Restoring overwrites the database in place and prints a bookmark that undoes the restore:
    ```
    npx wrangler d1 time-travel info usmle100                          # current bookmark
    npx wrangler d1 time-travel restore usmle100 --timestamp=<unix seconds>
    ```
  - This meets the owner's targets: at most 1 hour of data lost, and restored within 12 hours.
- **Separate, access-isolated copy** (owner decision Q5): needs the owner's approval, because R2 may cost money. The suggested plan:
  1. A nightly `npx wrangler d1 export usmle100 --remote --output=backup.sql`, run from a scheduled GitHub Action or a Cloudflare Workflow.
  2. Store it in an R2 bucket that only the owner can reach.
  3. Keep 30 days of copies.
- **After any restore, before reopening:**
  1. Turn the emergency lockdown on.
  2. Reconcile payments in Admin → Payments (it compares with Stripe).
  3. Check the latest Stripe events against enrollments and Course Book purchases.
  4. Check lecture-view records for activity after the restore point. Students may need views restored through Admin → Lecture views.
  5. Turn the lockdown off.
- **Exports need two files.** A plain `wrangler d1 export` **cannot be replayed as is**. Found in the 28 Oct drill: `no such table: main.sections`. Some tables gained a column that points at a table created later, so the rows arrive before that table exists. Always export schema and data separately and build a restore file:
  ```
  npx wrangler d1 export <db> --remote --no-data   --output schema.sql
  npx wrangler d1 export <db> --remote --no-schema --output data.sql
  node scripts/make-restore-file.mjs schema.sql data.sql restore.sql
  npx wrangler d1 execute <new empty db> --remote --file restore.sql
  ```
  Any nightly export job (above) must save both files.
- **Proving a restore:** `node scripts/db-fingerprint.mjs <db> --local|--remote --out x.json` records every table's row count and SHA-256, plus the payment, enrollment, refund, dispute and lecture-view figures. Then `node scripts/db-fingerprint.mjs --compare before.json after.json` must print IDENTICAL. It is read-only and refuses to read the production database remotely.
- **Drill, 28 Oct 2026** (local D1 in Wrangler 4.151.3; disposable test data):
  - data: 74 tables, 11 users, 7 enrollments (1 refunded), 2 Course Book purchases, 1 refund, 1 dispute, 13 lecture-progress rows and 3 lecture-view sessions;
  - export took 4.6 s;
  - the plain export failed to replay; the two-file restore succeeded (476 statements, 3.7 s);
  - fingerprints: IDENTICAL across all 74 tables and all reconciliation figures;
  - counters correct, no foreign-key errors;
  - the site served `/` and `/sign-in` from the restored copy.
- **Not yet verified** (needs Cloudflare access; run on `usmle100-dev` once staging exists):
  - a remote export/restore;
  - a D1 Time Travel restore. The steps: fingerprint, write test rows, `time-travel restore usmle100-dev --timestamp=<before>`, fingerprint again and compare.
  - Remote timings will be longer than local ones. The 12-hour RTO and 1-hour RPO rest on Time Travel's documented per-minute restore, which has not yet been timed here.
- **Restore test:** about every 3 months, run the two-file restore into a scratch database (`wrangler d1 create usmle100-restore-test`) and compare fingerprints. Never restore into `usmle100` except as a deliberate rollback.

## Staging (Worker Previews)

- **What runs there:** branch builds run `npx wrangler preview`, which creates the Preview `v12-frontend`.
  - Its settings come only from `[previews.vars]` and `[[previews.d1_databases]]` in `wrangler.toml`, plus Preview secrets.
  - Its database is `usmle100-dev`.
  - No crons, routes or custom domains run on it.
- **The guards** are in `src/lib/environment.ts` (see LAUNCH.md §0):
  - `safeEnv` removes live Stripe keys, Zoom, Sender and live-library Bunny write keys.
  - `checkDatabase` runs before migrations and refuses a production or unknown non-empty database.
  - `markDatabase` marks the live database "production" and new staging databases "development".
- **Tests and checks:**
  - `test/environment.test.ts` (11 tests);
  - a local simulation with `wrangler dev --var ENVIRONMENT:preview`: an old production-like copy answered 503 and was left untouched (25 tables before and after, no migrations applied); an empty database answered 200, was migrated to 75 tables and marked development.
- **Setup:** `scripts/setup-staging.sh`. The owner runs it once after `npx wrangler login`.
- Never change the branch build command to `wrangler versions upload`: that uploads a version of the production Worker with production bindings.

## Secrets and accounts

All keys are **Cloudflare Secrets**, set under Workers → usmle100 → Settings → Variables. None are in the repository.

| Name | What | Needed for |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API key and webhook signing secret | Payments |
| `BUNNY_TOKEN_KEY`, `BUNNY_API_KEY` (`BUNNY_LIBRARY_ID` is in `wrangler.toml`) | Bunny token key and API key | Video, Zoom copy |
| `ZOOM_WEBHOOK_SECRET` (optional: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`) | Zoom app | Recording import |
| `RESEND_API_KEY`, `EMAIL_FROM`, `OWNER_ALERT_EMAIL` | Email | Codes, notices, owner alerts |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS (costs money: owner approval) | Phone codes, critical alerts |
| `SENDER_API_KEY` | Sender | Marketing sync of verified opt-ins |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Cloudflare Turnstile (free) | Sign-up bot check |
| `SITE_URL` (variable) | e.g. `https://usmle100.com` | Links in emails and Stripe; passkeys |

**Accounts the owner must hold**, with 2-factor sign-in on each: Cloudflare (hosting, database, domain), GitHub (code), Stripe, Bunny, Zoom, and Resend, Twilio and Sender if used.

- Developers get their own limited access (a GitHub collaborator; a Cloudflare member with a restricted role), never the owner's login.
- Remove that access when the work ends.
- Production database access for a developer should be time-limited and approved by the owner. Owner-only actions stay owner-only in the app.

**Passkeys:**
- After deploy, the owner's first sign-in asks them to add a passkey (Face ID / Touch ID) and shows 10 recovery codes. Store them somewhere safe.
- If every passkey and every code is lost, someone with Cloudflare access can remove the owner's passkeys in the D1 console:
  ```
  DELETE FROM passkeys WHERE user_id = <id>;
  DELETE FROM recovery_codes WHERE user_id = <id>;
  ```
  The next sign-in then asks for a new passkey.

## Day-to-day operations (where things are)

| Task | Where |
|---|---|
| Approve a Zoom recording for its lecture day | Admin → Requests & alerts / Lectures |
| Choose and publish free lectures | Admin → Free lectures (publishing is owner-only) |
| Unlock an account after 5 wrong passwords | Admin → Security → Locked accounts |
| Approve a replacement device, or an email/phone change | Admin → Requests & alerts |
| Warn or suspend; reinstate (owner) | Admin → Security |
| Extra lecture views (owner) | Admin → Lecture views |
| Appeals and view disputes | Admin → Appeals and disputes (an admin reviews; the owner decides) |
| Give a program, Course Book or Evening months (owner) | Admin → Students / Course Book / Evening Questions |
| Data copy or deletion requests (owner completes) | Admin → Requests & alerts |
| Emergency lockdown (owner) | Admin → Security |
| Check payments against Stripe | Admin → Payments |
| Publish or update the student agreement (owner, after attorney review) | Admin → Student agreement |

## Known limitations

- **Screen recording and phone cameras:** these can't be stopped in a browser. Watermarks on video (an overlay) and on Course Book pages (drawn into the page image), the agreement and the audit log are the deterrents and the evidence.
- **The video watermark is a page overlay**, removable with developer tools; the player stops if it's tampered with. Bunny's own watermarking or DRM would burn it in, at a cost.
- **iPhone native full screen** shows Bunny's video without our overlay. Our own full-screen button keeps the watermark where the browser allows element full screen (iPad, desktop, Android).
- **Progress tracking runs in the browser.** A modified browser could under-report viewing. The 24-hour window and the one-tab rule still apply, and the 2× speed cap stops over-reporting.
- **Large Course Book PDFs** are stored in D1. Its free-plan size limit (about 500 MB in total) may need Workers Paid or R2 later.
- **Course access ends on a date**, not a time. Compensation for wrongful blocks rounds part days up, in the student's favour.
