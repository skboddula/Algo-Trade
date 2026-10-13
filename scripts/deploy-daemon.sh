#!/bin/bash
# Deploy the daemon from a pinned git commit into an isolated runtime
# directory. The running daemon NEVER executes the working tree — branch
# checkouts and WIP edits cannot reach it until explicitly deployed.
#
# Usage: ./scripts/deploy-daemon.sh [commit-or-branch]   (default: HEAD)
set -euo pipefail

REPO=/home/shiva/Downloads/Algo-Trade
RUNTIME=/home/shiva/algo-trade-runtime
COMMIT=${1:-HEAD}
DATA_DIR="$REPO/app/core/data"          # canonical state — shared, never overwritten

RESOLVED=$(git -C "$REPO" rev-parse --short "$COMMIT")
echo "▸ deploying $RESOLVED → $RUNTIME"

mkdir -p "$RUNTIME"

# 1. Snapshot the exact commit (source only — node_modules symlinked, .env
#    and data/ live outside the archive by design).
git -C "$REPO" archive "$RESOLVED" | tar -x -C "$RUNTIME"

# 2. Symlink dependencies (identical package set — the commit pins the code,
#    the lockfile pins the deps).
ln -sfn "$REPO/app/core/node_modules" "$RUNTIME/app/core/node_modules"
ln -sfn "$REPO/node_modules" "$RUNTIME/node_modules" 2>/dev/null || true

# 3. Copy the environment (gitignored — never in git archive).
cp "$REPO/app/core/.env" "$RUNTIME/app/core/.env"
chmod 600 "$RUNTIME/app/core/.env"

# 4. State stays in the canonical data dir (the systemd unit pins DATA_DIR).
mkdir -p "$DATA_DIR"

echo "▸ deployed $RESOLVED"
echo "  runtime : $RUNTIME/app/core"
echo "  state   : $DATA_DIR (DATA_DIR via systemd unit)"
echo "  activate: systemctl --user restart algo-trade-daemon"
