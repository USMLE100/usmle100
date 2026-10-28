# USMLE100 launch checklist

Each step below needs a real account, key or domain, so it is done by the owner in a dashboard. The code for every step is already in place on the `v12-frontend` branch.
Never paste keys into chat, email or GitHub. In Cloudflare, always add keys as type **Secret**.

## 0. Staging first (isolated Preview for `v12-frontend`)

All real-service testing happens on an isolated staging **Preview**, never on the live Worker. Previews are Cloudflare's per-branch copies of the Worker. They get **only** the settings in the `[previews…]` part of `wrangler.toml` plus Preview secrets, never the production database, secrets, crons or domain.

**Built-in safety** (`src/lib/environment.ts`, tested in `test/environment.test.ts`). These hold even if a production key is copied into Preview settings by mistake:
- The live Worker has `ENVIRONMENT = "production"`; Previews have `"preview"`.
- **Database:** a Preview refuses to start, **before running any migration**, if its database is marked production or already holds accounts it didn't create. It answers 503 and changes nothing. A brand-new database is marked "development" on first visit.
- **Stripe:** only test keys (`sk_test_`/`rk_test_`) work. A live key is ignored, so payments show "not set up" and no real card can be charged.
- **Zoom and Sender** (marketing sync) are off on Previews. Zoom can be opted in later with `PREVIEW_ALLOW_ZOOM = "1"`, only with your approval.
- **Bunny:** the Bunny API key is ignored if it points at the live library (785730). Staging uses its own library.
- Previews have no crons and send `X-Robots-Tag: noindex`.

**Status (28 Oct):**
- Preview builds are **off**.
- The staging database `usmle100-dev` exists and is bound for Previews, verified by `npm run check:staging`.
- Remaining before turning previews on: the staging secrets (at least the Stripe **test** key) in Settings → Variables and secrets → **Previews Base**. You can add them from a phone.

**What you do, once (about 15 minutes):**
1. On your computer, in the repository on branch `v12-frontend`:
   - run `npx wrangler login`;
   - then run `bash scripts/setup-staging.sh`.

   It creates the empty `usmle100-dev` database and writes its id into `wrangler.toml`. It then asks for test credentials. What you type is hidden and never saved to disk or git. Press Enter to skip any of them:
   - **Stripe test** secret key, `sk_test_…`. A live key is refused.
   - **Stripe test** webhook secret. You can add it in step 3.
   - **Bunny staging library**: its id, token key and API key. Create a separate library in Bunny first. This needs your OK because Bunny bills storage and bandwidth.
   - **Resend** key and test sender.

   It then creates the Preview `v12-frontend`, prints its URL and runs 4 checks: page answers, hidden from search, unsigned webhook refused, database marked development.
2. Commit the changed `wrangler.toml` (the dev database id) to `v12-frontend` and push. Ask Claude to do it if you prefer.
3. **Stripe test mode** → Developers → Webhooks → Add endpoint:
   - URL: `<preview URL>/stripe/webhook`;
   - events: the six in step 1.3.

   Then run `npx wrangler preview secret put STRIPE_WEBHOOK_SECRET --name v12-frontend` and paste its `whsec_…`.
4. **Cloudflare dashboard** → Workers & Pages → usmle100 → Settings:
   - **Variables and secrets / Bindings → "Previews Base":** do **not** import production values. The safe state is empty or test-only. The guards above ignore production keys anyway, but don't rely on that.
   - **Build → Builds for non-production branches:** turn it on. Keep the preview command `npx wrangler preview`. Do **not** change it to `npx wrangler versions upload`: that command uploads a version of the live Worker with the **production** database and secrets.
   - Optional: protect the preview URLs with Cloudflare Access (Zero Trust, free for up to 50 users) so only you and reviewers can open staging.
5. Push any commit to `v12-frontend`. The build log should end with a Preview URL. Open it: the site works, and it starts with an empty database.

**Do not** turn on preview builds before step 1 has finished with "Staging is ready".

## 1. Stripe (payments)

1. **Test mode happens on staging** (step 0): its test key and test webhook go on the Preview only. The live key (`sk_live_…`) goes on production only at launch, after your approval.
2. At launch, add the live key in Cloudflare → Workers & Pages → usmle100 → Settings → Variables and Secrets (Production), type Secret, named `STRIPE_SECRET_KEY`.
3. In Stripe → Developers → Webhooks → Add endpoint:
   - **URL:** `https://<site address>/stripe/webhook`. Today that is `https://usmle100.info-usmle100.workers.dev/stripe/webhook`; it becomes `https://usmle100.com/stripe/webhook` once the domain is connected.
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` and `charge.dispute.funds_reinstated`.
4. Copy that endpoint's **signing secret** (`whsec_…`) into Cloudflare as Secret `STRIPE_WEBHOOK_SECRET`.
5. Do one test-mode purchase of a package and one of the Course Book, using Stripe's test card `4242 4242 4242 4242`. Check that:
   - the portal unlocks;
   - Admin → Course Book lists the buyer as "Bought online";
   - the webhook delivery shows **200** in Stripe.
6. Then switch to the live keys, which need their own live webhook endpoint and signing secret.

**What the site does:**
- It gives access only for a fully paid session, in US dollars, for the exact saved price. Each purchase is fulfilled once.
- **Refunds are decided and issued only by the owner, in the Stripe Dashboard.** The site has no refund button and never asks Stripe for a refund. Students are told to email the contact address.
  - When Stripe reports a **full** refund (`charge.refunded`), the site removes the access from that one purchase: the Course Book bought online, or that program (enrollment marked refunded). Admin grants, other purchases and packages that include the book are kept.
  - **Partial** refunds change nothing.
  - Each refunded charge is handled once, so repeated notifications are harmless.
  - To give access back: Course Book → Admin → Course Book → Give access; a program → Admin → Students → Refunded programs → Restore access.
  - Test it in test mode: refund the test purchase in Stripe, then check that access is gone.

## 2. Domain (usmle100.com)

1. The domain must be on this Cloudflare account.
2. In `wrangler.toml`, uncomment `SITE_URL = "https://usmle100.com"` and the `routes` block, then deploy. Alternatively, add the custom domain in the dashboard under Settings → Domains & Routes and only set `SITE_URL`.
3. After the move, update everything that points at the old address:
   - the Stripe webhook URL (step 1.3);
   - the Zoom app's event notification URL, shown in Admin → Lectures;
   - Bunny's allowed domains (step 3.3).

## 3. Bunny Stream (videos)

1. `BUNNY_LIBRARY_ID` is already set to `785730` in `wrangler.toml`. The Secrets `BUNNY_TOKEN_KEY` and `BUNNY_API_KEY` are already added.
2. In Bunny → Stream → your library → **Security**:
   - keep **Embed view token authentication** ON;
   - turn **CDN token authentication** ON, then play one video to confirm it still works;
   - turn **Enable direct play / MP4 fallback** and any **download** option OFF;
   - in **Allowed domains**, add `usmle100.com` (and the workers.dev address while it's in use).
3. In Bunny → library → **Encoding**, enable resolutions up to **720p** only. This is your 720p maximum. Check Bunny's pricing page first; fewer resolutions usually cost less storage.
4. In Bunny → library → **Player**:
   - enable the playback speed control with speeds from 0.5× to 2×;
   - keep the quality menu on;
   - turn **Picture-in-picture** and **Chromecast/AirPlay** buttons OFF if offered. The site already blocks picture-in-picture and pauses video in hidden tabs.
5. **Test on the real site** with a test student:
   - a paid lecture plays;
   - an unpaid account is refused;
   - after a 1-hour wait, an already-playing long lecture keeps playing;
   - suspending the student mid-video stops it within about 10 seconds;
   - no download option appears.

## 4. Zoom (automatic lecture import, with your approval)

1. These are already done: the Zoom app, the Secret `ZOOM_WEBHOOK_SECRET`, and the event `recording.completed` with "include download token".
2. Create the recurring lecture meeting, then save its meeting ID in Admin → Lectures → "Lecture Zoom meeting ID".
3. After each class:
   - the recording is copied to Bunny privately and placed on its lecture day;
   - it then **waits for your one approval** (Admin → Requests & alerts, e.g. "Publish as Lecture Day 14 of Wed Nov 12, 6:02 PM ET?");
   - students see it only after you approve.
4. Do one real recording end to end before the first class.

## 5. Policies, agreement and content (owner)

- **Policies:** Admin → Site settings has Terms of Service, Privacy Policy and Refund Policy. Each page appears at `/terms`, `/privacy` or `/refunds`, and in the footer, once its text is saved. Have your attorney review them, including:
  - what you collect (name, email, phone, exam, graduation year, date of birth, sign-in and device details, viewing activity);
  - the monitoring used to detect sharing;
  - how long records are kept (security log: 24 months);
  - marketing consent;
  - the viewing limits;
  - refunds;
  - EU/UK withdrawal rights.
- **Student agreement:**
  1. Admin → Student agreement. Nothing is shown to students until you publish a version.
  2. Paste the attorney-approved text and publish it.
  3. Every student must then sign it (typed legal name, date of birth, 18+) before using the portal. Marking a later version as "material" makes everyone sign again.
- **Copyright:** register the Course Book, question bank and lectures as your attorney advises (owner decision; a fee applies).
- **Course Book:** upload chapters in Admin → Course Book (PDFs up to 40 MB each). Students read them only in the stamped, view-only reader.
- **Teaching content:** sections, objectives and flash cards (faculty can add these), questions (Admin → Questions, or spreadsheet import).
- **Free lectures:** Admin → Free lectures. Add a course lecture, an Evening class or an information video (by its Bunny video ID), then **Publish**. Only you can publish.
- **Enrollment:** Admin → Lectures: set the cohort now enrolling and the "enrollment closes after Day N" day.

## 6. Email, SMS and marketing (optional; site works without them)

Until these keys exist, the following stay off:
- email and phone verification;
- self-service "Forgot password";
- the extra checks on risky sign-ins;
- email/SMS notices (every notice still appears in the student's portal).

1. **Email (Resend, free plan):**
   - after the domain is connected, add `usmle100.com` in Resend and the DNS records it shows (SPF, DKIM and a DMARC record);
   - then add the Secrets `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `USMLE100 <noreply@usmle100.com>`) and `OWNER_ALERT_EMAIL` (where security alerts go).
2. **SMS (Twilio, costs money: your approval):** add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. Set a monthly spending limit in Twilio.
3. **Marketing (Sender):** add `SENDER_API_KEY`. Only students who ticked the marketing box **and** verified their email are sent, and withdrawals are removed. No contacts are imported and no emails are sent by the site.
4. **Bot check (Cloudflare Turnstile, free):** create a widget for your domain and add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`. Sign-up then shows the check.

## 7. Your first sign-in after the update

1. You become the **owner** (the first admin account).
2. You'll be asked to **add a passkey** (Face ID / Touch ID on your iPhone). You'll then see **10 recovery codes**: save them in a safe place.
3. Add a second passkey on another device (iPad or computer) so losing one phone doesn't lock you out.
4. From then on, each sign-in and every owner-only change asks for your passkey. Admins and faculty set up their own passkeys on their first sign-in.

## 8. Before going live

1. On **staging** (step 0), do the real-service checks with test credentials, before any merge:
   - Stripe test purchases (package and Course Book), a full refund and a test dispute (step 1);
   - the Bunny checks on the staging library (step 3.5);
   - one Zoom recording through approval, only if you opted staging into Zoom (step 4);
   - email codes and password reset through Resend (step 6).
2. Write down the current time for a possible database rollback (see `HANDOVER.md` → Backups).
3. Make sure `DEV_FAKE_PAYMENTS` is **not** set in Cloudflare (Production).
4. With your approval only: merge `v12-frontend` into `main`. This deploys, and database changes apply automatically. The live Worker then marks its database "production", so no Preview can ever start on it.
5. Add the live Stripe key and the live webhook (step 1). Then do one small real purchase and refund it.
6. Consider making the GitHub repository private, and turn on 2-factor sign-in for Cloudflare, GitHub, Stripe, Bunny and Zoom.
