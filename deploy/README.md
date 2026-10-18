# Always-On Deployment Guide

Run the Algo-Trade bot so it keeps working **without any browser tab open** — you can close the
tab, close the laptop lid, or log out. The daemon keeps supervising positions, trailing stops and
the 15:15 IST square-off on its own.

Everything here is **host-agnostic**: the same steps work on this laptop today and on a cloud VM
later (see [Moving to a cloud VM](#moving-to-a-cloud-vm-later)).

---

## What you get

| Piece | Purpose |
| :--- | :--- |
| `app/core` (Fastify daemon) | The actual bot — headless, no browser needed |
| `deploy/install.sh` | Builds it and installs a systemd user service that auto-restarts on crash |
| `app/core/data/algo-trade.sqlite` | Durable state: bot state, trailing-SL peaks, paper ledger — survives restarts/reboots |
| `scripts/bot.sh` | Start/stop/status/exit/config/token from the terminal |
| `scripts/refresh-token.sh` | Daily token refresh + restart in one command |
| Dashboard window (`http://127.0.0.1:3000`) | React UI served by the daemon itself — live scores, positions, paper ledger, bot controls |
| Telegram alerts (optional) | Notified on feed down/recovered, trades opened/closed, daemon start/stop |

**What survives a reboot:** bot running state, open positions (with trailing-SL peak), daily trade
counts, cooldowns, and the paper ledger. When the daemon comes back up it resumes supervising any
open positions immediately.

---

## First-time install (this laptop)

Prerequisites — already true on this machine, verify on any new host:

```bash
node --version                 # must be >= 24
systemctl --user status        # systemd user session must work
loginctl show-user $USER -p Linger    # want: Linger=yes (else: sudo loginctl enable-linger $USER)
```

Also ensure the machine does not suspend:

- Laptop lid: `sudo systemctl status systemd-logind` → lid should be ignored (`HandleLidSwitch=ignore`)
- KDE: System Settings → Power Management → *Do nothing* on lid close, disable "Suspend session" on AC and battery

Then:

```bash
cd /path/to/Algo-Trade

# 1. Configure
cp app/core/.env.sample app/core/.env
#    → edit app/core/.env: set PRIMARY_UPSTOX_TOKEN (Upstox access token),
#      optionally TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for alerts.
#      Optional: MARKET_FEED_SOURCE=ws enables the Upstox Market Data Feed V3
#      WebSocket transport (live index ticks + 1-min candles, with a REST
#      option-chain refresh) instead of the default REST LTP polling.
#      WS tuning: OPTION_CHAIN_REFRESH_MS (default 15000 ms; 0 disables) and
#      ATM_WINDOW_STRIKES (default 5; 0 disables the tick-level window).
#      Default binding is 127.0.0.1 — keep it that way unless you add auth.

# 2. Build + install the service (also builds the dashboard window;
#    skip the UI with: SKIP_DASHBOARD=1 ./deploy/install.sh)
./deploy/install.sh

# 3. Arm the bot (paper by default)
./scripts/bot.sh start paper
./scripts/bot.sh status
```

That's it. You can now close every browser tab. The service starts automatically on boot
(`systemctl --user enable` was done by the installer). Open <http://127.0.0.1:3000> for the
daemon's own dashboard window (see [Dashboard window](#dashboard-window)) — optional, the bot
runs without it.

> **Note:** `deploy/install.sh` installs `algo-trade-daemon-v2` and replaces any existing unit
> with that name (back up customizations first). If the legacy `algo-trade-daemon` unit from an
> older checkout is still present, the installer stops and disables it so only one daemon runs.
> Make sure only **one** daemon runs per Upstox account — stop any other host/checkout first (see
> the warning in [Daily routine](#daily-routine-2-commands-30-seconds)).

---

## Daily routine (~30 seconds)

Upstox access tokens expire **daily around 03:30 IST**. Each trading morning: refresh the token,
then make sure the bot is armed.

### 1. Refresh the token — browser (recommended)

Open the daemon window (**Broker Accounts**) and click **Refresh token via Upstox login**
(direct link: `http://127.0.0.1:3000/auth/upstox/start`).

Log in to Upstox. The daemon exchanges the code, saves the new token to `app/core/.env`
(timestamped backup kept) **and** to its SQLite settings, and hot-swaps the live feed — no
restart, nothing to copy. A token pasted in the window with “Also refresh the market-data feed”
is likewise persisted, so it survives daemon restarts and reboots.

One-time setup (either path works):

- **Daemon window**: Broker Accounts → *Master feed token* card → **Set Upstox API credentials**
  (API key, API secret, redirect URI). Stored in the daemon's SQLite (`app/core/data`, 0600) and
  never returned to the browser — only masked hints.
- **`.env` (headless hosts / legacy)**: set `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, and
  `UPSTOX_REDIRECT_URI` in `app/core/.env`.

Either way, register the same redirect URI in your Upstox app
(<https://account.upstox.com/developer/apps>). The API secret stays on this machine — it is only
ever sent from the daemon process to Upstox during the exchange.

### 2. Refresh the token — CLI (fallback / headless hosts)

```bash
# Generate a new access token via the Upstox login flow, then:
./scripts/refresh-token.sh "<NEW_UPSTOX_ACCESS_TOKEN>"
```

### 3. Verify + arm

```bash
( cd app/core && yarn feed-check )   # optional: verify the fresh token end-to-end
./scripts/bot.sh status              # check state: RUNNING / ORDERED
./scripts/bot.sh start paper         # if it is not running (paper or live)
```

If you ever run two daemons against the same Upstox account simultaneously, you can double-trade —
always `systemctl --user stop algo-trade-daemon-v2` on one host before starting another.

---

## Controlling the bot

```bash
./scripts/bot.sh health                 # is the daemon alive?
./scripts/bot.sh status                 # market snapshots + your bot state + paper trades
./scripts/bot.sh start paper            # arm in paper mode (or: start live)
./scripts/bot.sh stop                   # disarm new entries (open positions keep being supervised)
./scripts/bot.sh exit "NIFTY 50"        # manually close a position
./scripts/bot.sh config my-config.json  # partial StrategyConfig update
./scripts/bot.sh paper-reset            # reset paper balance to ₹1,00,000
```

Raw API equivalents (curl) and the full endpoint list are in `app/core/README.md`.

**Live-order authentication (daemon-only mode):** live entries/exits authenticate with the same
daily account token you refresh in the routine above (the master ingestion token) — no separate
per-user token is needed. If you ever connect a different Upstox account, set a per-user token via
`POST /api/bot/token` (or `./scripts/bot.sh token "<TOKEN>"`); it takes precedence for that user.

### Service management

```bash
systemctl --user status  algo-trade-daemon-v2
systemctl --user restart algo-trade-daemon-v2
systemctl --user stop    algo-trade-daemon-v2
journalctl --user -u algo-trade-daemon-v2 -f          # live logs
journalctl --user -u algo-trade-daemon-v2 --since today
```

The service has `Restart=on-failure`, so a crashed daemon comes back automatically in ~5 seconds.

An older `algo-trade-daemon` unit (legacy checkout) may still exist from earlier installs. The
installer stops and disables it but keeps the file; re-enable it only if you intentionally switch
back: `systemctl --user enable --now algo-trade-daemon` (never while `algo-trade-daemon-v2` runs).

---

## Dashboard window

The daemon serves its own React UI on the same origin — one process, no cloud, no CORS:

    http://127.0.0.1:3000

- **Live Window** — start/stop (paper/live), reset paper, feed health (transport, last-message
  age, reconnects, chain calls), per-symbol signal + score panels, indicators, 1-min chart and
  ATM ±4 option chain, open positions with manual exits, recent paper trades, activity log.
- **Trade History** — the daemon's full paper ledger with realized P&L and win rate.
- **Strategy Config** — edit the running daemon's thresholds/risk config; saving applies it
  immediately and persists in SQLite.

The **Refresh Upstox token** button in the window header opens the browser OAuth flow (same as the
[daily routine](#1-refresh-the-token--browser-recommended) link).

Rebuild after pulling client changes, then restart so the daemon serves the new asset hashes:

```bash
( cd app/client && yarn build:daemon )
systemctl --user restart algo-trade-daemon-v2
```

Notes:

- `deploy/install.sh` builds the window automatically; skip it with `SKIP_DASHBOARD=1 ./deploy/install.sh`.
- The daemon serves `app/client/dist`; override the location with `DASHBOARD_DIR` in `app/core/.env`.
  Without a build the daemon starts in API-only mode — the bot never needs the window.
- This window is *the daemon's state*. The Cloudflare-hosted dashboard (`yarn dev` / `yarn deploy`
  in `app/client`) is a separate product: it keeps its own browser-side engine, worker ledger and
  Upstox token, and does not command the daemon.

---

## Alerts (optional but recommended)

Set both keys in `app/core/.env` and restart the service:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
```

You will then get a Telegram message for:

- 🟢 daemon started / 🔴 daemon stopping
- 🔴 market feed down after ~10s of failed polls (likely expired token) / 🟢 feed recovered
- 🟢 position opened / 🔵 position closed (symbol, price, reason)

Leave the keys blank to disable alerts entirely.

---

## Data, backup and restore

All durable state lives in one SQLite file:

```
app/core/data/algo-trade.sqlite        (+ -wal / -shm companions while running)
```

The file is created with `0600` permissions and **contains your broker token** — treat it as a
secret and never commit it (the directory is git-ignored).

Backup (while the daemon is running it is safest to use SQLite's own copy):

```bash
systemctl --user stop algo-trade-daemon-v2
cp app/core/data/algo-trade.sqlite "$HOME/algo-trade-backup-$(date +%F).sqlite"
systemctl --user start algo-trade-daemon-v2
```

Restore: stop the service, copy the file back to `app/core/data/algo-trade.sqlite`, start again.

To start fresh, stop the service and delete the file (and its `-wal`/`-shm` companions).

---

## Troubleshooting

### Feed preflight (`yarn feed-check`)

Verifies the live-data path against real Upstox endpoints, in order: token +
V3 authorize → WebSocket handshake (subscribe + protobuf decode) → REST quotes
for the three indices → option chain (nearest expiry, full mapping, plus one
`UpstoxFeedV3Source.acquire()` snapshot end-to-end). Safe to run outside market
hours — expect a `market_info` frame plus an `initial_feed` snapshot carrying
last-session values instead of live ticks.

```bash
cd app/core
yarn feed-check                        # token read from app/core/.env
FEED_CHECK_SECONDS=30 yarn feed-check  # watch the wire for longer
FEED_CHECK_VERBOSE=1 yarn feed-check   # dump decoded frames (debugging)
```

Exit code 0 = token, feed handshake, quotes and chain all good.

### Live feed telemetry (calibration)

While the WS feed is active, the daemon emits one `feed-stats` JSON line per
minute (`journalctl --user -u algo-trade-daemon-v2 -f | grep feed-stats`). The
same counters are available on demand:

```bash
./scripts/bot.sh health | jq .feed     # or: curl -s 127.0.0.1:3000/health | jq .feed
```

Counters: decoded frames by type, index/option tick counts, subscribed option
keys (current/peak), reconnects, and option-chain REST calls, failures and
latency (`lastMessageAgeMs` doubles as a freshness probe). Use them to tune
`OPTION_CHAIN_REFRESH_MS` and `ATM_WINDOW_STRIKES`.

| Symptom | Check |
| :--- | :--- |
| Service not running | `systemctl --user status algo-trade-daemon-v2` + `journalctl --user -u algo-trade-daemon-v2 -n 50` |
| `❌ Fatal: ... PRIMARY_UPSTOX_TOKEN` | First boot has neither an env token nor a window-saved one — fill `app/core/.env`, then `systemctl --user restart algo-trade-daemon-v2`. (After the first run, tokens pasted in the window / refreshed via OAuth survive restarts without touching `.env`.) |
| Feed down alert / 401s from Upstox | Token expired → browser refresh (`/auth/upstox/start`) or `./scripts/refresh-token.sh "<NEW_TOKEN>"` |
| Browser refresh says "not configured" | Save `UPSTOX_API_KEY`/`UPSTOX_API_SECRET`/`UPSTOX_REDIRECT_URI` on the daemon Broker Accounts page (or in `app/core/.env`), register that redirect URI in your Upstox app — window-saved credentials apply without a restart |
| Before enabling `MARKET_FEED_SOURCE=ws`, or odd feed behavior | `cd app/core && yarn feed-check` (see above) |
| Bot armed but no trades | Check `./scripts/bot.sh status` → state must be `RUNNING`; entries pause after `lastEntryTime` (default 15:15) and per-symbol daily trade caps |
| Service stops when you log out | `sudo loginctl enable-linger $USER` |
| Machine suspends on lid close | See prerequisites above (logind + PowerDevil) |
| Laptop asleep → no ticks | Disable suspend on AC *and* battery; battery works as a built-in UPS if power drops |

---

## Moving to a cloud VM later

The layout is deliberately host-agnostic — no path is baked into the code:

1. Rsync the repo (without `node_modules`, `dist`, `data`) to the VM and install Node >= 24 + yarn.
2. Copy `app/core/.env` (or re-create it) and optionally the SQLite file from `app/core/data/`.
3. Install as a **system** service instead of a user service:

   ```bash
   sudo cp deploy/systemd/algo-trade-daemon-v2.service /etc/systemd/system/
   sudo sed -i "s|__APP_CORE_DIR__|/opt/Algo-Trade/app/core|g; s|__NODE_BIN__|$(command -v node)|g" \
       /etc/systemd/system/algo-trade-daemon-v2.service
   sudo sed -i "s|WantedBy=default.target|WantedBy=multi-user.target|" \
       /etc/systemd/system/algo-trade-daemon-v2.service
   sudo systemctl daemon-reload && sudo systemctl enable --now algo-trade-daemon-v2
   ```

4. Set `HOST=0.0.0.0` in `.env` **only** together with a firewall / reverse proxy. The API has no
   authentication yet — do not expose it without adding auth (API key + CORS allowlist) first.

Same `scripts/` helpers work against the remote by setting `DAEMON_URL` (and later
`DAEMON_API_KEY` once hardening lands).

---

## Security notes

- The daemon API is currently **unauthenticated**. Keep it bound to `127.0.0.1` (the default).
  Reaching it from your phone over Tailscale is possible, but add the API-key/CORS hardening first.
- Browser cross-site protection is on: requests carrying an `Origin` header from anything other
  than loopback (`127.0.0.1`, `localhost`, `::1`) are rejected with `403`. Add comma-separated
  `ALLOWED_ORIGINS` in `app/core/.env` to permit extra origins explicitly. WebSocket state frames
  never include broker tokens.
- `app/core/.env` and `app/core/data/algo-trade.sqlite` both contain broker tokens — keep them
  `0600` (default from the installer) and out of git.
- Never run two daemons on two hosts against the same Upstox account at the same time.
