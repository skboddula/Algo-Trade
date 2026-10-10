# systemd user services — Algo-Trade

Manual-start services (NOT enabled at boot by design).

## Install

```bash
mkdir -p ~/.config/systemd/user
cp algo-trade-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

## Daily use

```bash
systemctl --user start   algo-trade-daemon algo-trade-dashboard   # start
systemctl --user status  algo-trade-daemon                        # check
systemctl --user stop    algo-trade-daemon                        # stop (open positions left unsupervised!)
systemctl --user restart algo-trade-daemon                        # after code/config changes
journalctl --user -u algo-trade-daemon -f                          # live logs
```

## Notes

- User services stop when you log out of the session (locking the screen is
  fine — logout/reboot is what stops them). Enable linger
  (`sudo loginctl enable-linger $USER`) only if you want them to survive
  logout.
- The daemon binds 127.0.0.1:3000; the dashboard 127.0.0.1:5173 (the
  Tailscale serve proxy targets 127.0.0.1 — do not change the host).
- The daemon reads `app/core/.env` (Upstox token etc.). Fresh tokens are
  pushed by the dashboard after each OAuth login.

## Dashboard fallback behaviour (by design)

The dashboard probes the daemon's `/health` every 10s:

- **Daemon reachable** → daemon controller (Start/Stop act on the daemon). The
  Strategies page shows a green "Daemon mode" banner — this is your visual
  confirmation of which controller is active.
- **Daemon unreachable** → the dashboard silently falls back to the legacy
  in-tab browser bot (separate D1 paper account).

⚠️ **Safety rule:** if the daemon is down and you click Start, you start the
in-tab browser bot — a SECOND bot with its own account. If the daemon returns,
both would trade and both would send Telegram alerts. Check the header badge
on ANY page: `● DAEMON` (green) = daemon controller; `● BROWSER` (amber) =
fallback active — plus an amber "Browser mode" banner on the Strategies page
shows the exact fix command. If it says BROWSER, first run:

```bash
systemctl --user start algo-trade-daemon
```
