#!/usr/bin/env bash
#
# withings-bootstrap.sh — one-time OAuth setup for the Withings -> Intervals Worker.
#
# Reads WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET from ../.dev.vars and helps you:
#   1. authorize  -> print the Withings consent URL
#   2. token <code> -> exchange the code, seed Cloudflare KV, and register the webhook
#   3. subscribe <userid> -> (re)register the webhook using the token already in KV
#   4. list <userid>      -> show current Withings notification subscriptions
#   5. revoke <userid> <callbackurl> -> remove a stale subscription
#
# The redirect URI and callback URL both default to the deployed Worker URL. The
# redirect URI MUST match what is registered in your Withings app (developer.withings.com).
# Override if needed:  WITHINGS_REDIRECT_URI=... WITHINGS_CALLBACK_URL=... ./scripts/withings-bootstrap.sh ...
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.dev.vars"

# KV namespace bound as MY_KV in wrangler.toml.
KV_NAMESPACE_ID="9220432e316743a9bdff3fde47ad51c8"

WORKER_URL="https://withings-webhook.christhonie.workers.dev"
REDIRECT_URI="${WITHINGS_REDIRECT_URI:-$WORKER_URL}"
CALLBACK_URL="${WITHINGS_CALLBACK_URL:-$WORKER_URL}"

# appli=1 -> body scale / weight & body-composition measurements.
APPLI=1

load_env() {
  [ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found. Fill it in first." >&2; exit 1; }
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  : "${WITHINGS_CLIENT_ID:?ERROR: WITHINGS_CLIENT_ID not set in .dev.vars}"
  : "${WITHINGS_CLIENT_SECRET:?ERROR: WITHINGS_CLIENT_SECRET not set in .dev.vars}"
}

kv_put_file() { # key, file
  wrangler kv key put "$1" --path "$2" --namespace-id "$KV_NAMESPACE_ID" --remote
}

cmd_authorize() {
  load_env
  local state; state="$(openssl rand -hex 8)"
  echo "1) Open this URL, log in, and authorize:"
  echo
  echo "https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${WITHINGS_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=user.metrics&state=${state}"
  echo
  echo "2) You will be redirected to ${REDIRECT_URI}?code=XXXX&state=${state}"
  echo "   Copy the value of 'code' from the address bar (it expires in 10 minutes)."
  echo "3) Run:  ./scripts/withings-bootstrap.sh token <code>"
}

cmd_token() {
  load_env
  local code="${1:?usage: token <authorization_code>}"
  echo "Exchanging authorization code for tokens..." >&2
  local resp
  resp="$(curl -s -X POST https://wbsapi.withings.net/v2/oauth2 \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'action=requesttoken' \
    --data-urlencode 'grant_type=authorization_code' \
    --data-urlencode "client_id=${WITHINGS_CLIENT_ID}" \
    --data-urlencode "client_secret=${WITHINGS_CLIENT_SECRET}" \
    --data-urlencode "code=${code}" \
    --data-urlencode "redirect_uri=${REDIRECT_URI}")"

  local status; status="$(echo "$resp" | jq -r '.status')"
  if [ "$status" != "0" ]; then
    echo "ERROR: token exchange failed (status=$status):" >&2
    echo "$resp" | jq . >&2
    exit 1
  fi

  local userid access refresh expires_in token_type expires_at now
  userid="$(echo "$resp"     | jq -r '.body.userid')"
  access="$(echo "$resp"     | jq -r '.body.access_token')"
  refresh="$(echo "$resp"    | jq -r '.body.refresh_token')"
  expires_in="$(echo "$resp" | jq -r '.body.expires_in')"
  token_type="$(echo "$resp" | jq -r '.body.token_type')"
  now="$(date +%s)"
  expires_at=$(( now + expires_in ))

  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  jq -n \
    --arg a "$access" --arg r "$refresh" --argjson e "$expires_at" \
    --arg t "$token_type" --arg u "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{access_token:$a, refresh_token:$r, expires_at:$e, token_type:$t, updated_at:$u}' > "$tmp"

  kv_put_file "token_data_${userid}" "$tmp"
  printf '%s' "$refresh" > "$tmp"
  kv_put_file "refresh_${userid}" "$tmp"

  echo "✅ Seeded KV for userid=${userid} (access token valid ${expires_in}s; auto-refreshed thereafter)."
  echo "$userid" > "$ROOT_DIR/.withings-userid"

  echo "Registering webhook subscription..." >&2
  subscribe_with_token "$access"
}

# Register the webhook using a known-good access token.
subscribe_with_token() {
  local access="$1"
  local resp
  resp="$(curl -s -X POST https://wbsapi.withings.net/notify \
    -H "Authorization: Bearer ${access}" \
    --data-urlencode 'action=subscribe' \
    --data-urlencode "callbackurl=${CALLBACK_URL}" \
    --data-urlencode "appli=${APPLI}")"
  echo "$resp" | jq .
  local status; status="$(echo "$resp" | jq -r '.status')"
  if [ "$status" = "0" ]; then
    echo "✅ Webhook subscribed: ${CALLBACK_URL} (appli=${APPLI})."
  else
    echo "⚠️  Subscribe returned status=$status — review the response above." >&2
  fi
}

# Pull the current access token out of KV for the given user.
access_from_kv() {
  local userid="$1"
  wrangler kv key get "token_data_${userid}" --namespace-id "$KV_NAMESPACE_ID" --remote 2>/dev/null \
    | jq -r '.access_token'
}

cmd_subscribe() {
  local userid="${1:?usage: subscribe <userid>}"
  local access; access="$(access_from_kv "$userid")"
  [ -n "$access" ] && [ "$access" != "null" ] || { echo "ERROR: no token in KV for userid=$userid (run 'token' first)" >&2; exit 1; }
  subscribe_with_token "$access"
}

cmd_list() {
  local userid="${1:?usage: list <userid>}"
  local access; access="$(access_from_kv "$userid")"
  [ -n "$access" ] && [ "$access" != "null" ] || { echo "ERROR: no token in KV for userid=$userid" >&2; exit 1; }
  curl -s -X POST https://wbsapi.withings.net/notify \
    -H "Authorization: Bearer ${access}" \
    --data-urlencode 'action=list' \
    --data-urlencode "appli=${APPLI}" | jq .
}

cmd_revoke() {
  local userid="${1:?usage: revoke <userid> <callbackurl>}"
  local url="${2:?usage: revoke <userid> <callbackurl>}"
  local access; access="$(access_from_kv "$userid")"
  [ -n "$access" ] && [ "$access" != "null" ] || { echo "ERROR: no token in KV for userid=$userid" >&2; exit 1; }
  curl -s -X POST https://wbsapi.withings.net/notify \
    -H "Authorization: Bearer ${access}" \
    --data-urlencode 'action=revoke' \
    --data-urlencode "callbackurl=${url}" \
    --data-urlencode "appli=${APPLI}" | jq .
}

case "${1:-}" in
  authorize) shift; cmd_authorize "$@" ;;
  token)     shift; cmd_token "$@" ;;
  subscribe) shift; cmd_subscribe "$@" ;;
  list)      shift; cmd_list "$@" ;;
  revoke)    shift; cmd_revoke "$@" ;;
  *)
    cat >&2 <<EOF
Usage: $0 <command> [args]
  authorize                      Print the Withings consent URL
  token <code>                   Exchange code -> seed KV -> subscribe webhook
  subscribe <userid>             (Re)register the webhook from the KV token
  list <userid>                  List current notification subscriptions
  revoke <userid> <callbackurl>  Remove a subscription
EOF
    exit 1 ;;
esac
