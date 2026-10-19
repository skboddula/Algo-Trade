import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  Clock,
  LineChart,
  Link2,
  RefreshCw,
  Settings,
  Trash2,
  TrendingUp,
  User,
} from 'lucide-react'
import { AppLogo } from '@/components/ui/app-logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { InfoTooltip } from '@/components/ui/tooltip'
import {
  useDaemon,
  type DaemonController,
  type StopAction,
} from '@/hooks/useDaemon'
import { DAEMON_USER_ID } from '@/lib/daemon'
import { cn, getUpcomingIndexExpiry } from '@/lib/utils'
import type { MarketSnapshot, UnderlyingSymbol } from '@/lib/types'
import { formatPrice } from '@/pages/daemon/format'
import { DaemonLiveTradesPage } from '@/pages/daemon/live-trades'
import { DaemonStrategiesPage } from '@/pages/daemon/strategies'
import { DaemonHistoryPage } from '@/pages/daemon/history'
import { BrokerAccountsPage } from '@/pages/broker-accounts'
import { ProfilePage } from '@/pages/profile'

export type DaemonPage =
  | 'live-trades'
  | 'strategies'
  | 'history'
  | 'broker-accounts'
  | 'profile'
  | 'settings'

const PATH_PAGE_MAP: Record<string, DaemonPage> = {
  '/': 'live-trades',
  '/live-trades': 'live-trades',
  '/strategies': 'strategies',
  '/history': 'history',
  '/broker-accounts': 'broker-accounts',
  '/profile': 'profile',
  '/settings': 'settings',
}

const PAGE_PATH_MAP: Record<DaemonPage, string> = {
  'live-trades': '/live-trades',
  strategies: '/strategies',
  history: '/history',
  'broker-accounts': '/broker-accounts',
  profile: '/profile',
  settings: '/settings',
}

function pageFromLocation(): DaemonPage {
  const pathname = window.location.pathname
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  return PATH_PAGE_MAP[normalized] ?? 'live-trades'
}

/**
 * Stop confirm: with open positions a plain stop would leave them
 * unsupervised, so the window asks before proceeding.
 */
function StopConfirmDialog({
  symbols,
  onResolve,
}: {
  symbols: UnderlyingSymbol[]
  onResolve: (action: StopAction) => void
}) {
  const count = symbols.length
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stop-confirm-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
        <h2
          id="stop-confirm-title"
          className="text-base font-semibold text-foreground"
        >
          Stop the bot?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {count} open position{count === 1 ? '' : 's'} on the daemon (
          {symbols.join(', ')}). Squaring off sells at current prices before
          stopping.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onResolve('cancel')}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => onResolve('stop-only')}>
            Stop only
          </Button>
          <Button variant="destructive" onClick={() => onResolve('square-off')}>
            Square off &amp; stop
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The daemon's own window: the same shell as the cloud dashboard
 * (sidebar + ticker header + pages), but every panel reads live state from
 * the daemon on this origin (`/ws`, `/api/bot/*`, `/health`).
 */
export function DaemonApp() {
  const daemon = useDaemon()
  const [page, setPage] = useState<DaemonPage>(pageFromLocation)

  useEffect(() => {
    const onPop = () => setPage(pageFromLocation())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (next: DaemonPage) => {
    setPage(next)
    const target = PAGE_PATH_MAP[next]
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target)
    }
  }

  return (
    <div className="flex min-h-dvh bg-background">
      <DaemonSidebar page={page} onNavigate={navigate} daemon={daemon} />
      <div className="flex flex-col flex-1 min-w-0">
        <DaemonHeader daemon={daemon} />
        <main className="flex-1 overflow-y-auto">
          {page === 'live-trades' && (
            <DaemonLiveTradesPage daemon={daemon} onNavigate={navigate} />
          )}
          {page === 'strategies' && <DaemonStrategiesPage daemon={daemon} />}
          {page === 'history' && <DaemonHistoryPage daemon={daemon} />}
          {page === 'broker-accounts' && <BrokerAccountsPage daemon={daemon} />}
          {page === 'profile' && <ProfilePage daemon={daemon} />}
          {page === 'settings' && (
            <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm p-6">
              Settings — coming soon
            </div>
          )}
        </main>
      </div>

      {daemon.stopPrompt && (
        <StopConfirmDialog
          symbols={daemon.stopPrompt.symbols}
          onResolve={(action) => void daemon.resolveStop(action)}
        />
      )}
    </div>
  )
}

// ── Sidebar (cloud markup, daemon data) ───────────────────────────────────────

const NAV_ITEMS: { id: DaemonPage; icon: React.ReactNode; label: string }[] = [
  { id: 'live-trades', icon: <TrendingUp size={16} />, label: 'Live Trades' },
  { id: 'strategies', icon: <LineChart size={16} />, label: 'Strategies' },
  { id: 'history', icon: <Clock size={16} />, label: 'Trade History' },
]

const BOTTOM_ITEMS: { id: DaemonPage; icon: React.ReactNode; label: string }[] =
  [
    { id: 'broker-accounts', icon: <Link2 size={16} />, label: 'Brokers' },
    { id: 'profile', icon: <User size={16} />, label: 'Profile' },
    { id: 'settings', icon: <Settings size={16} />, label: 'Settings' },
  ]

function DaemonSidebar({
  page,
  onNavigate,
  daemon,
}: {
  page: DaemonPage
  onNavigate: (page: DaemonPage) => void
  daemon: DaemonController
}) {
  const openPositions = daemon.status?.userState
    ? Object.values(daemon.status.userState.positions ?? {}).filter(Boolean)
        .length
    : 0

  const status = daemonStatusSummary(daemon)

  return (
    <aside className="flex flex-col w-[220px] min-h-dvh bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="flex items-center px-4 py-4 h-14">
        <AppLogo size="sm" showText />
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Main nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const badge =
            item.id === 'live-trades' && openPositions > 0
              ? String(openPositions)
              : undefined
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer',
                page === item.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              {item.icon}
              <span className="flex-1 text-left">{item.label}</span>
              {badge && (
                <span className="flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-semibold rounded-full bg-primary/20 text-primary">
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Bottom nav */}
      <nav className="px-2 py-3 space-y-0.5">
        {BOTTOM_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer',
              page === item.id
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Daemon status */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full', status.dot)} />
          <span className="text-xs text-muted-foreground">{status.text}</span>
        </div>
      </div>
    </aside>
  )
}

function daemonStatusSummary(daemon: DaemonController): {
  dot: string
  text: string
} {
  const feed = daemon.health?.feed
  if (!daemon.connected) {
    return { dot: 'bg-destructive', text: 'Daemon link down' }
  }
  const wsOpen = feed?.ws?.state === 'open'
  if (feed && (wsOpen || feed.source === 'mock')) {
    return {
      dot: 'bg-success animate-pulse',
      text: `Connected · ${feed.source}`,
    }
  }
  if (feed) {
    return { dot: 'bg-amber-500', text: `Feed ${feed.ws?.state ?? 'starting'}` }
  }
  return { dot: 'bg-muted-foreground', text: 'Connecting to daemon…' }
}

// ── Header (cloud markup: ticker + market bar) ────────────────────────────────

interface TickerItem {
  name: string
  symbol: UnderlyingSymbol | null
  label: string
  change: string
  pct: string
  up: boolean
}

const TICKER_DEFS: { name: string; symbol: UnderlyingSymbol | null }[] = [
  { name: 'NIFTY 50', symbol: 'NIFTY 50' },
  { name: 'BANK NIFTY', symbol: 'BANKNIFTY' },
  { name: 'FIN NIFTY', symbol: 'FINNIFTY' },
  { name: 'SENSEX', symbol: null },
  { name: 'INDIA VIX', symbol: null },
]

function buildTicker(snapshots: DaemonController['status']): TickerItem[] {
  return TICKER_DEFS.map(({ name, symbol }) => {
    const snap: MarketSnapshot | undefined = symbol
      ? snapshots?.snapshots?.[symbol]
      : undefined
    if (!snap) {
      return { name, symbol, label: '—', change: '—', pct: '', up: true }
    }
    const open = snap.candles[0]?.[1] ?? snap.spotPrice
    const change = snap.spotPrice - open
    const pct = open ? (change / open) * 100 : 0
    const sign = change >= 0 ? '+' : ''
    return {
      name,
      symbol,
      label: formatPrice(snap.spotPrice),
      change: `${sign}${change.toFixed(2)}`,
      pct: `${sign}${pct.toFixed(2)}%`,
      up: change >= 0,
    }
  })
}

// NSE: 9:15–15:40 IST on weekdays (extended derivatives close)
function getMarketInfo() {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 6=Sat
  const total = now.getHours() * 60 + now.getMinutes()
  const isWeekday = day >= 1 && day <= 5
  const isOpen = isWeekday && total >= 555 && total <= 930

  let hint: string
  if (isOpen) {
    const closeAt = new Date(now)
    closeAt.setHours(15, 30, 0, 0)
    const diff = closeAt.getTime() - now.getTime()
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    hint = h > 0 ? `closes in ${h}h ${m}m` : `closes in ${m}m`
  } else {
    const next = new Date(now)
    next.setSeconds(0, 0)
    if (total >= 930 || !isWeekday) next.setDate(next.getDate() + 1)
    while (next.getDay() === 0 || next.getDay() === 6)
      next.setDate(next.getDate() + 1)
    next.setHours(9, 15, 0, 0)
    const diff = next.getTime() - now.getTime()
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    hint =
      h >= 24
        ? `opens ${next.toLocaleDateString('en-IN', { weekday: 'short' })} 9:15 AM`
        : h > 0
          ? `opens in ${h}h ${m}m`
          : `opens in ${m}m`
  }
  return { isOpen, hint }
}

function DaemonHeader({ daemon }: { daemon: DaemonController }) {
  const { isOpen: isMarketOpen, hint: marketHint } = getMarketInfo()
  const [showLogs, setShowLogs] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const logsRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (logsRef.current && !logsRef.current.contains(event.target as Node)) {
        setShowLogs(false)
      }
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const dateStr = now.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

  const ticker = buildTicker(daemon.status)
  const tickerItems = [...ticker, ...ticker]
  const feed = daemon.health?.feed
  const age = feed?.ws?.lastMessageAgeMs ?? null
  const isLive =
    daemon.connected &&
    (feed?.ws?.state === 'open' || feed?.source === 'mock') &&
    (age === null || age < 15_000)

  const state = daemon.status?.userState?.state ?? 'IDLE'
  const mode = daemon.status?.userState?.executionMode ?? '—'
  const recentLogs = [...daemon.logs].reverse().slice(0, 30)

  return (
    <header className="flex flex-col border-b border-border bg-card shrink-0">
      {/* Indices ticker */}
      <div className="ticker-marquee border-b border-border px-4 py-2 sm:px-6">
        <div className="ticker-marquee__track">
          {tickerItems.map((idx, index) => {
            const expiry = getUpcomingIndexExpiry(idx.name)
            const showExpiry = idx.name !== 'INDIA VIX'
            return (
              <div
                key={`${idx.name}-${index}`}
                className="flex items-center gap-2 shrink-0 whitespace-nowrap"
              >
                <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                  {idx.name}
                  {showExpiry && (
                    <InfoTooltip
                      content={`${idx.name} Expiry: ${expiry.fullLabel} (${expiry.relativeText})`}
                      iconSize={11}
                    />
                  )}
                </span>
                <span className="text-xs font-semibold text-foreground">
                  {idx.label}
                </span>
                {idx.pct && (
                  <span
                    className={`text-xs font-medium ${idx.up ? 'text-success' : 'text-destructive'}`}
                  >
                    {idx.change} ({idx.pct})
                  </span>
                )}
              </div>
            )
          })}
          {isLive && (
            <span className="shrink-0 whitespace-nowrap flex items-center gap-1 text-xs text-muted-foreground pl-1 pr-5 sm:pr-6">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              live
            </span>
          )}
        </div>
      </div>

      {/* Main header bar */}
      <div className="flex items-center justify-between px-6 h-14">
        <div className="flex items-center gap-3">
          <Badge
            variant={isMarketOpen ? 'success' : 'secondary'}
            className="text-xs"
          >
            {isMarketOpen ? '● NSE OPEN' : '○ NSE CLOSED'}
          </Badge>
          {marketHint && (
            <span className="text-xs text-muted-foreground">{marketHint}</span>
          )}
          <span className="text-sm text-muted-foreground">{dateStr}</span>
          <span className="text-sm font-mono font-medium text-foreground">
            {timeStr}
          </span>
          {!daemon.connected && (
            <span className="text-xs text-destructive">
              daemon link reconnecting…
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            title="Refresh data"
            onClick={() => daemon.refresh()}
          >
            <RefreshCw size={15} />
          </Button>

          <div className="relative" ref={logsRef}>
            <Button
              variant="ghost"
              size="icon"
              title="Activity log"
              onClick={() => setShowLogs(!showLogs)}
            >
              <Bell size={15} />
              {daemon.logs.some((l) => l.level === 'error') && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
              )}
            </Button>

            {showLogs && (
              <div className="absolute right-0 mt-2 w-80 bg-popover text-popover-foreground border border-border rounded-md shadow-md z-50 overflow-hidden flex flex-col">
                <div className="p-3 font-semibold border-b border-border flex justify-between items-center text-sm">
                  <span>Activity</span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={daemon.clearLogs}
                      title="Clear activity"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {recentLogs.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      No activity yet
                    </div>
                  ) : (
                    recentLogs.map((n) => (
                      <div
                        key={n.id}
                        className={`p-3 border-b border-border last:border-b-0 text-sm transition-colors ${n.level === 'error' ? 'bg-destructive/5' : ''}`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <span
                            className={`font-semibold ${n.level === 'error' ? 'text-destructive' : 'text-foreground'}`}
                          >
                            {n.source}
                          </span>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {new Date(n.ts).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                        </div>
                        <div className="text-muted-foreground mt-1 text-xs">
                          {n.msg}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 ml-2 relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="w-8 h-8 rounded-full overflow-hidden border border-border bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary hover:opacity-85 transition-opacity cursor-pointer focus:outline-none"
            >
              <span>DW</span>
            </button>

            {showMenu && (
              <div className="absolute right-0 top-10 w-56 bg-popover text-popover-foreground border border-border rounded-md shadow-md z-50 overflow-hidden flex flex-col p-2">
                <div className="px-3 py-2 border-b border-border mb-1 text-left">
                  <p className="text-xs font-semibold text-foreground truncate">
                    Daemon Window
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {DAEMON_USER_ID} · {state} · {mode}
                  </p>
                </div>
                <a
                  href="/auth/upstox/start"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded text-xs text-foreground hover:bg-accent transition-colors"
                  onClick={() => setShowMenu(false)}
                >
                  <RefreshCw size={12} />
                  Refresh Upstox token
                </a>
                <a
                  href="/health"
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded text-xs text-foreground hover:bg-accent transition-colors"
                  onClick={() => setShowMenu(false)}
                >
                  Daemon /health
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
