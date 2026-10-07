# Auth0 Setup Guide — When You Can't Find the Application

## Problem
You can't find the "algo-trade" application in your Auth0 dashboard.

## Possible Reasons

1. **Wrong tenant** — You're looking at a different Auth0 tenant than `algo-trade.us.auth0.com`
2. **App named differently** — The app might be called "Algo-Trade SPA", "trading-dashboard", etc.
3. **App doesn't exist yet** — You need to create it
4. **Browser/cache issue** — Try incognito/private mode

---

## Step 1: Go Directly to the Correct Tenant

Open this URL in your browser:

```
https://algo-trade.us.auth0.com/
```

This bypasses the auth0.com landing page and takes you directly to **your** tenant where the app should exist.

**Bookmark this:** `https://algo-trade.us.auth0.com/`

---

## Step 2: Check the Application Name

Once logged into `algo-trade.us.auth0.com`, look for an app with one of these names:

| Likely Name | What to Look For |
|---|---|
| `algo-trade` | Simple, obvious name |
| `algo-trade-spa` | SPA = Single Page App (React) |
| `Algo-Trade` | With capital letters |
| `trading-dashboard` | Descriptive name |
| `AlgoTrade` | No hyphens |

**If you don't see any of those**, continue to Step 3.

---

## Step 3: Verify by Client ID (Most Reliable)

Look at the application's **Settings** page and check the **Client ID**. It should match:

```
8wwVnXMFevBSIyaJvHJnDU9hWkm6iuhq
```

This is the exact value in your `.env.local` file:
```
VITE_AUTH0_CLIENT_ID=8wwVnXMFevBSIyaJvHJnDU9hWkm6iuhq
```

**If the Client ID matches, you've found the right app — proceed to Step 4.**

**If the Client ID doesn't match any app**, continue to Step 5.

---

## Step 4: Add the Tailscale Callback URL

Once you've found the correct app, go to **Settings** and add these three URLs (copy-paste exactly):

| Field | Value |
|---|---|
| **Allowed Callback URLs** | `https://cachyos.tailac81d6.ts.net:5175` |
| **Allowed Logout URLs** | `https://cachyos.tailac81d6.ts.net:5175` |
| **Allowed Web Origins** | `https://cachyos.tailac81d6.ts.net:5175` |

> **Important:** Click **Save** at the bottom. Without saving, the Callback URL mismatch error will persist.

After saving, log out and go to:
```
https://cachyos.tailac81d6.ts.net:5175/
```
Click "Login with Google" — it should work.

---

## Step 5: If No Application Exists — Create It

If you don't see any application in the tenant `algo-trade.us.auth0.com`:

1. **Click "Applications"** → **"Create Application"** in the left menu
2. **Name it:** `algo-trade`
3. **Select type:** `Single Page Application (SPA)` ⚠️ **Critical** — must be SPA, not Regular Web App
4. Click **Create**

After creating, you'll be taken to the app's **Settings** page automatically. Then:

5. **Add the three URLs** from Step 4 above
6. **Note the Client ID** — it will start with `8wwVnXMFevBSIyaJvHJnDU9hWkm6iuhq` (or similar). Copy it to your `.env.local` if it's different.
7. **Note the Domain** — should be `algo-trade.us.auth0.com`. Copy to `.env.local` if different.
8. Save.

You now have the app configured. Proceed to Step 6.

---

## Step 6: Update `.env.local` (If Client ID Changed)

If the Client ID from Step 3 or 5 is **different** from what's in `.env.local`:

```
VITE_AUTH0_DOMAIN=algo-trade.us.auth0.com     # keep as-is
VITE_AUTH0_CLIENT_ID=<NEW_CLIENT_ID_HERE>     # replace with the actual value
VITE_AUTH0_AUDIENCE=https://algo-trade.us.auth0.com/api/v2/  # keep as-is
```

Then restart the dev server:
```bash
# Stop current dev server (Ctrl+C)
# Restart
yarn dev
```

---

## Step 7: Test the Full Flow

1. Go to `https://cachyos.tailac81d6.ts.net:5175/`
2. Click "Login with Google"
3. You should be redirected to Google's login page, then back to the dashboard
4. The "Callback URL mismatch" error should be gone

---

## Troubleshooting Checklist

| If you encounter... | Try this... |
|---|---|
| "Invalid domain" error | Make sure `Allowed Web Origins` includes `https://cachyos.tailac81d6.ts.net:5175` exactly |
| Login redirects but stays on login page | Check that `Allowed Callback URLs` has `https://cachyos.tailac81d6.ts.net:5175` (no trailing slash variations) |
| Google consent screen says "requesting scope" | This is normal — just click "Continue" |
| Still getting callback mismatch | Double-check all three URL fields are exactly `https://cachyos.tailac81d6.ts.net:5175` |

---

## Need More Help?

If still stuck, run:
```bash
# Check current env values
cat /home/shiva/Downloads/Algo-Trade/app/client/.env.local
```

And share the output — I can tell you exactly which app to look at or what to create.