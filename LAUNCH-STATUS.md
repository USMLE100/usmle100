# USMLE100 launch tracker

Updated 2 Nov 2026. The single list of what's left. Done items stay done and are not redone.

## Done (no further work)

- **V12 site and portal** on staging (branch `v12-frontend`), in the original forest green and gold.
- **Security review fixes:** independent re-check passed.
- **Payments:** Stripe sandbox purchase and refund tested end to end. A refund removes access.
- **Video:**
  - Bunny playback, watermark, 2 views at 90%, additional-view requests and the interruption rules, tested on iPhone.
  - Bunny library security and player settings applied (`VIDEO-SECURITY.md`).
  - Encoding at 480p maximum.
- **Database:**
  - The live DB is at 0010, and the owner will be `info.usmle100@gmail.com` (the owner can sign in).
  - Upgrade rehearsal 0010 → 0023 passed: 20/20 checks, data unchanged.
- **Cloudflare Free plan:** check-ins and writes reduced and measured (`REVIEW-HANDOFF.md` §12).

## Remaining (in order)

| # | Item | Who | Status |
|---|---|---|---|
| 1 | **Domain:** move usmle100.com DNS from IONOS to Cloudflare (free), keeping every **Zoho** email record (MX, SPF, DKIM, verification, DMARC) | Owner, guided | Waiting for IONOS DNS screenshots |
| 2 | **Legal pages:** Terms, Privacy, Refund policy, Student Agreement (Admin → Site settings) | Owner (attorney) | Not started |
| 3 | **Content check:** prices, FAQ answers (refund window, $50 extra sessions, 60 days after Day 100), "1,400+" | Owner | Not started |
| 4 | **Launch day** (about 30 min, guided) | Owner + Claude | After 1–3 |
|   | a. Note a database restore point (D1 → Time Travel) | Owner | |
|   | b. Merge `v12-frontend` into `main`; Cloudflare deploys; migrations 0011–0023 run | Owner approves | |
|   | c. Attach usmle100.com to the Worker; set `SITE_URL`; add usmle100.com + www to Bunny Allowed domains | Owner, guided | |
|   | d. **Stripe live:** live secret key and live webhook (6 events, `LAUNCH.md`) | Owner, guided | |
|   | e. Owner signs in, adds a passkey; staff add passkeys | Owner | |
|   | f. One real $1 live purchase and refund; one lecture plays with the watermark | Owner + Claude | |
| 5 | **First real lecture upload:** plays; slide text readable at 480p | Owner | After launch is fine |

## Watch after launch

- Cloudflare D1 daily "rows written": tell Claude if it is regularly above about 70,000.
- Bunny: check that new uploads are MediaCage-protected.
