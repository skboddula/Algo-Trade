import { Activity, RefreshCw, ShieldCheck, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { DaemonController } from '@/hooks/useDaemon'
import { DAEMON_USER_ID } from '@/lib/daemon'
import { formatAge, formatClock, formatPaise } from './format'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}

function formatUptime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return '—'
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatMb(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—'
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export function DaemonProfilePage({ daemon }: { daemon: DaemonController }) {
  const userState = daemon.status?.userState
  const health = daemon.health
  const feed = health?.feed

  return (
    <div className="flex flex-col gap-5 p-6 min-w-0 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Profile
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Daemon session, service health and feed details
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <User size={14} className="text-primary" />
              Session
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <Row
              label="User"
              value={<span className="font-mono">{DAEMON_USER_ID}</span>}
            />
            <Row
              label="Bot state"
              value={
                <Badge
                  variant={
                    userState?.state === 'RUNNING'
                      ? 'success'
                      : userState?.state === 'ORDERED'
                        ? 'warning'
                        : userState?.state === 'STOPPED'
                          ? 'destructive'
                          : 'secondary'
                  }
                  className="text-[10px]"
                >
                  {userState?.state ?? '—'}
                </Badge>
              }
            />
            <Row
              label="Execution mode"
              value={userState?.executionMode ?? '—'}
            />
            <Row
              label="Trades today"
              value={String(userState?.tradesCountToday ?? 0)}
            />
            <Row
              label="Paper balance"
              value={formatPaise(userState?.paperBalance)}
            />
            <Row
              label="Thresholds (strong / moderate)"
              value={
                userState
                  ? `${userState.config.strongThreshold} / ${userState.config.moderateThreshold}`
                  : '—'
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity size={14} className="text-primary" />
              Service
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <Row label="Health" value={health?.status ?? '—'} />
            <Row
              label="Server time"
              value={formatClock(daemon.status?.serverTime)}
            />
            <Row
              label="Memory (heap)"
              value={formatMb(health?.memoryUsage?.heapUsed)}
            />
            <Row
              label="Memory (rss)"
              value={formatMb(health?.memoryUsage?.rss)}
            />
            <Row
              label="Feed source"
              value={<span className="font-mono">{feed?.source ?? '—'}</span>}
            />
            <Row
              label="WS state"
              value={
                <span className="font-mono">
                  {feed?.ws?.state ?? '—'} · uptime{' '}
                  {formatUptime(feed?.ws?.activeForMs)}
                </span>
              }
            />
            <Row
              label="Last message / reconnects"
              value={`${formatAge(feed?.ws?.lastMessageAgeMs)} · ${feed?.ws?.reconnects ?? 0}`}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck size={14} className="text-primary" />
            Token &amp; access
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-muted-foreground">
            The Upstox access token expires daily around 03:30 IST. Refresh it
            with the browser login flow — the daemon hot-swaps the feed without
            a restart.
          </p>
          <a
            href="/auth/upstox/start"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors w-fit"
          >
            <RefreshCw size={14} />
            Refresh Upstox token
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
