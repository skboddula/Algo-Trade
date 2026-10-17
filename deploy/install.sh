#!/usr/bin/env bash
#
# Install the Algo-Trade daemon as a systemd user service on this machine.
# Re-runnable: rebuilds the daemon, refreshes the unit, and restarts the service.
#
#   deploy/install.sh
#
# Environment:
#   SERVICE_NAME  override the installed unit name (default algo-trade-daemon-v2)
#
# Installs/refreshes `algo-trade-daemon-v2`; if the legacy `algo-trade-daemon`
# unit is still present, it is stopped and disabled so only one daemon runs.
#
# Works on any Linux host with systemd (laptop, home server, cloud VM — see
# deploy/README.md for the VM variant).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_CORE="$REPO_ROOT/app/core"
UNIT_TEMPLATE="$REPO_ROOT/deploy/systemd/algo-trade-daemon-v2.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="${SERVICE_NAME:-algo-trade-daemon-v2}"
UNIT_DST="$UNIT_DIR/$SERVICE_NAME.service"
LEGACY_SERVICE_NAME="${LEGACY_SERVICE_NAME:-algo-trade-daemon}"

# ── Preflight checks ─────────────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "✗ node not found in PATH. Install Node.js >= 24 first." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then
  echo "✗ Node >= 24 required (found $("$NODE_BIN" --version)). The daemon uses the built-in node:sqlite module." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "✗ systemctl not found — this installer targets Linux with systemd." >&2
  exit 1
fi

if command -v loginctl >/dev/null 2>&1; then
  if [[ "$(loginctl show-user "$USER" -p Linger 2>/dev/null || true)" == "Linger=no" ]]; then
    echo "⚠ systemd lingering is disabled — the daemon would stop when you fully log out."
    echo "  Enable it once with:  sudo loginctl enable-linger $USER"
  fi
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "▸ Building daemon (app/core)…"
(cd "$APP_CORE" && yarn install && yarn build)

# ── Config ───────────────────────────────────────────────────────────────────
if [[ ! -f "$APP_CORE/.env" ]]; then
  cp "$APP_CORE/.env.sample" "$APP_CORE/.env"
  chmod 600 "$APP_CORE/.env"
  echo "▸ Created $APP_CORE/.env from the sample."
  echo "  Fill in PRIMARY_UPSTOX_TOKEN (Upstox access token) and optionally TELEGRAM_* keys."
fi

# ── Install unit ─────────────────────────────────────────────────────────────
echo "▸ Installing systemd user unit → $UNIT_DST"
mkdir -p "$UNIT_DIR"
sed -e "s|__APP_CORE_DIR__|$APP_CORE|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$UNIT_TEMPLATE" > "$UNIT_DST"
systemctl --user daemon-reload

# ── Retire the legacy unit ───────────────────────────────────────────────────
# Older deployments used `algo-trade-daemon` (pointing at a legacy checkout,
# same port). Stop + disable it so exactly one daemon ever talks to the
# Upstox account; the unit file is kept and can be re-enabled manually.
if [[ "$SERVICE_NAME" != "$LEGACY_SERVICE_NAME" ]] && systemctl --user cat "$LEGACY_SERVICE_NAME" >/dev/null 2>&1; then
  if systemctl --user is-enabled "$LEGACY_SERVICE_NAME" >/dev/null 2>&1 \
     || systemctl --user is-active "$LEGACY_SERVICE_NAME" >/dev/null 2>&1; then
    if systemctl --user disable --now "$LEGACY_SERVICE_NAME" >/dev/null 2>&1; then
      echo "▸ Legacy unit $LEGACY_SERVICE_NAME stopped + disabled (file kept)."
    else
      echo "⚠ Found legacy unit $LEGACY_SERVICE_NAME but could not disable it — check: systemctl --user status $LEGACY_SERVICE_NAME"
    fi
  fi
fi

# ── Start (only when the config looks usable) ────────────────────────────────
if grep -qE '^[[:space:]]*PRIMARY_UPSTOX_TOKEN=.+' "$APP_CORE/.env" \
   || grep -qE '^[[:space:]]*MOCK_MODE=true' "$APP_CORE/.env"; then
  echo "▸ Enabling + (re)starting $SERVICE_NAME…"
  systemctl --user enable "$SERVICE_NAME" >/dev/null
  systemctl --user restart "$SERVICE_NAME"
  sleep 1
  systemctl --user --no-pager --full status "$SERVICE_NAME" | head -n 12 || true
  echo
  echo "▸ Health check:"
  if curl -fsS "http://127.0.0.1:3000/health"; then
    echo
    echo "✅ Done. The bot now runs in the background — you can close all browser tabs."
  else
    echo "⚠ Health check failed — inspect logs: journalctl --user -u $SERVICE_NAME -n 50 --no-pager"
  fi
else
  echo "⚠ $APP_CORE/.env has no PRIMARY_UPSTOX_TOKEN (and MOCK_MODE is not true)."
  echo "  The unit is installed but was NOT started. Edit the .env, then run:"
  echo "      systemctl --user enable --now $SERVICE_NAME"
fi
