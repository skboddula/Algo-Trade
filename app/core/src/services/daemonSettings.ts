// Window-managed daemon settings (persisted in SQLite via StateStore).
//
// These are the "account details" the daemon window manages without editing
// app/core/.env: the Upstox OAuth app credentials used by the daily token
// refresh flow, plus the master token itself (so a token entered in the
// window — or refreshed via OAuth — survives daemon restarts and reboots).
//
// Precedence: explicit route options (tests) → daemon settings → environment.
// The .env file remains a fallback for headless deployments, so an existing
// setup keeps working untouched.

export const DAEMON_SETTING_KEYS = {
  upstoxApiKey: 'upstox.apiKey',
  upstoxApiSecret: 'upstox.apiSecret',
  upstoxRedirectUri: 'upstox.redirectUri',
  upstoxMasterToken: 'upstox.masterToken',
} as const

/**
 * Minimal persistence surface for daemon settings. StateStore satisfies it
 * structurally; tests can pass a light in-memory stand-in.
 */
export interface SettingsStore {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}
