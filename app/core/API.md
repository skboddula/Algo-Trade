# Algo-Trade Daemon API

The Fastify daemon exposes REST and WebSocket endpoints for remote monitoring and control. The browser dashboard (or any HTTP client) can connect to these endpoints to view live bot state, manage the bot, and fetch trade history.

## Base URL

```
http://localhost:3000  (default)
```

## Authentication

Currently no authentication — the daemon binds to `0.0.0.0:3000` by default. For production, restrict via firewall or set `HOST=127.0.0.1`.

CORS is restricted to allowed origins (default: `localhost:5173`, `localhost:3000`). Override with `ALLOWED_ORIGINS` env var.

---

## REST Endpoints

### Health

```http
GET /health
```

Returns server health and memory usage.

```json
{
  "status": "healthy",
  "timestamp": "2026-10-08T14:30:00.000Z",
  "memoryUsage": { "rss": 45678912 }
}
```

### Get Full Bot Status

```http
GET /api/bot/status?userId=default_user
```

Returns the complete state: market snapshots, user bot state, and paper trades.

```json
{
  "serverTime": "2026-10-08T14:30:00.000Z",
  "snapshots": {
    "NIFTY 50": {
      "spotPrice": 22650.5,
      "signal": { "signal": "BUY_CE", "confidence": "moderate" },
      "indicators": { "ema": "Buy", "adx": "Buy", "rsi": { "value": 55.2 } },
      "vrdData": { "vix": 14.2 }
    }
  },
  "userState": {
    "state": "RUNNING",
    "executionMode": "paper",
    "positions": { "NIFTY 50": null, "BANKNIFTY": null },
    "paperBalance": 10000000,
    "tradesCountToday": 2
  },
  "paperTrades": [...]
}
```

### Start the Bot

```http
POST /api/bot/start
Content-Type: application/json

{ "userId": "default_user", "executionMode": "paper" }
```

### Stop the Bot

```http
POST /api/bot/stop
Content-Type: application/json

{ "userId": "default_user" }
```

### Update Strategy Config

```http
POST /api/bot/config
Content-Type: application/json

{
  "userId": "default_user",
  "config": {
    "strongThreshold": 14,
    "moderateThreshold": 10,
    "maxProfitPct": 10,
    "maxLossPct": 5,
    "trailPct": 5,
    "useMultiTimeframe": true,
    "useMarketStream": true
  }
}
```

### Set Upstox Token

```http
POST /api/bot/token
Content-Type: application/json

{ "userId": "default_user", "token": "your_upstox_access_token" }
```

### Manual Exit (Force Close Position)

```http
POST /api/bot/trade/exit
Content-Type: application/json

{ "userId": "default_user", "symbol": "NIFTY 50", "reason": "Manual exit" }
```

### Reset Paper Account

```http
POST /api/bot/paper-reset
Content-Type: application/json

{ "userId": "default_user" }
```

---

## Analytics Endpoints

### Equity Curve

```http
GET /api/bot/equity-curve?userId=default_user
```

Returns trade history formatted for charting — running balance over time.

```json
{
  "points": [
    { "time": "Start", "balance": 100000, "pnl": 0 },
    { "time": "2026-10-08T09:39:22.000Z", "balance": 104608, "pnl": 4608 },
    { "time": "2026-10-08T11:15:00.000Z", "balance": 102400, "pnl": -2208 }
  ],
  "stats": {
    "startBalance": 100000,
    "currentBalance": 102400,
    "totalTrades": 2,
    "wins": 1,
    "losses": 1,
    "winRatePct": 50,
    "realizedPnl": 2400,
    "roiPct": 2.4,
    "maxDrawdownPct": 2.1
  }
}
```

### Signal History

```http
GET /api/bot/signals?limit=50
```

Returns recent signal evaluations across all symbols.

```json
{
  "count": 3,
  "signals": [
    {
      "symbol": "NIFTY 50",
      "signal": "BUY_CE",
      "confidence": "moderate",
      "bullScore": 12,
      "bearScore": 4,
      "timestamp": "2026-10-08T14:25:00.000Z"
    }
  ]
}
```

### Stream Health

```http
GET /api/bot/stream-health
```

Returns the WebSocket market stream status.

```json
{
  "status": "open",
  "vix": 14.2,
  "subscribedKeys": 0,
  "lastTickAt": 1791147858000
}
```

Status values: `idle`, `connecting`, `open`, `reconnecting`, `closed`

---

## WebSocket Endpoint

### Connect

```
ws://localhost:3000/ws?userId=default_user
```

### Messages received by the client

**Initial state on connect:**
```json
{
  "type": "INITIAL_STATE",
  "data": {
    "snapshots": { ... },
    "userState": { ... }
  }
}
```

**Market tick (every polling interval):**
```json
{
  "type": "MARKET_TICK",
  "data": {
    "timestamp": "2026-10-08T14:30:00.000Z",
    "snapshots": { "NIFTY 50": { ... } }
  }
}
```

**User state update (on position change, state change, etc.):**
```json
{
  "type": "USER_STATE_UPDATE",
  "data": { "state": "ORDERED", "positions": { ... } }
}
```

### Messages sent by the client

```json
{ "action": "START", "executionMode": "paper" }
{ "action": "STOP" }
{ "action": "CONFIG", "config": { "strongThreshold": 14 } }
```

---

## Quick Start (curl)

```bash
# Health check
curl http://localhost:3000/health

# Start the bot in paper mode
curl -X POST http://localhost:3000/api/bot/start \
  -H "Content-Type: application/json" \
  -d '{"userId": "default_user", "executionMode": "paper"}'

# Check status
curl "http://localhost:3000/api/bot/status?userId=default_user"

# Get equity curve
curl "http://localhost:3000/api/bot/equity-curve?userId=default_user"

# Stop the bot
curl -X POST http://localhost:3000/api/bot/stop \
  -H "Content-Type: application/json" \
  -d '{"userId": "default_user"}'
```
