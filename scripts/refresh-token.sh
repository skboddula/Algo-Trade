#!/usr/bin/env bash
#
# Refresh the master Upstox access token and restart the daemon.
#
# Upstox access tokens expire daily (~03:30 IST). Each trading day:
#   1. Generate a fresh token via the Upstox login flow
#   2. scripts/refresh-token.sh <UPSTOX_ACCESS_TOKEN>
#
# Updates PRIMARY_UPSTOX_TOKEN in app/core/.env (timestamped backup kept
# alongside), restarts the systemd user service, and runs a health check.
#
# Environment:
#   SERVICE_NAME  systemd user unit name  (default algo-trade-daemon)
#   DAEMON_URL    daemon base URL         (default http://127.0.0.1:3000)
#
set -euo pipefail

TOKEN="${1:?usage: refresh-token.sh <upstox-access-token>}"
SERVICE_NAME="${SERVICE_NAME:-algo-trade-daemon}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:3000}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/app/core/.env"

[[ -f "$ENV_FILE" ]] || { echo "✗ missing $ENV_FILE — run deploy/install.sh first." >&2; exit 1; }

BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

# Tokens are alphanumeric; '|' delimiter keeps sed safe
if grep -qE '^[[:space:]]*PRIMARY_UPSTOX_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^[[:space:]]*PRIMARY_UPSTOX_TOKEN=.*|PRIMARY_UPSTOX_TOKEN=${TOKEN}|" "$ENV_FILE"
else
  printf '\nPRIMARY_UPSTOX_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
fi
echo "▸ Updated PRIMARY_UPSTOX_TOKEN in $ENV_FILE (backup: $BACKUP)"

if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "▸ Restarting $SERVICE_NAME…"
  systemctl --user restart "$SERVICE_NAME"
  sleep 2
  echo "▸ Health check:"
  if curl -fsS "$DAEMON_URL/health"; then
    echo
    echo "✅ Token refreshed — the feed will resume within a few seconds."
  else
    echo "⚠ Health check failed — inspect: journalctl --user -u $SERVICE_NAME -n 50 --no-pager"
  fi
else
  echo "⚠ $SERVICE_NAME is not installed as a systemd user service — restart the daemon manually to pick up the token."
fi
