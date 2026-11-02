#!/usr/bin/env bash
# Pre-launch checks. Run once on a computer:
#
#   npx wrangler login
#   bash scripts/prelaunch-checks.sh
#
# PRODUCTION (read-only, nothing is written):
#   1. who will become the owner at launch (migration 0014 makes the lowest-id admin the owner);
#   2. which database version production is on (the V12 code expects 0001-0010 and adds 0011-0022);
#   3. that Time Travel restore points exist for the production database.
# STAGING ONLY (usmle100-dev):
#   4. a real restore drill: note a restore point, write a marker row, restore, and check that the marker is gone
#      and the row counts match. The production database is never restored, and the script refuses it by id.
#
# It prints a PASS/FAIL summary. Emails are masked (first letter + ***) so the output is safe to screenshot.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_DB="usmle100";      PROD_DB_ID="d1ff7fee-bf81-42d8-863a-652e3476716c"
DEV_DB="usmle100-dev";   DEV_DB_ID="7cf62a77-9fc6-46ab-b9fa-bdf16f5dcef3"
W="${W:-npx --yes wrangler}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }
RESULTS=()
pass() { RESULTS+=("PASS  $*"); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { RESULTS+=("FAIL  $*"); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }

$W whoami >/dev/null 2>&1 || die "Not signed in to Cloudflare. Run: npx wrangler login"

# Read-only query helper (JSON rows). Refuses anything that is not a SELECT.
q() { # db sql
  case "$2" in SELECT*|select*) ;; *) die "internal: only SELECT is allowed against $1";; esac
  $W d1 execute "$1" --remote --json --command "$2" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j[0]?.results??[]))})'
}
bookmark() { $W d1 time-travel info "$@" 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}' | head -1 || true; }

# Make sure the names point at the ids we expect before doing anything.
ids=$($W d1 list --json 2>/dev/null)
node -e "const l=JSON.parse(process.argv[1]);const f=n=>l.find(d=>d.name===n)?.uuid;if(f('$PROD_DB')!=='$PROD_DB_ID'||f('$DEV_DB')!=='$DEV_DB_ID'){console.error('database ids do not match');process.exit(1)}" "$ids" \
  || die "The database names don't match the expected ids. Nothing was run."

# ---------- 1. Owner (production, read-only) ----------
say "1. Who becomes the owner at launch (production, read-only)"
admins=$(q "$PROD_DB" "SELECT id, email, name FROM users WHERE role = 'admin' ORDER BY id LIMIT 5")
node -e '
const a=JSON.parse(process.argv[1]);const m=e=>e.split("@")[0].slice(0,1)+"***@"+(e.split("@")[1]||"");
if(!a.length){console.log("  No admin accounts exist. Nobody would become owner.");process.exit(2)}
a.forEach((r,i)=>console.log(`  ${i===0?"→ OWNER":"  admin"}  #${r.id}  ${r.name}  ${m(r.email)}`));' "$admins" \
  && pass "an admin exists; the first one listed (→ OWNER) becomes owner. Check it is you." \
  || fail "no admin account in production: nobody would become owner"

# ---------- 2. Database version (production, read-only) ----------
say "2. Production database version (read-only)"
migs=$(q "$PROD_DB" "SELECT name FROM _migrations ORDER BY name")
node -e '
const n=JSON.parse(process.argv[1]).map(r=>r.name);console.log("  applied: "+(n.length?n[0]+" … "+n[n.length-1]+" ("+n.length+")":"none"));
const newer=n.filter(x=>x>"0010_zzz");if(newer.length){console.log("  unexpected newer migrations: "+newer.join(", "));process.exit(1)}
if(!n.some(x=>x.startsWith("0010_"))){console.log("  0010 is missing");process.exit(1)}' "$migs" \
  && pass "production is at migration 0010, as rehearsed" \
  || fail "production database version differs from the rehearsal. Tell Claude before launch."

# ---------- 3. Restore points exist (production, read-only) ----------
say "3. Production restore points (read-only)"
pb=$(bookmark "$PROD_DB")
[ -n "$pb" ] && pass "production has a current restore point (Time Travel is on)" || fail "could not read production restore points"
pb_old=$(bookmark "$PROD_DB" --timestamp="$(node -e 'console.log(new Date(Date.now()-86400e3).toISOString())')")
[ -n "$pb_old" ] && pass "production can be restored to 24 hours ago" || fail "no restore point from 24 hours ago"

# ---------- 4. Restore drill (staging database only) ----------
say "4. Restore drill on $DEV_DB (staging only)"
[ "$DEV_DB_ID" != "$PROD_DB_ID" ] || die "internal: dev and prod ids are equal"
count_sql="SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM enrollments) AS enrollments, (SELECT COUNT(*) FROM settings) AS settings"
before=$(q "$DEV_DB" "$count_sql")
b0=$(bookmark "$DEV_DB")
[ -n "$b0" ] || die "could not read a restore point for $DEV_DB"
echo "  restore point: $b0"
echo "  counts before: $before"
marker="restore_drill_$(date +%s)"
$W d1 execute "$DEV_DB" --remote --command "INSERT INTO settings (key, value) VALUES ('$marker', 'x')" >/dev/null
during=$(q "$DEV_DB" "SELECT COUNT(*) AS n FROM settings WHERE key = '$marker'")
[ "$during" = '[{"n":1}]' ] && pass "marker row written to $DEV_DB" || fail "marker row was not written"
sleep ${DRILL_WAIT:-5}
start=$(date +%s)
yes | $W d1 time-travel restore "$DEV_DB" --bookmark="$b0" >/dev/null 2>&1 || true
secs=$(( $(date +%s) - start ))
after=$(q "$DEV_DB" "$count_sql")
gone=$(q "$DEV_DB" "SELECT COUNT(*) AS n FROM settings WHERE key = '$marker'")
[ "$gone" = '[{"n":0}]' ] && pass "after restore the marker row is gone (restored to the earlier point)" || fail "marker still present: restore did not happen"
[ "$after" = "$before" ] && pass "row counts identical after restore: $after" || fail "counts differ: before $before, after $after"
echo "  restore took about ${secs}s"

say "Summary"
printf '%s\n' "${RESULTS[@]}"
printf '\nScreenshot this summary and send it to Claude. No production data was changed.\n'
