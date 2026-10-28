#!/usr/bin/env bash
# One-time setup of the isolated staging Preview for the v12-frontend branch.
#
#   npx wrangler login          # once, in a browser
#   bash scripts/setup-staging.sh
#
# What it does (nothing here touches the production Worker, its database, its secrets or its settings):
#   1. finds or creates the empty development database "usmle100-dev" and writes its id into [[previews.d1_databases]];
#   2. asks for STAGING/TEST credentials and stores them as Preview secrets (typed values are hidden, never printed,
#      never written to disk or git). A Stripe key that is not a test key (sk_test_/rk_test_) is refused;
#   3. creates or updates the Preview "v12-frontend" with `npx wrangler preview` and prints its URL;
#   4. checks the Preview: it answers, is hidden from search engines, rejects unsigned Stripe webhooks, and is
#      running on the development database.
# Re-running it is safe. Press Enter to skip any optional credential.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_DB_ID="d1ff7fee-bf81-42d8-863a-652e3476716c"
DEV_DB_NAME="usmle100-dev"
PREVIEW_NAME="${PREVIEW_NAME:-v12-frontend}"
W="npx --yes wrangler"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" != "main" ] || die "You are on main. Staging is set up from the development branch only."
$W whoami >/dev/null 2>&1 || die "Not signed in to Cloudflare. Run: npx wrangler login"

# ---- 1. Development database -------------------------------------------------------------------------
say "1/4  Development database ($DEV_DB_NAME)"
dev_id=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));const d=j.find(x=>x.name===process.argv[1]);process.stdout.write(d?d.uuid:"")})' "$DEV_DB_NAME")
if [ -z "$dev_id" ]; then
  $W d1 create "$DEV_DB_NAME" >/dev/null
  dev_id=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));const d=j.find(x=>x.name===process.argv[1]);process.stdout.write(d?d.uuid:"")})' "$DEV_DB_NAME")
  echo "Created $DEV_DB_NAME ($dev_id). It is empty; the Worker builds its tables on the first visit."
else
  echo "Found $DEV_DB_NAME ($dev_id)."
fi
[ -n "$dev_id" ] || die "Could not find or create $DEV_DB_NAME."
[ "$dev_id" != "$PROD_DB_ID" ] || die "The development database id equals the production id."
node -e '
const fs=require("fs");const [id]=process.argv.slice(1);let t=fs.readFileSync("wrangler.toml","utf8");
const block=/(\[\[previews\.d1_databases\]\][^\[]*?database_id\s*=\s*")[^"]*(")/;
if(!block.test(t)){console.error("No [[previews.d1_databases]] block in wrangler.toml");process.exit(1)}
fs.writeFileSync("wrangler.toml",t.replace(block,`$1${id}$2`));' "$dev_id"
grep -q "$PROD_DB_ID" <(sed -n '/\[\[previews.d1_databases\]\]/,/^$/p' wrangler.toml) && die "Preview database block points at production."
echo "wrangler.toml → previews database_id = $dev_id (commit this change on $branch)."

# ---- 2. Staging credentials (Preview secrets) ----------------------------------------------------------
say "2/4  Staging credentials (test/staging only; Enter skips)"
put_secret() { # name value
  printf '%s' "$2" | $W preview base-config secret put "$1" >/dev/null
  printf '%s' "$2" | $W preview secret put "$1" --name "$PREVIEW_NAME" >/dev/null 2>&1 || true # existing Preview, if any
  echo "  $1 saved."
}
ask() { # name prompt validator-regex
  local v; read -r -s -p "  $2: " v; echo
  [ -z "$v" ] && { echo "  $1 skipped."; return; }
  if [ -n "${3:-}" ] && ! [[ "$v" =~ $3 ]]; then echo "  $1 refused: that is not a test/staging value."; return; fi
  put_secret "$1" "$v"
}
ask STRIPE_SECRET_KEY "Stripe TEST secret key (sk_test_… or rk_test_…)" '^(sk|rk)_test_'
ask STRIPE_WEBHOOK_SECRET "Stripe TEST webhook signing secret for <preview URL>/stripe/webhook (whsec_…; add later if you have no endpoint yet)" '^whsec_'
read -r -p "  Bunny STAGING library id (numbers; not 785730, Enter to skip): " bunny_lib
if [ -n "$bunny_lib" ]; then
  [ "$bunny_lib" != "785730" ] || die "785730 is the live library. Create a separate staging library in Bunny first."
  node -e 'const fs=require("fs");let t=fs.readFileSync("wrangler.toml","utf8");t=t.replace(/(\[previews\.vars\][\s\S]*?BUNNY_LIBRARY_ID\s*=\s*")[^"]*(")/,`$1${process.argv[1]}$2`);fs.writeFileSync("wrangler.toml",t)' "$bunny_lib"
  ask BUNNY_TOKEN_KEY "Bunny STAGING library token authentication key"
  ask BUNNY_API_KEY "Bunny STAGING library API key"
fi
ask RESEND_API_KEY "Resend API key (a key limited to a test/staging sending domain)"
read -r -p "  Sender address for staging email (e.g. USMLE100 Staging <staging@your-domain>; Enter to skip): " email_from
[ -n "$email_from" ] && put_secret EMAIL_FROM "$email_from"

# ---- 3. Create / update the Preview ---------------------------------------------------------------------
say "3/4  Uploading Preview \"$PREVIEW_NAME\" (not production)"
out=$($W preview --name "$PREVIEW_NAME" 2>&1) || { echo "$out" | grep -v -i secret; die "wrangler preview failed."; }
url=$(echo "$out" | grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev[^ ]*' | head -1)
[ -n "$url" ] || { echo "$out" | grep -v -i secret; die "Could not read the Preview URL from wrangler's output."; }
echo "Preview URL: $url"

# ---- 4. Check it ----------------------------------------------------------------------------------------
say "4/4  Checks"
fail=0
code=$(curl -s -o /dev/null -w '%{http_code}' "$url/") ; [ "$code" = 200 ] && echo "  ok   home page answers 200" || { echo "  FAIL home page answered $code"; fail=1; }
robots=$(curl -s -D - -o /dev/null "$url/" | tr -d '\r' | grep -i '^x-robots-tag:' || true)
[[ "$robots" == *noindex* ]] && echo "  ok   hidden from search engines ($robots)" || { echo "  FAIL no X-Robots-Tag noindex (is ENVIRONMENT=preview?)"; fail=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "$url/stripe/webhook")
[ "$code" = 400 ] || [ "$code" = 503 ] && echo "  ok   unsigned Stripe webhook refused ($code)" || { echo "  FAIL unsigned Stripe webhook answered $code"; fail=1; }
mark=$($W d1 execute "$DEV_DB_NAME" --remote --json --command "SELECT value FROM settings WHERE key = 'db_environment'" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("[")));process.stdout.write(j[0].results[0]?.value??"")}catch{}})')
[ "$mark" = development ] && echo "  ok   $DEV_DB_NAME is marked development" || { echo "  FAIL $DEV_DB_NAME is marked '${mark:-nothing}'"; fail=1; }
[ $fail = 0 ] || die "Some checks failed (see above). Do not turn on preview builds yet."

say "Staging is ready: $url"
echo "Next: commit wrangler.toml on $branch, then turn on preview builds in Cloudflare (see LAUNCH.md §0)."
