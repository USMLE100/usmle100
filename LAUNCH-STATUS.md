# USMLE100 launch tracker

Single source of truth for what is left before launch. Updated 2 Nov 2026. Everything marked **Done** was finished and tested on staging, and should not be redone. LAUNCH.md has the full reference; this file is the short list.

## Owner decisions (fixed)
- Cloudflare **Free** plan; free-plan optimizations are done (REVIEW-HANDOFF §12).
- Forest green and gold colours on the V12 design.
- Bunny: 240/360/480p only, H.264, free encoding, MediaCage Basic, no paid add-ons, original files kept.
- Videos: 2 views at 90%; 1 extra view on request with one-click owner approval; interruptions keep the viewing; no automatic extension.
- No new paid services.
- The new site **replaces** everything at usmle100.com.
- Email stays on **Zoho** (info@usmle100.com).

## Status

| # | Item | Status | Who |
|---|---|---|---|
| 1 | Code: V12 site and portal, security fixes, payments, refunds, video protection | **Done**, tested on staging | — |
| 2 | Stripe sandbox purchase, refund, access removal | **Done** (real sandbox) | — |
| 3 | Bunny security, encoding and player settings | **Done** (owner applied, iPhone-tested) | — |
| 4 | Database readiness: owner = `info.usmle100@gmail.com` (#1), live at migration 0010, upgrade rehearsal 0010 → 0023 passed 20/20 | **Done** | — |
| 5 | Domain: DNS moved from IONOS to Cloudflare (free). All 17 records were copied and checked (Zoho MX 10/20/50, SPF, DKIM, DMARC, verification; Mailchimp; Google). The old site's A/AAAA records are set to DNS only. IONOS nameservers → kenneth.ns.cloudflare.com / may.ns.cloudflare.com (3 Nov) | **Waiting for Cloudflare to activate** (minutes to 48 h) | Owner |
| 6 | Legal texts: Terms, Privacy, Refund policy, Student Agreement. Drafts revised 3 Nov (North Carolina, USMLE100 LLC, no address shown); acceptance evidence stored by version (migration 0024) | **Attorney review needed**, then paste into Admin settings | Owner + attorney |
| 7 | Prices and details confirmed by owner (3 Nov): $1,500 / $1,999 / $2,449 (recommended) / MAX $3,799; tutoring $50/h; Evening Questions $160/month; Course Book $199; no student-count claim (removed 3 Nov: not verified); recordings until 60 days after Day 100; Calendly link; no practice-test date (card hidden) | **Done** (settings entered on launch day) | — |
| 8 | Launch approval: merge `v12-frontend` into `main` | **Needed** | Owner says "approve launch" |
| 9 | Launch day: live Stripe key + live webhook | **Launch day** | Owner (Claude guides) |
| 10 | Launch day: attach usmle100.com to the Worker, set `SITE_URL`, add usmle100.com and www to Bunny's Allowed domains | **Launch day** | Owner (Claude guides) |
| 11 | Launch day: owner signs in, adds a passkey; faculty and admins add passkeys | **Launch day** | Owner and staff |
| 12 | First real lecture upload: plays, MediaCage applies, slides readable at 480p | **After launch** | Owner |

## Launch-day order (about 30–45 minutes, Claude guides each step)
1. Note the time, for a possible database rollback (D1 Time Travel).
2. Owner approves; merge `v12-frontend` into `main`; Cloudflare deploys; the database upgrades itself (0011–0023).
3. Owner signs in as `info.usmle100@gmail.com`, adds a passkey and checks /admin.
4. Add the live Stripe secret key and the live webhook (the six events in LAUNCH.md §1).
5. Attach usmle100.com and www.usmle100.com to the Worker; set `SITE_URL = "https://usmle100.com"`; redeploy.
6. Bunny → Allowed domains: add usmle100.com and www.usmle100.com.
7. Smoke test: home, sign-in, one real $1-style purchase and refund, one lecture plays with the watermark.
8. Send Zoho a test email to and from info@usmle100.com.
9. Admin → Site settings: Calendly `https://calendly.com/usmle100/usmle100-1-on-1-tutoring-60mins`; leave the student count empty (hidden; owner removed the unverified "1,400+" claim); contact email; leave the practice-test date empty (hidden).

## Production checks still to do by hand (owner, on a real device; cannot be simulated)
Code-level tests pass (182, 4 Nov 2026). These need the live site, a real lecture and the owner's login:
1. **Real lecture playback** on usmle100.com: approve one real recording (never the two test videos), then play it on iPhone.
2. **Watermark** visible during playback: name, account number, session code, plus the faint tiled pattern; still there in full screen.
3. **Playback beyond 15 minutes**: keep watching past the 15-minute signed-link expiry; it must keep playing (and resume after a pause).
4. **Signed-link reuse protection**: while it plays, copy the player link and open it in a new tab or another browser; Bunny must refuse it (allowed domains + token).
5. **MediaCage DRM** on the first real upload: in Bunny, the video shows DRM protection (and no MP4 download exists).
6. **Live payment**: the first real payment (or an owner test) shows a 200 delivery in Stripe → Webhooks, and the student is enrolled automatically.
7. **Zoom import**: after the next class, the recording appears in Admin → Lectures as "waiting for approval" (not failed).

## Not needed for launch (optional later)
- Password-reset email: Resend, free tier, needs the domain.
- Zoom automatic import; SMS.
- Enterprise DRM (declined).
- The $5 plan (declined; usage to be watched).
