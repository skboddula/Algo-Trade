import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Clock,
  LayoutDashboard,
  RefreshCw,
  Settings,
  WifiOff,
} from 'lucide-react'
import { AppLogo } from '@/components/ui/app-logo'
import { Separator } from '@/components/ui/separator'
import { useDaemon, type DaemonController } from '@/hooks/useDaemon'
import { DAEMON_SYMBOLS } from '@/lib/daemon'
import { formatAge, formatPrice } from '@/pages/daemon/format'
import { DaemonWindowPage } from '@/pages/daemon/window'
import { DaemonHistoryPage } from '@/pages/daemon/history'
import { DaemonConfigPage } from '@/pages/daemon/config'

type DaemonPage = 'window' | 'history' | 'config'

const PAGE_TITLES: Record<DaemonPage, string> = {
  window: 'Live Window',
  history: 'Trade History',
  config: 'Strategy Config',
}

function pageFromLocation(): DaemonPage {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/history') return 'history'
  if (path === '/config') return 'config'
  return 'window'
}

function pathForPage(page: DaemonPage): string {
  return page === 'window' ? '/' : `/${page}`
}

/**
 * Thin window over the daemon: served by the daemon itself (`build:daemon`),
 * every page reads live state from `/ws` + `/api/bot/*` on the same origin.
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
    const target = pathForPage(next)
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target)
    }
  }

  return (
    <div className="flex min-h-dvh bg-background">
      <DaemonSidebar
        page={page}
        onNavigate={navigate}
        connected={daemon.connected}
      />
      <div className="flex flex-col flex-1 min-w-0">
        <DaemonHeader daemon={daemon} title={PAGE_TITLES[page]} />
        <main className="flex-1 overflow-y-auto">
          {page === 'window' && <DaemonWindowPage daemon={daemon} />}
          {page === 'history' && <DaemonHistoryPage daemon={daemon} />}
          {page === 'config' && <DaemonConfigPage daemon={daemon} />}
        </main>
      </div>
    </div>
  )
}

function DaemonSidebar({
  page,
  onNavigate,
  connected,
}: {
  page: DaemonPage
  onNavigate: (page: DaemonPage) => void
  connected: boolean
}) {
  const items: { id: DaemonPage; label: string; icon: LucideIcon }[] = [
    { id: 'window', label: 'Live Window', icon: LayoutDashboard },
    { id: 'history', label: 'Trade History', icon: Clock },
    { id: 'config', label: 'Strategy Config', icon: Settings },
  ]

  return (
    <aside className="flex flex-col w-[220px] min-h-dvh bg-sidebar border-r border-sidebar-border shrink-0">
      <div className="flex items-center px-4 py-4 h-14">
        <AppLogo size="sm" showText />
      </div>
      <Separator className="bg-sidebar-border" />
      <nav className="flex flex-col gap-1 p-2">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onNavigate(id)}
            className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
              page === id
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-3 space-y-1.5">
        <Separator className="bg-sidebar-border mb-2" />
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? 'bg-success' : 'bg-destructive animate-pulse'
            }`}
          />
          {connected ? 'Daemon connected' : 'Reconnecting to daemon…'}
        </div>
        <p className="text-[10px] text-muted-foreground/70">
          Headless engine · this window is read/control only
        </p>
      </div>
    </aside>
  )
}

function DaemonHeader({
  daemon,
  title,
}: {
  daemon: DaemonController
  title: string
}) {
  const snapshots = daemon.status?.snapshots

  return (
    <header className="flex items-center gap-4 h-14 px-4 border-b border-border bg-card/40 shrink-0">
      <div className="flex items-center gap-2">
        <Activity size={16} className="text-primary" />
        <span className="text-sm font-semibold">{title}</span>
      </div>

      <div className="hidden md:flex items-center gap-4 ml-2">
        {DAEMON_SYMBOLS.map((symbol) => (
          <div key={symbol} className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {symbol === 'NIFTY 50' ? 'NIFTY' : symbol}
            </span>
            <span className="text-xs font-semibold tabular-nums">
              {formatPrice(snapshots?.[symbol]?.spotPrice)}
            </span>
          </div>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <FeedBadge daemon={daemon} />
        <a
          href="/auth/upstox/start"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Open the Upstox login flow to refresh today's account token"
        >
          <RefreshCw size={12} />
          Refresh Upstox token
        </a>
      </div>
    </header>
  )
}

function FeedBadge({ daemon }: { daemon: DaemonController }) {
  const feed = daemon.health?.feed
  const age = feed?.ws?.lastMessageAgeMs ?? null
  const wsOpen = feed?.ws?.state === 'open'
  const fresh = age !== null && age < 15_000

  let dotClass = 'bg-muted-foreground/40'
  let label = feed?.source ? `feed ${feed.source}` : 'feed —'
  if (!daemon.connected) {
    dotClass = 'bg-destructive animate-pulse'
    label = 'daemon offline'
  } else if (wsOpen && fresh) {
    dotClass = 'bg-success'
    label = `feed ${feed?.source ?? ''} · ${formatAge(age)}`
  } else if (wsOpen) {
    dotClass = 'bg-warning'
    label = `feed stale · ${formatAge(age)}`
  } else if (feed?.source?.includes('ws')) {
    dotClass = 'bg-warning'
    label = `ws ${feed.ws?.state ?? 'starting'}`
  }

  return (
    <div
      className="flex items-center gap-2 text-[11px] text-muted-foreground"
      title={
        feed?.ws
          ? `ticks idx ${feed.ws.ticks.index} / opt ${feed.ws.ticks.option} · reconnects ${feed.ws.reconnects}`
          : undefined
      }
    >
      {daemon.connected ? (
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
      ) : (
        <WifiOff size={12} className="text-destructive" />
      )}
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
