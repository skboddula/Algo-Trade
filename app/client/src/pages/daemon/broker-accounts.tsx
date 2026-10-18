import { useState } from 'react'
import { KeyRound, Link2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { DaemonController } from '@/hooks/useDaemon'
import { daemonApi } from '@/lib/daemon'

export function DaemonBrokerAccountsPage({
  daemon,
}: {
  daemon: DaemonController
}) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [alsoMaster, setAlsoMaster] = useState(false)

  const feed = daemon.health?.feed
  const liveFeed = Boolean(feed && feed.source !== 'mock')

  const saveToken = async () => {
    if (!token.trim()) {
      setFeedback('Paste an Upstox access token first.')
      return
    }
    setSaving(true)
    setFeedback(null)
    try {
      await daemonApi.setToken(token.trim(), alsoMaster)
      setToken('')
      setFeedback(
        alsoMaster
          ? 'Token saved — live orders and the market-data feed now use it.'
          : 'Order token saved — live orders now use it.',
      )
      daemon.refresh()
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'Failed to save the token.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 p-6 min-w-0 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Broker Accounts
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          The Upstox account the daemon ingests data and places live orders with
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Link2 size={14} className="text-primary" />
              Upstox — daemon token
              <Badge
                variant={liveFeed ? 'success' : 'secondary'}
                className="ml-auto text-xs"
              >
                {liveFeed ? 'Connected' : 'Mock mode'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`w-2 h-2 rounded-full ${liveFeed ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
              />
              <span>
                {liveFeed
                  ? 'Live market feed active on the master token.'
                  : 'No live feed — the daemon runs on synthetic data.'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Transport:{' '}
                <span className="font-mono text-foreground">
                  {feed?.source ?? '—'}
                </span>{' '}
                · WS:{' '}
                <span className="font-mono text-foreground">
                  {feed?.ws?.state ?? '—'}
                </span>
              </p>
              <p>
                The token expires daily (~03:30 IST). Refresh it with the Upstox
                login flow — the daemon swaps it into the live feed instantly.
              </p>
            </div>
            <a
              href="/auth/upstox/start"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity w-fit"
            >
              <RefreshCw size={14} />
              Refresh Upstox token (browser login)
            </a>
            <p className="text-[11px] text-muted-foreground">
              One-time setup: set{' '}
              <span className="font-mono">UPSTOX_API_KEY</span>,{' '}
              <span className="font-mono">UPSTOX_API_SECRET</span> and{' '}
              <span className="font-mono">UPSTOX_REDIRECT_URI</span> in{' '}
              <span className="font-mono">app/core/.env</span>, and register the
              redirect URL in your Upstox app.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <KeyRound size={14} className="text-primary" />
              Order token (live orders)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <p className="text-xs text-muted-foreground">
              By default live orders authenticate with the master token above.
              Paste a separate Upstox access token here to override it for this
              user (the token takes precedence for every order).
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Upstox access token"
                autoComplete="off"
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
              />
              <Button
                size="sm"
                className="h-9 shrink-0"
                disabled={saving}
                onClick={() => void saveToken()}
              >
                {saving ? 'Saving…' : 'Save token'}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={alsoMaster}
                onChange={(e) => setAlsoMaster(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              Also refresh the market-data feed with this token
            </label>
            {feedback && (
              <p
                className={`text-xs ${feedback.includes('saved') ? 'text-success' : 'text-destructive'}`}
              >
                {feedback}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              The token is stored in the daemon's SQLite state and never leaves
              this machine.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck size={14} className="text-primary" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ul className="text-xs text-muted-foreground space-y-1.5 list-disc pl-4">
            <li>
              The window is served on{' '}
              <span className="font-mono">127.0.0.1:3000</span> only — loopback,
              no network exposure.
            </li>
            <li>
              Browser requests from any non-localhost origin are rejected (403);
              CLI tools and OAuth redirects are unaffected.
            </li>
            <li>
              API secrets live in{' '}
              <span className="font-mono">app/core/.env</span> (0600) and are
              only sent from this machine to Upstox.
            </li>
            <li>
              Never run a second daemon against the same Upstox account — both
              would place live orders.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
