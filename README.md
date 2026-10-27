# USMLE100

Student portal and public site for USMLE100: sign-up, one-time payments (Stripe), lecture videos (Bunny Stream), a faculty-written question bank, and performance tracking by Dr. Khan's systems and disciplines.

Runs on **Cloudflare Workers** with a **D1** database. Server-rendered with [Hono](https://hono.dev).

**Start here:** [`LAUNCH.md`](LAUNCH.md) (owner setup steps), [`HANDOVER.md`](HANDOVER.md) (architecture, deploy, rollback, backups, operations) and [`REQUIREMENTS.md`](REQUIREMENTS.md) (every requirement with its status and tests). The list below is the original overview.

## What's built

- **Accounts**: sign up, sign in, sign out. Passwords hashed with PBKDF2; sessions in D1.
- **Pay before entry**: students choose a package and pay through Stripe Checkout; the portal unlocks when Stripe confirms payment (webhook, plus a check on return).
- **Dashboard**: 100-day calendar (90 lecture days + 10-day exam window), today's lecture, catch-up counts.
- **Lectures**: Bunny Stream player with expiring signed links and the student's email as a watermark; mark as watched.
- **Create a test**: Unused / Incorrect / Omitted / Correct / Custom (flagged) pools, 13 subjects, 26 systems, Tutor / Timed / Untimed.
- **Test runner and results**: explanations, wrong-answer explanations, bottom line, flags, review.
- **Performance**: by Dr. Khan's 8 systems and 10 disciplines, in his order, from the student's real answers.
- **Exam window**: checklist, group practice test, weakest areas.
- **Admin**: create a cohort, add lectures as Day 1, Day 2… with dates; write, edit, import (CSV) and approve questions (only approved questions reach students); Site settings for package prices, student count, contact email, Calendly link and the group practice test.

## Accounts and secrets

Set these with `npx wrangler secret put NAME` (never commit them):

| Name | What |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` while testing) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook pointing at `/stripe/webhook` (event `checkout.session.completed`) |
| `BUNNY_LIBRARY_ID` | Set in `wrangler.toml` (not secret) |
| `BUNNY_TOKEN_KEY` | Bunny Stream library's token authentication key |
| `BUNNY_API_KEY` | Bunny Stream library's API key (lets the site ask Bunny to copy Zoom recordings) |
| `ZOOM_WEBHOOK_SECRET` | Secret Token from the Zoom app's event subscription |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Optional: Zoom Server-to-Server OAuth credentials, used only if Zoom sends no download token |

`SITE_URL` (optional, in `wrangler.toml`) fixes the public address used in Stripe links; otherwise it is taken from each request.

## Deploys

The `USMLE100/usmle100` repository is connected to Cloudflare Workers Builds: every push to `main` deploys automatically (deploy command `npm run deploy`).

Database tables are created by the Worker itself on its first request (`src/lib/migrate.ts`), so deploys need no database permissions. To change the schema, add a new file in `migrations/` and append it to the list in `src/lib/migrate.ts`.

## Local development

```sh
npm install
printf 'DEV_FAKE_PAYMENTS=1\n' > .dev.vars
npm run dev
```

## Roles

Public sign-up always creates a **student**. An admin gives faculty or admin roles in **Admin → Team**
(the last admin cannot be removed). Faculty may only use the admin pages listed in `FACULTY_ALLOWED`
(`src/lib/auth.ts`): questions, lectures and Evening Questions recordings. Everything else in `/admin` is admin-only.

### First admin, or recovering admin access

Only needed on a new database, or if every admin account is lost or compromised. It must be done by someone who
controls the Cloudflare account (protect that account with two-factor sign-in). Run the SQL below in
**Cloudflare → Storage & Databases → D1 → usmle100 → Console** (no API token needed), or with
`npx wrangler d1 execute usmle100 --remote --command "…"`.

Email addresses are **not verified** when people sign up, so an email alone does not prove who owns an account.
Always confirm the person and grant access by the account's unique **user ID**:

1. **Confirm the person.** Only promote the business owner, or someone the owner confirms directly (in person or
   on a phone call to a number you already know). Never act on a request that arrives only by email or chat.
2. **They sign in now.** While you are on the call, the person creates an account (or uses their existing one) and
   signs in on the live site with their own password.
3. **Find the account (read-only).**
   ```sql
   SELECT id, email, name, role, created_at FROM users WHERE email = 'owner@example.com';
   ```
   There must be exactly one row, with the right name and email. For a new account, `created_at` (UTC) must match
   when they just signed up. Write down the `id`.
4. **Check they just signed in (read-only).** Use the `id` from step 3:
   ```sql
   SELECT user_id, expires_at FROM sessions WHERE user_id = 123 ORDER BY expires_at DESC LIMIT 1;
   ```
   `expires_at` must be about 30 days from now (sessions last 30 days), which shows the sign-in in step 2 was
   this account. If not, stop.
5. **Grant admin by user ID.** Both the `id` and the email must match, so a typo changes nothing:
   ```sql
   UPDATE users SET role = 'admin' WHERE id = 123 AND email = 'owner@example.com';
   ```
   It must report exactly **1** row changed. Never run an `UPDATE` on `users` without `WHERE id = …`.
6. **Check the result (read-only).**
   ```sql
   SELECT id, email, role FROM users WHERE role IN ('admin', 'faculty');
   ```
   After that, give any other roles from **Admin → Team**.
7. **After a suspected break-in**, also remove every admin or faculty account you do not recognise, by ID, and
   sign it out; then change the Cloudflare and site passwords:
   ```sql
   UPDATE users SET role = 'student' WHERE id = 456;
   DELETE FROM sessions WHERE user_id = 456;
   ```

With `wrangler`, `--remote` is required; without it the command only changes a local copy of the database.

## Sign-in protection and password resets

- **Lockout:** 5 wrong passwords for one email within 15 minutes locks that email for 15 minutes; 20 wrong passwords
  from one network address (any emails) locks that address for 15 minutes. Counters live in `login_attempts`.
- **Password reset:** an admin makes a one-time link in **Admin → Students → Password reset link** and sends it to
  the student. It works once, for 1 hour; making a new link cancels the old one; using it signs the account out
  everywhere else. Only a SHA-256 hash of the link's secret is stored (`password_resets`).
- **Videos:** the site never shows an unsigned Bunny player link. If `BUNNY_TOKEN_KEY` is missing, videos do not play.

## Tests

`npm test` runs the security tests in `test/` inside the Workers runtime with a fresh local database.

`DEV_FAKE_PAYMENTS=1` skips Stripe locally; it is ignored on any `https://` site.

## Question spreadsheet

Admin → Questions → Import has a downloadable template. Columns: `stem, choice_a … choice_h, correct (letter), explanation, bottom_line, subject, system, discipline, perf_system, lecture_day`. Imports are all-or-nothing and land as drafts for faculty approval.

## Automatic Zoom import

A Zoom app sends `recording.completed` to `/zoom/webhook`. The site picks the screen-share MP4, attaches it to the
program day it was recorded on (creating the lecture if needed) and asks Bunny to fetch it straight from Zoom.
A cron job every 5 minutes (and each visit to Admin → Lectures) saves the Bunny video ID on the lecture and puts it
live once Bunny has finished encoding. Only meetings listed under "Class Zoom meeting ID(s)" go live on their own;
recordings from other meetings are ignored, and with no IDs listed everything imports but waits for an admin.
