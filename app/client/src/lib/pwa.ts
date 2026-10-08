/**
 * PWA utilities: service worker registration, screen wake lock, and
 * visibility-change warnings for the always-on strategy bot.
 *
 * The strategy bot runs in the browser page's JS runtime. These utilities
 * maximise its uptime:
 * - Service worker caches the app shell for instant PWA startup and offline UI.
 * - Wake Lock API prevents the screen from sleeping (which suspends JS
 *   timers and kills WebSocket connections on mobile).
 * - Page Visibility warning alerts the user when the tab is hidden (browsers
 *   throttle timers in hidden tabs; a dedicated device is recommended for
 *   24/7 operation).
 */

// ─── Service Worker ─────────────────────────────────────────────────────────

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  if (
    window.location.protocol !== 'https:' &&
    window.location.hostname !== 'localhost'
  )
    return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((error) => {
        console.warn('Service worker registration failed:', error)
      })
  })
}

// ─── Wake Lock ──────────────────────────────────────────────────────────────

interface WakeLockSentinelLike {
  release: () => Promise<void>
  addEventListener: (type: string, listener: () => void) => void
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>
  }
}

let wakeLockSentinel: WakeLockSentinelLike | null = null

/**
 * Requests a screen wake lock to prevent the device from sleeping and
 * suspending the strategy bot's timers and WebSocket connections.
 * Re-requests automatically when the page becomes visible again after
 * being hidden (browsers auto-release wake locks on hidden pages).
 */
export async function requestWakeLock(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & NavigatorWithWakeLock
  if (!nav.wakeLock) return false
  if (wakeLockSentinel) return true

  try {
    wakeLockSentinel = await nav.wakeLock.request('screen')
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null
    })
    // Re-request when the page becomes visible again.
    document.addEventListener('visibilitychange', handleWakeLockVisibility)
    return true
  } catch {
    wakeLockSentinel = null
    return false
  }
}

export async function releaseWakeLock(): Promise<void> {
  document.removeEventListener('visibilitychange', handleWakeLockVisibility)
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release()
    } catch {
      // Already released.
    }
    wakeLockSentinel = null
  }
}

function handleWakeLockVisibility() {
  if (document.visibilityState === 'visible' && !wakeLockSentinel) {
    void requestWakeLock()
  }
}

// ─── Visibility Warning ────────────────────────────────────────────────────

export interface VisibilityWarningOptions {
  onHidden?: (message: string) => void
  onVisible?: () => void
}

/**
 * Logs a warning when the page becomes hidden while the strategy bot is
 * running. Browsers throttle timers in hidden tabs and may disconnect
 * WebSocket connections; the user should keep the tab visible on a dedicated
 * device for reliable signal generation.
 */
export function setupVisibilityWarning(
  options: VisibilityWarningOptions,
): () => void {
  const handler = () => {
    if (document.visibilityState === 'hidden') {
      options.onHidden?.(
        'dashboard tab is hidden — timers may be throttled by the browser; keep the tab visible for reliable signal polling',
      )
    } else {
      options.onVisible?.()
    }
  }
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}
