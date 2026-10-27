# USMLE100 launch checklist

Each step below needs a real account, key or domain, so it is done by the owner in a dashboard. The code for every step is already in place on the `v12-frontend` branch.
Never paste keys into chat, email or GitHub. In Cloudflare, always add keys as type **Secret**.

## 1. Stripe (payments)

1. In the Stripe Dashboard, get the **secret key**: a test-mode key (`sk_test_…`) to try things out first, then the live key (`sk_live_…`).
2. Add it in Cloudflare → Workers & Pages → usmle100 → Settings → Variables and Secrets, type Secret, named `STRIPE_SECRET_KEY`.
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
- **Enrollment:** Admin → Site settings: set the cohort now enrolling and the "enrollment closes after Day N" day.

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

1. Write down the current time for a possible database rollback (see `HANDOVER.md` → Backups).
2. Make sure `DEV_FAKE_PAYMENTS` is **not** set in Cloudflare.
3. Merge `v12-frontend` into `main` (this deploys; database changes apply automatically).
4. Do the real-service checks:
   - Stripe test purchases and refund (step 1);
   - the Bunny checks (step 3.5);
   - one Zoom recording (step 4);
   - then switch Stripe to live keys.
5. Consider making the GitHub repository private, and turn on 2-factor sign-in for Cloudflare, GitHub, Stripe, Bunny and Zoom.
