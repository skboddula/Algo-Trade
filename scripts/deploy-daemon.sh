#!/usr/bin/env bash
# Deploy the always-on daemon from the current working tree: build, restart,
# verify health, print the pinned commit.
#
# Usage: ./scripts/deploy-daemon.sh [--with-client]
#   --with-client  also rebuild the dashboard window (app/client build:daemon)
#
# NOTE: the daemon currently runs from this working tree (systemd unit
# algo-trade-daemon-v2, /etc/systemd/user). A pinned-runtime deploy — the
# daemon executes an isolated git-archive snapshot and never sees WIP edits —
# is the next deploy-hardening step (see docs/reviews/daemon-review-remediation.md).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  WARNING: working tree has uncommitted changes — deploying WIP state"
fi

SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git branch --show-current)"
echo "▸ deploying $SHA ($BRANCH)"

echo '▸ building core (tsc)…'
(cd app/core && npm run build)

if [ "${1:-}" = "--with-client" ]; then
  echo '▸ building dashboard window (client build:daemon)…'
  (cd app/client && yarn build:daemon)
fi

echo '▸ restarting algo-trade-daemon-v2…'
systemctl --user restart algo-trade-daemon-v2
sleep 6

STATE="$(systemctl --user is-active algo-trade-daemon-v2)"
echo "▸ service: $STATE"
if [ "$STATE" != "active" ]; then
  echo '✗ daemon failed to start — inspect: journalctl --user -u algo-trade-daemon-v2 -n 50'
  exit 1
fi

if curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null; then
  echo '▸ health: ok'
else
  echo '✗ health endpoint not responding'
  exit 1
fi

echo "✓ deployed $SHA"
