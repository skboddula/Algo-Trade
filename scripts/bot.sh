#!/usr/bin/env bash
#
# Convenience wrapper around the Algo-Trade daemon REST API.
#
#   scripts/bot.sh health
#   scripts/bot.sh status
#   scripts/bot.sh start [paper|live]
#   scripts/bot.sh stop
#   scripts/bot.sh config <file.json>              # partial StrategyConfig JSON
#   scripts/bot.sh token <upstox-access-token>     # per-user token for live orders
#   scripts/bot.sh exit "NIFTY 50" [reason]
#   scripts/bot.sh paper-reset
#   scripts/bot.sh help
#
# Environment:
#   DAEMON_URL      daemon base URL          (default http://127.0.0.1:3000)
#   DAEMON_USER_ID  user/tenant id           (default default_user)
#   DAEMON_API_KEY  optional x-api-key       (for hardened deployments)
#
set -euo pipefail

DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:3000}"
DAEMON_USER_ID="${DAEMON_USER_ID:-default_user}"

AUTH_ARGS=()
if [[ -n "${DAEMON_API_KEY:-}" ]]; then
  AUTH_ARGS=(-H "x-api-key: ${DAEMON_API_KEY}")
fi

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "${AUTH_ARGS[@]}" \
      -H 'Content-Type: application/json' -d "$body" "$DAEMON_URL$path" | pretty
  else
    curl -sS -X "$method" "${AUTH_ARGS[@]}" "$DAEMON_URL$path" | pretty
  fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  health)
    api GET /health
    ;;
  status)
    api GET "/api/bot/status?userId=${DAEMON_USER_ID}"
    ;;
  start)
    mode="${1:-paper}"
    api POST /api/bot/start "{\"userId\":\"${DAEMON_USER_ID}\",\"executionMode\":\"${mode}\"}"
    ;;
  stop)
    api POST /api/bot/stop "{\"userId\":\"${DAEMON_USER_ID}\"}"
    ;;
  config)
    file="${1:?usage: bot.sh config <file.json>}"
    [[ -f "$file" ]] || { echo "✗ config file not found: $file" >&2; exit 1; }
    api POST /api/bot/config "{\"userId\":\"${DAEMON_USER_ID}\",\"config\":$(cat "$file")}"
    ;;
  token)
    tok="${1:?usage: bot.sh token <upstox-access-token>}"
    api POST /api/bot/token "{\"userId\":\"${DAEMON_USER_ID}\",\"token\":\"${tok}\"}"
    ;;
  exit)
    symbol="${1:?usage: bot.sh exit \"<SYMBOL>\" [reason]}"
    reason="${2:-Manual exit via bot.sh}"
    api POST /api/bot/trade/exit "{\"userId\":\"${DAEMON_USER_ID}\",\"symbol\":\"${symbol}\",\"reason\":\"${reason}\"}"
    ;;
  paper-reset)
    api POST /api/bot/paper-reset "{\"userId\":\"${DAEMON_USER_ID}\"}"
    ;;
  help | --help | -h | "")
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "✗ Unknown command: $cmd" >&2
    echo "  Run: scripts/bot.sh help" >&2
    exit 1
    ;;
esac
