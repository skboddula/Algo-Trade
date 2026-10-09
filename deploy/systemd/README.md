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
