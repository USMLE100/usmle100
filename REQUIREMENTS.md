# USMLE100 requirements checklist

Branch `v12-frontend`. Last updated 27 Oct 2026. Nothing here is merged or deployed.

**Sources**
- **Conv** — the owner's 197-page conversation export, pages 1–124: V12 design, Phase 1/2 features, payments, refunds, Free Lectures, registration, webinars, Zoom approval and cohorts.
- **R###** — the owner's numbered security decisions (pages 125–197), recorded in the security requirements document.
- **Dir** — the final directive's checklist, sections A–M.

**Status**
- **Done**: built and covered by tests.
- **Done (off)**: built and tested, but stays switched off until the owner adds a provider key.
- **Owner**: needs the owner's action in a dashboard, a legal or business decision, or payment.
- **Limit**: the strongest practical measure is built, and the limitation is documented.
- **Not built**: deliberately not built; the reason is given.

**Test files** live in `test/`:
- 13 automated files, 128 tests (`npm test`).
- Browser checks in the local preview: a 109-page review, 26 end-to-end workflows, and 17 player checks with a stand-in Bunny player.
- Every external service (Stripe, Bunny, Zoom, Resend, Twilio, Sender) is simulated in tests. Real-service checks are listed in LAUNCH.md.

## A. Ownership, administration and staff

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Owner role, separate from admins (first admin becomes owner) | R020/R021, Dir A | `migrations/0014`, `lib/types.isOwner` | owner-security | Done |
| Only the owner creates or removes admins and changes roles; the owner can't be demoted | R021, Conv p130 | `lib/auth OWNER_ONLY`, `routes/admin /team` | security, owner-security | Done |
| Only the owner changes prices, settings, access grants, restores, lockdown, agreement, free-lecture publishing, extra views, case decisions, program grants, payment retries | R021, R164, Dir A | `OWNER_ONLY` list | owner-security, viewing, cases, payments | Done |
| Owner authorises refunds, discounts, complimentary access, enrollment adjustments and extensions | R164 | Refunds are made by the owner in Stripe; grants, extensions and restores are owner-only | refunds, owner-security | Done (no discount codes exist on the site) |
| Faculty limited to teaching tools, deny by default | R020, Conv p7 | `FACULTY_ALLOWED` | security, phase2 | Done |
| Students and faculty can't use admin functions (404) | Dir A | `requireAdminOrFacultyAllowed` | security, owner-security | Done |
| Passkeys / FIDO2 required for owner, admins and faculty | p130, add. Q1 | `lib/passkeys`, `routes/passkeys`, gate | passkeys (software authenticator); browser (virtual authenticator) | Done |
| Fresh authentication for sensitive actions: passkey step-up within 15 minutes; password only until a passkey exists | R021 | `freshlyConfirmed`, `/admin/confirm` | passkeys, owner-security | Done |
| Approved privileged devices | add. Q1 | Staff passkeys are bound to their devices; staff are exempt from the student device limit | passkeys | Done (via passkeys) |
| Secure privileged recovery: 10 one-time recovery codes, staff alert on use | add. Q1 | `lib/passkeys` | passkeys | Done |
| Least-privilege developer access; time-limited, logged production access | add. Q4 | Owner controls Cloudflare and GitHub; see HANDOVER | — | Owner |
| Owner controls domain, hosting, repository, database, payments, video and backups | Bus. Q1 | HANDOVER "Accounts the owner must hold" | — | Owner |
| Architecture, dependency inventory, reproducible build, deploy, migrations, handover | Bus. Q6 | `HANDOVER.md`, `package-lock.json`, `migrations/` | — | Done |

## B. Registration, identity and agreements

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Sign-up asks for first and last name, email, phone (international), exam (Step 1/2/3 …) and graduation year | Conv p76, p86, p113 | `routes/public /sign-up`, `lib/profile` | accounts | Done |
| Existing students without these details are asked for them before free lectures and webinars | Conv p107 | `profileComplete`, My account | viewing, webinars | Done |
| Optional marketing box, unticked; wording and time stored; separate from registration | Conv p86, p109 | sign-up, My account | accounts | Done |
| Sign-up rate limit (10 per hour per network); optional free Turnstile bot check | Conv p109, R(automated attacks) | `rateHit`, `TURNSTILE_*` | accounts | Done; Turnstile Done (off) |
| Minimum age 18 | R014 | Agreement page (date of birth) | owner-security | Done |
| Verified email and phone with one-time codes: 6 digits, hashed, 10 minutes, 5 tries, 5 sends per hour | R015 | `lib/messaging`, My account | messaging | Done (off): needs Resend + domain, and Twilio (cost approval) |
| Content-protection agreement before protected access, for new and existing students; re-signing after material changes | R012 | `lib/gate`, `/agreement`, Admin → Student agreement | owner-security | Done. **Owner**: attorney-reviewed text; nothing is published yet |
| Full legal name, date of birth, version, time, IP, browser and text hash recorded | R012/R014 | `agreement_signatures` | owner-security | Done |
| Changes to a verified email or phone need an admin | R016 | contact-change requests | accounts | Done |
| Re-verification after 30 days without signing in (entitlements kept) | p133 | `lib/risk` | messaging | Done (off until email is configured) |
| Secure identity recovery; protection against suspicious contact changes | p156–p172 | Admin-approved contact changes, "This wasn't me", alerts | accounts | Done (core). The detailed quarantine workflows are handled manually by staff |
| Government ID only when necessary, by support email, deleted within 24 hours | p156–p157 | Process only (no upload feature by design) | — | Owner |

## C. Passwords, sign-in and sessions

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| At least 12 characters; breached passwords refused (Pwned Passwords range check); no forced expiry | R094 | `lib/passwords` | owner-security | Done |
| 5 wrong passwords lock the account until an admin unlocks it; an admin's reset link also unlocks | R029 | `lib/ratelimit`, Admin → Security | hardening | Done |
| Self-service password recovery with verified identity | p130 | `/forgot` (email link, plus a texted code when the phone is verified) | messaging | Done (off until email is configured); admin reset links work today |
| Changing a password needs the current one and signs out every device | p153 | My account | accounts, workflows | Done. The extra email/SMS code applies once messaging is on |
| 30-minute inactivity sign-out; warning at 25 minutes with Stay logged in; verified playback counts as activity | R088–R090 | `views/layout SESSION_JS`, `/session/*` | owner-security, browser | Done |
| 24-hour maximum session with a 5-minute warning | R091 | same | owner-security | Done |
| Risk-based extra checks (new device, new country, 30 days inactive); 5 failures end the sign-in and need admin review | p149–p150 | `lib/risk`, `/account/check-sign-in` | messaging | Done (off until email is configured) |
| Login history (30 days), "This wasn't me", alerts for new devices and countries | p150–p151 | My account, `notices` | accounts | Done |
| Sign out one session or all | p151 | My account | accounts | Done. The extra verification applies once messaging is on |
| Optional student passkeys (2 devices) | p154–p155 | — | — | Not built: depends on email/phone codes (R015) being live. Staff passkeys can be reused |

## D. Devices and account sharing

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| At most 2 registered devices per student | R001 | `lib/devices` | accounts | Done |
| One active device playing protected content; one protected tab | R001, R060 | `play_tabs` (one per account, across all devices) | viewing, browser | Done |
| Replacing a device needs admin approval; repeat requests within 30 days are flagged | R017, p148–p149 | Admin → Requests & alerts | accounts | Done |
| First suspected sharing: big red warning and an owner alert; a repeat locks the account until the owner reinstates | R003/R004 | `lib/devices`, gate | accounts, owner-security | Done |
| Credible fraud or compromise suspends the whole account | R149 | Disputes marked "fraudulent" suspend; admins can suspend | payments, owner-security | Done |
| Reinstatement is owner-only and logged | R004 | `/admin/security/reinstate`, appeals | owner-security, cases | Done |
| Safeguards against false positives and lockout abuse | Dir D | Warning before any lock; locks are per account; IP limit is time-limited; appeals | hardening, cases | Done |

## E. Protected lecture delivery

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Paid enrollment and the right cohort checked on the server; other cohorts blocked (player, done, save, claim) | Conv p107, add. Q3 | `lib/viewing.resolve`, `routes/learn` | owner-security, viewing | Done |
| No video link in the page; short-lived (1 hour) signed links, given only after the access check | add. Q3 | `/play/claim`, `bunnyEmbedUrl` | viewing, hardening | Done |
| Revoked on suspension, lockdown, refund, expiry or free unpublishing (next progress check stops the player) | add. Q3 | `recordBeat` → "gone" | viewing | Done. **Owner**: confirm on real Bunny whether an already-loaded stream stops |
| No downloads or offline viewing | R057 | Bunny token authentication; no download in our page | — | Owner: keep downloads and MP4 fallback off in Bunny |
| 720p maximum; automatic and manual quality; speeds 0.5×–2× | R059, R055 | Bunny library player settings | — | Owner (Bunny dashboard; check pricing) |
| Moving watermark: name, account ID, viewing-session code; stays in our full screen; tamper check | R006–R008 | `views/player` | browser (17 checks) | Done / Limit: an overlay, not burned into the video |
| Picture-in-picture off | R071 | iframe `picture-in-picture 'none'`; hidden-tab pause | browser | Done. Also turn off the PiP control in Bunny |
| Pause when the tab is hidden or the screen locks; resume on return | R069, R076 | `PLAYER_JS` | browser | Done |
| Pause after 30 seconds without confirmed progress | R067/R068 | `PLAYER_JS` | browser | Done |
| Phone calls pause playback | R077 | Covered where the browser hides the page or pauses media | — | Limit |
| Casting only when protections stay | R074 | Not controllable from our page | — | Limit: turn casting off in Bunny's player if offered |
| Screen recording / screenshots | R072 | Watermarks, agreement, evidence log | — | Limit: browsers can't reliably block or detect recording |

## F. Free lectures

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Owner's hand-picked list: course lecture, Evening class or any Bunny video; ordered; starts unpublished; only the owner publishes | Conv p77, p86, p102, R041 | `routes/freeAdmin`, `free_videos` | viewing, workflows | Done |
| Registered, signed-in students with complete details who signed the agreement | R035, Conv p113 | `resolve`, `profileComplete`, gate | viewing, workflows | Done (email/phone verification once messaging is on) |
| 2 views each; 24-hour window from actual playback; 65% unique content; an expired started window uses a view | R036–R040 | `lib/viewing` | viewing | Done |
| Unpublishing removes access at once; re-adding keeps counts | R042/R043 | entries are never deleted | viewing | Done |
| Extra free views: owner-only, logged | R044 | Admin → Lecture views | viewing | Done |
| Buying the program switches to the 5 paid views (free history kept) | R046 | `paidKey` redirect | viewing | Done |
| Public teaser on the website; sign-up returns to Free Lectures | Conv p93, p102 | home page, sign-up `next` | workflows | Done |

## G. Paid lecture viewing limits

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| 5 views per lecture per paid enrollment; fresh views for a new enrollment; history kept | R048, R052 | `viewState` | viewing | Done |
| 24-hour window from playback; one view at 65% or at expiry; never twice per session | R050 | `recordBeat`, `settleExpired` | viewing | Done |
| Only unique content counts; seeking is free; faster than 2× is rejected | R055/R056/R066 | `markSeconds`, speed cap | viewing | Done |
| Resume at the exact point; the session ends at 65% and another view is needed | R064/R065 | `video_positions` | viewing | Done |
| First-play warning; counts hidden until locked; limits disclosed before checkout | R053/R054, Dir G | player notice; Programs/checkout text | viewing, accounts | Done |
| End Lecture; 2-minute release; resuming keeps the same viewing | R061–R063 | `claimTab` / `releaseTab` | viewing, browser | Done |
| Owner-only extra views with reasons; requests reviewed by admins | R051 | Admin → Lecture views | viewing | Done |
| No negative balances; no duplicate corrections; restored views can't repeat | p176–p178 | `view_grants.case_id` unique; counts never go below zero | cases | Done |
| Wrongful blocks: restore a view through a dispute | p174–p175 | Appeals and disputes | cases | Done |
| Evening Questions recordings: the same protections, no view limit (no owner decision sets one) | Dir G | item `E:` (open access) | viewing | Done (policy documented) |

## H. Course Book, question bank, flash cards

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| No downloads; "downloadable" wording removed | R005 | `routes/library` | owner-security, payments | Done |
| View-only reader: pages drawn as images with name and account ID on every page, plus the session code | R006/R007 | `views/reader` (pdf.js 5.7.284 legacy, self-hosted) | owner-security, workflows (pages drawn) | Done / Limit: a phone camera can still photograph the screen |
| Original PDF never public; each reading session fetches the chapter once, scrambled, within 10 minutes | Dir H | `/course-book/:id/data` | owner-security | Done |
| Rate limits and anti-copying flags for Qbank, flash cards and the Book | R(automated attacks) | `lib/abuse` | accounts | Done |
| Qbank and flash cards only for eligible students | Dir H | portal gate | security, phase2 | Done |

## I. Payments and enrollment

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Stripe-hosted checkout; no card data stored | add. Q2 | `lib/stripe` | payments | Done |
| Activate only after a verified webhook, for the saved price; duplicates ignored | add. Q2 | `fulfil` | payments | Done. **Owner**: test-mode keys and webhook |
| Full refund removes only that purchase; partial changes nothing; replays harmless | Conv p76, p96 | `handleRefund` | refunds | Done |
| Chargebacks pause the disputed purchase; "fraudulent" suspends; owner restores | p134, R149 | `lib/stripe` disputes | payments | Done |
| Reconciliation of payments and enrollments (and Stripe, when the key is set) | Bus. Q3 | Admin → Payments | payments | Done |
| Financial changes logged in a tamper-evident chain | Bus. Q3 | `audit_log` | owner-security | Done |
| Cohort shown before payment and saved through to activation; "cohort now enrolling" and "enrollment closes after Day N" | Conv p95, p103 | `lib/enrolling` | payments | Done. **Owner**: set the values |
| $199 Course Book, Evening Questions, tutoring, prices and course structure kept | Conv | unchanged | payments, phase2 | Done |

## J. Notifications

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Portal message history for every notice | p166 | My account → Messages, `notices` | messaging | Done |
| Transactional email (Resend) and SMS (Twilio), with retries, the other channel as fallback, admin escalation after 1 hour and owner after 24 hours | p132, p166–p167 | `lib/messaging` | messaging | Done (off). **Owner**: accounts, domain (SPF/DKIM/DMARC), cost approval for SMS |
| Alerts for new devices and countries, locks, recovery, payment issues and incidents | p150 | `notify`, `staff_alerts` (warnings emailed to the owner) | messaging | Done |
| Owner controls the provider, sender and sending limits | Bus. Q4 | Cloudflare secrets (owner-held) | — | Owner |
| Marketing kept separate: Sender sync of verified opt-ins only | Conv p94, p109 | `syncMarketing` | messaging | Done (off) |

## K. Incidents, appeals and compensation

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Emergency lockdown: owner-only; signs students out; public pages, checkout and staff keep working; incident record | R023, add. Q5 | Admin → Security | owner-security, workflows | Done |
| Automatic targeted defences (rate limits, locks, compromised-session revocation) | add. Q5 | ratelimit, abuse, "This wasn't me" | hardening, accounts | Done; add Cloudflare WAF rules after the domain moves |
| Appeals: admin review, owner decision, written reasons, update every 5 business days, 3 business days for new evidence | p159–p161 | `routes/cases` | cases | Done |
| View disputes: 2 business days; 12 hours when an exam within 48 hours is verified; exam evidence by email, deleted within 24 hours | p178–p184 | `lib/cases` | cases | Done |
| Exact compensation; time restored to enrollments that expired during a block; never twice | p161–p163 | `compensate` | cases | Done (access is date-based, so part days round up) |
| Escalation of overdue cases | p165 | `escalateCases` (5-minute schedule) | cases | Done |
| Permanent piracy bans vs appeal rights | p185 | Appeals stay available; the owner may deny | — | **Conflict flagged**: the owner should confirm |

## L. Privacy, records and backups

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| Tamper-evident security and financial log, 24 months, chain check on the Security page | R010, Bus. Q3 | `lib/audit` | owner-security | Done |
| Owner-controlled deletion (anonymises; keeps payment records); data copy on request | p134, add. Q6 | Admin → Requests & alerts | accounts | Done |
| Backups: point-in-time restore to any minute (D1 Time Travel, 7 days free / 30 days paid) | Q5 (RPO 1 h, RTO 12 h) | HANDOVER "Backups" | — | Owner: a separate encrypted export to R2 needs approval; test restores regularly |
| Secrets only in Cloudflare; nothing in the repository | Conv | HANDOVER | — | Done |
| Privacy Policy and Terms text | Conv p98 | Admin → Site settings | — | Owner (attorney) |

## M. Website and portal

| Requirement | Source | Where | Tests | Status |
|---|---|---|---|---|
| V12 design across public site and portal; Phase 1 and 2 features | Conv p35–p71 | all routes | phase2, browser review | Done |
| Free Lectures, My Courses, Explore Programs in the menu; "Enroll to unlock" | Conv p88 | layout | workflows | Done |
| Zoom recordings wait for the owner's one approval, then publish to the right lecture day | Conv p113–p114 | Admin → Lectures / Requests | video | Done. **Owner**: lecture meeting ID; one real recording test |
| Live webinars: registration with the existing account, attendee list | Conv p113 | `routes/webinars` | webinars | Done |
| Admin → Students: search, filters, detail, CSV export (admin only), owner "give program" | Conv p103 | `routes/students` | payments, accounts | Done |
| Phones, tablets and computers: no sideways scrolling | Dir M | browser review (390 px and 1366 px) | browser | Done |
| Question mastery tags, transcripts, extended timers | Conv p65 | — | — | Not built: not advertised; the rules were never defined |
