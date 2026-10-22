# USMLE100

Student portal and public site for USMLE100: sign-up, one-time payments (Stripe), lecture videos (Bunny Stream), a faculty-written question bank, and performance tracking by Dr. Khan's systems and disciplines.

Runs on **Cloudflare Workers** with a **D1** database. Server-rendered with [Hono](https://hono.dev).

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
| `ADMIN_EMAILS` | Set in `wrangler.toml`: emails that become admins when they sign up |

`SITE_URL` (optional, in `wrangler.toml`) fixes the public address used in Stripe links; otherwise it is taken from each request.

## Deploys

The `USMLE100/usmle100` repository is connected to Cloudflare Workers Builds: every push to `main` deploys automatically (deploy command `npm run deploy`).

Database tables are created by the Worker itself on its first request (`src/lib/migrate.ts`), so deploys need no database permissions. To change the schema, add a new file in `migrations/` and append it to the list in `src/lib/migrate.ts`.

## Local development

```sh
npm install
printf 'ADMIN_EMAILS=you@example.com\nDEV_FAKE_PAYMENTS=1\n' > .dev.vars
npm run dev
```

`DEV_FAKE_PAYMENTS=1` skips Stripe locally; it is ignored on any `https://` site.

## Question spreadsheet

Admin → Questions → Import has a downloadable template. Columns: `stem, choice_a … choice_h, correct (letter), explanation, bottom_line, subject, system, discipline, perf_system, lecture_day`. Imports are all-or-nothing and land as drafts for faculty approval.

## Automatic Zoom import

A Zoom app sends `recording.completed` to `/zoom/webhook`. The site picks the screen-share MP4, attaches it to the
program day it was recorded on (creating the lecture if needed) and asks Bunny to fetch it straight from Zoom.
A cron job every 5 minutes (and each visit to Admin → Lectures) saves the Bunny video ID on the lecture and puts it
live once Bunny has finished encoding. Only meetings listed under "Class Zoom meeting ID(s)" go live on their own;
recordings from other meetings are ignored, and with no IDs listed everything imports but waits for an admin.
