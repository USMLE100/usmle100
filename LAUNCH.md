# USMLE100 launch checklist

Each step below needs a real account, key or domain, so it is done by the owner in a dashboard. The code for every step is already in place on the `v12-frontend` branch.
Never paste keys into chat, email or GitHub. In Cloudflare, always add keys as type **Secret**.

## 1. Stripe (payments)

1. In the Stripe Dashboard, get the **secret key**: a test-mode key (`sk_test_…`) to try things out first, then the live key (`sk_live_…`).
2. Add it in Cloudflare → Workers & Pages → usmle100 → Settings → Variables and Secrets, type Secret, named `STRIPE_SECRET_KEY`.
3. In Stripe → Developers → Webhooks → Add endpoint:
   - **URL:** `https://<site address>/stripe/webhook`. Today that is `https://usmle100.info-usmle100.workers.dev/stripe/webhook`; it becomes `https://usmle100.com/stripe/webhook` once the domain is connected.
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `charge.refunded`.
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

1. `BUNNY_LIBRARY_ID` is already set to `785730` in `wrangler.toml`.
2. These Secrets are needed:
   - `BUNNY_TOKEN_KEY`: the library's Token Authentication key (already added).
   - `BUNNY_API_KEY`: the library's API key (already added).
3. Bunny → Stream → library → Security:
   - keep token authentication ON;
   - add `usmle100.com` (and the workers.dev address while it's in use) to Allowed Domains.
4. Play one real video from a student account.

## 4. Zoom (automatic lecture import)

1. These are already done: the Zoom app, the Secret `ZOOM_WEBHOOK_SECRET`, and the event `recording.completed` with "include download token".
2. Create the recurring lecture meeting, then save its meeting ID in Admin → Lectures → "Lecture Zoom meeting ID".
3. After the first real class:
   - Admin → Lectures should show the recording as "Copying from Zoom", then "Ready";
   - that day's lecture goes live by itself within about 30 minutes.

## 5. Policies and content (owner)

- **Policies:** Admin → Site settings has Terms of Service, Privacy Policy and Refund Policy. Each page appears at `/terms`, `/privacy` or `/refunds`, and in the footer, once its text is saved. The Course Book checkout page links the Terms and Refund Policy when they exist.
- **Course Book:** upload the chapters in Admin → Course Book. They are PDFs up to 40 MB each.
- **Teaching content:** add sections, objectives and flash cards (faculty can do these too).

## 6. Before going live

- Merge `v12-frontend` into `main` (this deploys).
- Make sure `DEV_FAKE_PAYMENTS` is **not** set in Cloudflare.
- Consider making the GitHub repository private.
