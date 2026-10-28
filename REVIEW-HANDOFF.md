# USMLE100 — independent review handoff

Prepared 28 Oct 2026 for the owner's independent reviewer. Nothing has been merged into `main` or deployed. No production setting, database, secret or payment has been touched.

## 1. Branch and commits

- **Repository and branch:** `USMLE100/usmle100`, branch `v12-frontend`.
- **Staging-isolation and restore-drill work:** commit `01db2da6803655228774d055ad96a624ed98d52f`.
- **Feature work before that:** last commit `6d3e16c`.
- **This file:** the commit after `01db2da` (see `git log`).

## 2. Staging preview URL

**None exists yet.** Creating one needs Cloudflare access, which this build session does not have:
- `wrangler whoami`: not authenticated;
- no API token;
- no browser connected.

The owner runs `npx wrangler login` and then `bash scripts/setup-staging.sh` (LAUNCH.md §0). The script prints the URL and checks it.

## 3. Files and configuration changed (since `6d3e16c`)

| File | Change |
|---|---|
| `wrangler.toml` | Top level: `ENVIRONMENT = "production"`. New `[previews.vars]`: `ENVIRONMENT = "preview"`, empty `BUNNY_LIBRARY_ID`, `PREVIEW_ALLOW_ZOOM = "0"`. New `[[previews.d1_databases]]`: `DB` points at `usmle100-dev`. Its id is a placeholder until the setup script runs, so preview builds fail rather than run. |
| `src/lib/environment.ts` (new) | `safeEnv`, `checkDatabase` (runs before migrations), `markDatabase`. |
| `src/index.tsx` | `fetch` and `scheduled` use `safeEnv`. The database check runs before `ensureMigrated`. Previews send `X-Robots-Tag: noindex, nofollow`. |
| `src/lib/types.ts` | Adds `ENVIRONMENT` and `PREVIEW_ALLOW_ZOOM`. |
| `scripts/setup-staging.sh` (new) | Owner's one-time staging setup: dev D1, hidden-input test secrets, the Preview, 4 checks. |
| `scripts/db-fingerprint.mjs` (new) | Read-only per-table SHA-256 and reconciliation figures, plus a compare mode. |
| `scripts/make-restore-file.mjs` (new) | Builds a replayable restore file from separate schema and data exports. |
| `test/environment.test.ts` (new) | 11 tests. |
| `LAUNCH.md`, `HANDOVER.md`, `REQUIREMENTS.md` | Staging §0, backup findings, status. |

**Effect on production once merged:**
- `ENVIRONMENT=production`, so `safeEnv` changes nothing;
- one settings row (`db_environment = production`) per Worker instance start;
- nothing else.

## 4. Test commands and results

| Command | Result (28 Oct) |
|---|---|
| `npm test` (`vitest run`, Workers runtime via `@cloudflare/vitest-plugin`) | **14 files, 141 tests, all passed** |
| `npx tsc --noEmit` | no errors |
| `npx wrangler deploy --dry-run` | config valid; production bindings unchanged (`DB` = `usmle100`, `ENVIRONMENT` = `production`, `BUNNY_LIBRARY_ID` = `785730`) |
| Preview simulation: `wrangler dev --var ENVIRONMENT:preview` on a copy of an older, populated database | `503` "already holds accounts…". The database was untouched: 25 tables and 11 users before and after, no migrations applied. |
| Preview simulation on an empty database | `200` with `X-Robots-Tag: noindex, nofollow`. Migrated to 75 tables and marked `development`. The unsigned webhook was refused (`503`, no secret). |
| Earlier feature verification (unchanged code paths) | 26/26 browser workflows; 109 + 65 page review with 0 problems |

## 5. External integrations: simulated vs real

| Service | Simulated (automated tests) | Real sandbox test |
|---|---|---|
| Stripe | Checkout fulfilment, signature checks, full/partial refunds, disputes, reconciliation | **Not done.** Needs a Stripe test key on staging. |
| Bunny Stream | Signed embed URLs, stand-in player, view limits | **Not done.** Needs a staging library and its keys. |
| Zoom | Signed webhook, approval-before-publish, import | **Not done.** Needs owner approval and a staging Zoom app. |
| Resend email | Message building, retries | **Not done.** Needs an API key and a verified sending domain. |
| Twilio SMS | Message building | **Not done.** Costs money; needs owner approval. |

No integration is claimed to work against the real service.

## 6. Database isolation and backups

**Isolation (verified in code, tests and local simulation):**
- A Preview binds only `usmle100-dev`.
- If it is ever bound to the production database, it stops **before** migrations.
- Live Stripe keys, Zoom, Sender and live-library Bunny write keys are removed outside production.

**Not yet verified on Cloudflare itself:**
- the effective bindings of a real Preview;
- how the dashboard "Previews Base" interacts with the config file.

The runtime guards cover both.

**Backups (local drill, disposable data):**
- A plain `wrangler d1 export` **cannot be replayed**: `no such table: main.sections`. This is a real finding.
- The two-file restore (`scripts/make-restore-file.mjs`) reproduced all 74 tables, verified by SHA-256 per table.
- The payment, enrollment, refund, dispute and lecture-view figures were identical.
- Counters were correct and there were no foreign-key violations.
- The site served pages from the restored copy.
- Timings: export 4.6 s, restore 3.7 s (local).

**Not verified:** a remote export/restore and a D1 Time Travel restore. Both are planned on `usmle100-dev`, and both need Cloudflare access.

## 7. Blockers and owner approvals

1. **Cloudflare access:**
   - run `npx wrangler login` and `scripts/setup-staging.sh`;
   - commit the dev database id;
   - then turn on preview builds, keeping the command `npx wrangler preview`.

   Alternatively, give Claude a scoped Cloudflare API token as an environment secret, never in chat.
2. **Stripe test-mode** key and webhook on staging.
3. **Bunny staging library.** Bunny bills storage and bandwidth, so this needs approval.
4. **Zoom on staging:** approval to set `PREVIEW_ALLOW_ZOOM = "1"` with a staging Zoom app.
5. **Resend:** API key and sending domain.
6. **Twilio:** approval to spend.
7. A separate R2 backup copy: approval, since it may cost money.
8. Legal texts (attorney) and the launch merge (owner).

## 8. Updated documents

`LAUNCH.md` (§0 staging, §1, §8), `HANDOVER.md` (Backups, Staging), `REQUIREMENTS.md` (header, section L).

## 9. Open risks

- **Preview URLs are public by default.** Staging holds only test data, but anyone with the link can sign up there. The recommendation is Cloudflare Access on previews (LAUNCH §0.4).
- **The `db_environment` marker** is written by the new code only after it reaches production. Until then, the production database is protected by the "already holds accounts" rule, not by the marker.
- **The Preview feature is "open beta"** in Wrangler 4.151.3, so its behaviour may change. Keep the runtime guards.
- **Nightly exports** (if approved) must save schema and data separately; a plain export won't restore.
- **Unverified integrations:** the items in §5 stay unverified until staging credentials exist.
