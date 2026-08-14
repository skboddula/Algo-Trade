# Algo-Trade Backend Daemon (`app/core`)

High-performance, low-memory **Fastify** trading daemon and **Master Market Ingestor** for Indian Equity & Derivatives markets (NIFTY / BANKNIFTY / FINNIFTY).

Designed to run 24/7 on a **GCP Always Free `e2-micro` VM** (or AWS Lightsail / Oracle Cloud) with a dedicated **Static IP** for broker API whitelisting.

---

## 🌟 Key Architecture & Capabilities

1. **Master 1-API Market Ingestion ("Fan-Out" Ingestion)**:
   - Polls/ingests market quotes, candles, and option chains **once every 2 seconds** for all symbols.
   - Computes technical indicators (EMA, VWAP, Supertrend, RSI, BB) and V5 scoring matrix **once in shared memory**.
   - **Zero broker rate limits**: 1 master fetch serves 10, 50, or 100 connected user dashboards simultaneously.
2. **Multi-Tenant Headless Bot Execution**:
   - Manages independent user bot states (`IDLE` ➔ `RUNNING` ➔ `ORDERED` ➔ `STOPPED`).
   - Evaluates each user's unique strategy configuration, lot size, and risk rules.
   - Continuously supervises **trailing stop losses**, **hard stop daily limits**, and **15:15 IST EOD auto square-offs** server-side.
   - Users can safely close their browsers or shut down laptops without halting active position supervision.
3. **Broker Static IP Gateway**:
   - Outbound live orders to Upstox API (`/v2/order/place`) originate from the VM's registered Static IP address.
   - Integrated Paper Trading ledger with 0.1% simulated slippage and real-time PnL accounting.
4. **Timezone Determinism**:
   - Built-in `timeUtils` ensures strict `Asia/Kolkata` (UTC+05:30) market hours (09:15–15:30 IST) and cutoff math even when hosted on US/EU cloud instances (e.g. `us-central1`).

---

## 🛠️ API & WebSocket Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Server health check and Node.js process memory metrics. |
| `GET` | `/api/bot/status?userId=<ID>` | Fetches master market indicators, scores, and the user's active trades. |
| `POST` | `/api/bot/start` | Arms user bot server-side (`{ userId, executionMode: 'paper' \| 'live' }`). |
| `POST` | `/api/bot/stop` | Disarms user bot server-side (preserves open position supervision). |
| `POST` | `/api/bot/config` | Updates user strategy parameters (`{ userId, config: StrategyConfig }`). |
| `POST` | `/api/bot/token` | Configures user's broker access token for live trading. |
| `POST` | `/api/bot/paper-reset` | Resets user's paper trading balance to ₹1,00,000. |
| `POST` | `/api/bot/trade/exit` | Manually exits an active open position (`{ userId, symbol }`). |
| `WS` | `/ws?userId=<ID>` | Real-time WebSocket stream for live market ticks and user state updates. |

---

## 🚀 Getting Started & Local Development

### 1. Install Dependencies
```bash
yarn install
```

### 2. Configure Environment
Create a `.env` file based on `.env.sample`:
```bash
cp .env.sample .env
```

### 3. Run Development Server
```bash
yarn dev
```

### 4. Run Test Suite
```bash
yarn test
```

### 5. Build for Production
```bash
yarn build
```

---

## ☁️ Deployment on GCP Always Free VM (`e2-micro`)

1. **Create Compute Instance**:
   - Instance Type: `e2-micro` (2 vCPUs, 1 GB RAM)
   - Region: `us-central1`, `us-east1`, or `us-west1` (Eligible for Google Cloud Always Free)
   - OS: Ubuntu 22.04 LTS / Debian 12
2. **Assign Static IP**:
   - Reserve a Standard External Static IPv4 in GCP VPC Network > External IP Addresses.
   - Attach the Static IP to your `e2-micro` instance.
   - Register this Static IP in the **Upstox Developer Portal**.
3. **Deploy with PM2**:
   ```bash
   git clone https://github.com/your-org/Algo-Trade.git
   cd Algo-Trade/app/core
   yarn install
   yarn build
   npm install -g pm2
   pm2 start dist/server.js --name "algo-trade-backend"
   pm2 startup
   pm2 save
   ```
