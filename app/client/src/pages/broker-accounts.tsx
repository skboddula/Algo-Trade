import type { BrokerAccount, BrokerPurpose } from '@/lib/types'
import { useEffect, useRef, useState } from 'react'
import {
  BarChart2,
  Bot,
  Check,
  ChevronRight,
  Copy,
  FlaskConical,
  KeyRound,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShoppingCart,
  Trash2,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  MCP_UPSTOX_URL,
  UPSTOX_MCP_DOCS_URL,
  UPSTOX_AUTH_URL,
  UPSTOX_DEVELOPER_APPS_URL,
  UPSTOX_DEVELOPER_APPS_BASE_URL,
  API_UPSTOX_PROFILE,
} from '@/lib/constants'
import {
  addAccount,
  getAccounts,
  getAccountConnectionState,
  removeAccount,
  updateAccount,
} from '@/lib/accounts'
import type { DaemonController } from '@/hooks/useDaemon'
import { daemonApi, type DaemonUpstoxSettings } from '@/lib/daemon'

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function openAuthPopup(url: string) {
  const w = Math.round(window.screen.width * 0.9)
  const h = Math.round(window.screen.height * 0.9)
  const left = Math.round((window.screen.width - w) / 2)
  const top = Math.round((window.screen.height - h) / 2)
  window.open(
    url,
    'BrokerAuth',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`,
  )
}

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      'Upstox MCP': {
        command: 'npx',
        args: ['mcp-remote', MCP_UPSTOX_URL],
      },
    },
  },
  null,
  2,
)

// ─── Copy button ─────────────────────────────────────────────────
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors border',
        copied
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ─── MCP section ─────────────────────────────────────────────────
function McpSection() {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardContent className="pt-5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 w-full text-left"
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 text-primary shrink-0">
            <Bot size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              Upstox MCP Integration
            </p>
            <p className="text-xs text-muted-foreground">
              Connect Upstox to Claude, Cursor, VS Code or ChatGPT
            </p>
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {open ? 'Hide' : 'Show config'}
          </span>
        </button>

        {open && (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Add this to your AI client config file. Authorization happens in
              the browser when the AI client first connects — no token needed
              here. Re-auth required daily.
            </p>
            <div className="rounded-md bg-muted border border-border overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/60">
                <span className="text-xs font-mono text-muted-foreground">
                  JSON
                </span>
                <CopyButton text={MCP_CONFIG} />
              </div>
              <pre className="p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre">
                {MCP_CONFIG}
              </pre>
            </div>
            <p className="text-xs text-muted-foreground">
              Full setup guide:{' '}
              <a
                href={UPSTOX_MCP_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                upstox.com/developer/api-documentation/mcp-integration
              </a>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Re-authorize inline ──────────────────────────────────────────
function ReauthorizeInline({ account }: { account: BrokerAccount }) {
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState('')

  const handleReauth = () => {
    if (!secret.trim() || !account.apiKey) return
    const redirectUri = `${window.location.origin}/broker/callback`
    const pending = {
      id: account.id,
      label: account.label,
      apiKey: account.apiKey,
      apiSecret: secret.trim(),
      redirectUri,
      purpose: account.purpose.filter((p) => p !== 'analytics'),
      analyticsToken: account.analyticsToken,
      mode: 'reauth' as const,
    }
    localStorage.setItem(
      `upstox-pending-${account.id}`,
      JSON.stringify(pending),
    )
    const oauthUrl = new URL(UPSTOX_AUTH_URL)
    oauthUrl.searchParams.set('response_type', 'code')
    oauthUrl.searchParams.set('client_id', account.apiKey)
    oauthUrl.searchParams.set('redirect_uri', redirectUri)
    oauthUrl.searchParams.set('state', account.id)
    openAuthPopup(oauthUrl.toString())
  }

  if (!account.apiKey) return null

  return (
    <div className="mt-3 border-t border-border pt-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw size={11} />
          Re-authorize trading token
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Enter your API Secret to refresh the trading token.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder="API Secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              className="h-8 flex-1 px-3 rounded-md border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button
              size="sm"
              className="h-8 text-xs px-3"
              onClick={handleReauth}
              disabled={!secret.trim()}
            >
              <RefreshCw size={11} />
              Re-authorize
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs px-3"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Test connection ─────────────────────────────────────────────────
interface ProfileData {
  user_id?: string
  name?: string
  email?: string
  mobile_number?: string
  broker?: string
}

function TestConnection({
  account,
  serverResolved,
}: {
  account?: BrokerAccount
  /** Daemon mode: the token lives on the server, so post an empty one. */
  serverResolved?: boolean
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>(
    'idle',
  )
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [errMsg, setErrMsg] = useState('')

  const token = account?.accessToken ?? account?.analyticsToken
  if (!token && !serverResolved) return null

  const handleTest = () => {
    setStatus('loading')
    setProfile(null)
    setErrMsg('')
    fetch(API_UPSTOX_PROFILE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token ?? '' }),
    })
      .then((r) => r.json())
      .then((json: unknown) => {
        const data = json as {
          status?: string
          data?: ProfileData
          errors?: { message: string }[]
        }
        if (data.status === 'success' && data.data) {
          setProfile(data.data)
          setStatus('ok')
        } else {
          setErrMsg(
            data.errors?.[0]?.message ?? 'Unexpected response from Upstox',
          )
          setStatus('error')
        }
      })
      .catch(() => {
        setErrMsg('Network error reaching proxy')
        setStatus('error')
      })
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleTest}
          disabled={status === 'loading'}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {status === 'loading' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <FlaskConical size={11} />
          )}
          Test connection
        </button>
        {status === 'ok' && (
          <span className="text-xs text-success">✓ API working</span>
        )}
        {status === 'error' && (
          <span className="text-xs text-destructive">{errMsg}</span>
        )}
      </div>
      {status === 'ok' && profile && (
        <div className="mt-2 rounded-md bg-muted/60 border border-border px-3 py-2 text-xs space-y-0.5">
          {profile.name && (
            <p>
              <span className="text-muted-foreground">Name: </span>
              <span className="text-foreground font-medium">
                {profile.name}
              </span>
            </p>
          )}
          {profile.email && (
            <p>
              <span className="text-muted-foreground">Email: </span>
              <span className="text-foreground">{profile.email}</span>
            </p>
          )}
          {profile.mobile_number && (
            <p>
              <span className="text-muted-foreground">Mobile: </span>
              <span className="text-foreground">{profile.mobile_number}</span>
            </p>
          )}
          {profile.user_id && (
            <p>
              <span className="text-muted-foreground">User ID: </span>
              <span className="text-foreground font-mono">
                {profile.user_id}
              </span>
            </p>
          )}
          {profile.broker && (
            <p>
              <span className="text-muted-foreground">Broker: </span>
              <span className="text-foreground">{profile.broker}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Account card ─────────────────────────────────────────────────
const PURPOSE_META = {
  analytics: { label: 'Portfolio Analytics', Icon: BarChart2 },
  'market-data': { label: 'Market Data', Icon: BarChart2 },
  orders: { label: 'Order Placing', Icon: ShoppingCart },
} as const

const TOKEN_BADGE_META = {
  analytics: {
    label: 'Analytics Token',
    Icon: BarChart2,
    className: 'bg-success/10 text-success',
  },
  trading: {
    label: 'Trading Token',
    Icon: Zap,
    className: 'bg-primary/10 text-primary',
  },
} as const

const STATUS_META = {
  connected: { variant: 'success', label: 'connected' },
  expired: { variant: 'destructive', label: 'expired' },
  need_auth: { variant: 'warning', label: 'need auth' },
} as const

/**
 * Chrome-only account card shared by the cloud account list and the daemon
 * window. Cloud rows map a BrokerAccount into this shape; the daemon window
 * describes its master token and order-token override.
 */
interface AccountCardData {
  id: string
  label: string
  status: 'connected' | 'expired' | 'need_auth'
  /** Mono line under the label (cloud: “Upstox · key…”; daemon: feed/override). */
  subtitle?: string
  badges?: (keyof typeof TOKEN_BADGE_META)[]
  purposes: { purpose: BrokerPurpose; active: boolean }[]
  connectedAt?: string
  /** Top-right controls (edit/remove on cloud; clear override on daemon). */
  actions?: React.ReactNode
  /** Section under the divider: reauth/test (cloud) or token tools (daemon). */
  children?: React.ReactNode
}

function accountCardData(
  account: BrokerAccount,
  handlers: {
    onEdit: (account: BrokerAccount) => void
    onRemove: (id: string) => void
  },
): AccountCardData {
  return {
    id: account.id,
    label: account.label,
    status: getAccountConnectionState(account),
    subtitle: account.apiKey
      ? `Upstox · ${account.apiKey.slice(0, 8)}…`
      : undefined,
    badges: [
      ...(account.analyticsToken ? (['analytics'] as const) : []),
      ...(account.accessToken ? (['trading'] as const) : []),
    ],
    purposes: account.purpose.map((p) => ({
      purpose: p,
      active:
        p === 'analytics' ? !!account.analyticsToken : !!account.accessToken,
    })),
    connectedAt: account.connectedAt,
    actions: (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => handlers.onEdit(account)}
          title="Edit account"
        >
          <Pencil size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={() => handlers.onRemove(account.id)}
          title="Remove account"
        >
          <Trash2 size={14} />
        </Button>
      </>
    ),
    children: (
      <>
        <ReauthorizeInline account={account} />
        <TestConnection account={account} />
      </>
    ),
  }
}

function AccountCard({ data }: { data: AccountCardData }) {
  const status = STATUS_META[data.status]

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary/10 text-primary font-bold text-sm shrink-0">
              U
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-foreground">
                  {data.label}
                </span>
                <Badge variant={status.variant}>{status.label}</Badge>
              </div>
              {data.subtitle && (
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {data.subtitle}
                </p>
              )}
            </div>
          </div>
          {data.actions && (
            <div className="flex items-center gap-1 shrink-0">
              {data.actions}
            </div>
          )}
        </div>

        {/* Token type badges */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {data.badges?.map((kind) => {
            const { label, Icon, className } = TOKEN_BADGE_META[kind]
            return (
              <div
                key={kind}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${className}`}
              >
                <Icon size={10} />
                {label}
              </div>
            )
          })}
        </div>

        {/* Purpose tags */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {data.purposes.map(({ purpose, active }) => {
            const { label, Icon } = PURPOSE_META[purpose]
            return (
              <div
                key={purpose}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  active
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground opacity-40'
                }`}
              >
                <Icon size={10} />
                {label}
              </div>
            )
          })}
        </div>

        {data.connectedAt && (
          <p className="text-xs text-muted-foreground mt-2">
            Connected{' '}
            {new Date(data.connectedAt).toLocaleDateString('en-IN', {
              dateStyle: 'medium',
            })}
          </p>
        )}

        {data.children}
      </CardContent>
    </Card>
  )
}

// ─── Broker registry ─────────────────────────────────────────────
interface BrokerMeta {
  id: 'upstox'
  name: string
  description: string
  available: boolean
}

const BROKERS: BrokerMeta[] = [
  {
    id: 'upstox',
    name: 'Upstox',
    description: 'Free API · Analytics + Trading tokens · MCP support',
    available: true,
  },
]

// ─── Upstox form ─────────────────────────────────────────────────
function UpstoxForm({
  label,
  onClose,
  existing,
}: {
  label: string
  onClose: () => void
  existing?: BrokerAccount
}) {
  const [analyticsToken, setAnalyticsToken] = useState(
    existing?.analyticsToken ?? '',
  )
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '')
  const [apiSecret, setApiSecret] = useState('')
  const [directAccessToken, setDirectAccessToken] = useState('')
  const [redirectUri, setRedirectUri] = useState(
    `${window.location.origin}/broker/callback`,
  )
  const [marketData, setMarketData] = useState(
    existing ? existing.purpose.includes('market-data') : true,
  )
  const [orders, setOrders] = useState(
    existing ? existing.purpose.includes('orders') : false,
  )

  const isEditing = !!existing
  const hasAnalytics = analyticsToken.trim().length > 0
  const hasTradingPurpose = marketData || orders
  const hasDirectTradingToken = !!(
    directAccessToken.trim() && hasTradingPurpose
  )
  const hasTradingOauth = !!(
    apiKey.trim() &&
    apiSecret.trim() &&
    redirectUri.trim() &&
    hasTradingPurpose
  )
  const hasTrading = hasDirectTradingToken || hasTradingOauth
  const isValid = isEditing ? true : hasAnalytics || hasTrading

  const handleSave = () => {
    if (!isValid) return

    const resolvedLabel = (label.trim() || existing?.label) ?? 'Upstox Account'
    const newPurposes: BrokerPurpose[] = [
      ...(analyticsToken.trim() ? ['analytics' as const] : []),
      ...(marketData ? ['market-data' as const] : []),
      ...(orders ? ['orders' as const] : []),
    ]

    if (isEditing) {
      // Always save metadata changes immediately
      updateAccount(existing.id, {
        label: resolvedLabel,
        analyticsToken: analyticsToken.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        purpose: newPurposes.length > 0 ? newPurposes : existing.purpose,
        ...(directAccessToken.trim()
          ? {
              accessToken: directAccessToken.trim(),
              status: 'connected' as const,
              connectedAt: new Date().toISOString(),
            }
          : {}),
      })
      // If a direct access token was entered, use it immediately and skip OAuth.
      if (directAccessToken.trim()) {
        onClose()
        // Otherwise, if a new API secret was entered, refresh the trading token via OAuth.
      } else if (apiSecret.trim() && apiKey.trim()) {
        const pending = {
          id: existing.id,
          label: resolvedLabel,
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          redirectUri: redirectUri.trim(),
          purpose: newPurposes.filter((p) => p !== 'analytics'),
          analyticsToken: analyticsToken.trim() || undefined,
          mode: 'reauth' as const,
        }
        localStorage.setItem(
          `upstox-pending-${existing.id}`,
          JSON.stringify(pending),
        )
        const oauthUrl = new URL(UPSTOX_AUTH_URL)
        oauthUrl.searchParams.set('response_type', 'code')
        oauthUrl.searchParams.set('client_id', apiKey.trim())
        oauthUrl.searchParams.set('redirect_uri', redirectUri.trim())
        oauthUrl.searchParams.set('state', existing.id)
        openAuthPopup(oauthUrl.toString())
      } else {
        onClose()
      }
      return
    }

    // Create mode
    if (hasDirectTradingToken) {
      addAccount({
        id: generateId(),
        label: resolvedLabel,
        broker: 'upstox',
        apiKey: apiKey.trim() || undefined,
        accessToken: directAccessToken.trim(),
        analyticsToken: hasAnalytics ? analyticsToken.trim() : undefined,
        purpose:
          newPurposes.filter((p) => p !== 'analytics').length > 0
            ? newPurposes
            : ['analytics'],
        status: 'connected',
        connectedAt: new Date().toISOString(),
      })
      onClose()
    } else if (hasTradingOauth) {
      const id = generateId()
      const tradingPurposes = [
        ...(marketData ? ['market-data' as const] : []),
        ...(orders ? ['orders' as const] : []),
      ]
      const pending = {
        id,
        label: resolvedLabel,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        redirectUri: redirectUri.trim(),
        purpose: [
          ...(hasAnalytics ? ['analytics' as const] : []),
          ...tradingPurposes,
        ],
        analyticsToken: hasAnalytics ? analyticsToken.trim() : undefined,
        mode: 'create' as const,
      }
      localStorage.setItem(`upstox-pending-${id}`, JSON.stringify(pending))
      const oauthUrl = new URL(UPSTOX_AUTH_URL)
      oauthUrl.searchParams.set('response_type', 'code')
      oauthUrl.searchParams.set('client_id', apiKey.trim())
      oauthUrl.searchParams.set('redirect_uri', redirectUri.trim())
      oauthUrl.searchParams.set('state', id)
      openAuthPopup(oauthUrl.toString())
    } else {
      addAccount({
        id: generateId(),
        label: resolvedLabel,
        broker: 'upstox',
        analyticsToken: analyticsToken.trim(),
        purpose: ['analytics'],
        status: 'connected',
        connectedAt: new Date().toISOString(),
      })
      onClose()
    }
  }

  const inputClass =
    'h-9 w-full px-3 rounded-md border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'

  const purposeBtn = (
    active: boolean,
    onClick: () => void,
    Icon: React.ElementType,
    lbl: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon size={12} />
      {lbl}
    </button>
  )

  return (
    <>
      <Tabs defaultValue="analytics">
        <TabsList className="w-full">
          <TabsTrigger value="analytics" className="flex-1 gap-1.5">
            <BarChart2 size={13} />
            Analytics Token
          </TabsTrigger>
          <TabsTrigger value="trading" className="flex-1 gap-1.5">
            <Zap size={13} />
            Trading Token
          </TabsTrigger>
        </TabsList>

        {/* Analytics tab */}
        <TabsContent value="analytics">
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Long-lived read-only token (1 year). Generated once from{' '}
              <a
                href={UPSTOX_DEVELOPER_APPS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Upstox Developer Apps → Analytics tab
              </a>
              . No daily re-auth needed.
            </p>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                Analytics Token
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                rows={3}
                placeholder="Paste your analytics token here…"
                value={analyticsToken}
                onChange={(e) => setAnalyticsToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="rounded-md bg-muted/60 border border-border p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">
                What this token supports
              </p>
              <p>
                ✓ &nbsp;Portfolio, Holdings, Positions, Orders (read), P&amp;L,
                Mutual Funds
              </p>
              <p className="mt-0.5 opacity-70">
                ✗ &nbsp;Market Quotes, Historical Data, Option Chain, WebSocket,
                Order Placing
              </p>
            </div>
          </div>
        </TabsContent>

        {/* Trading tab */}
        <TabsContent value="trading">
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Market data, historical candles and order placement require a
              daily Upstox access token. You can either paste a token directly
              below or generate one with the OAuth flow.
            </p>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                Direct Access Token
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                rows={3}
                placeholder="Paste a valid Upstox access token to skip browser login…"
                value={directAccessToken}
                onChange={(e) => setDirectAccessToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                If this field is filled, the account will use the pasted token
                directly and skip the callback-based OAuth login.
              </p>
            </div>
            <div className="rounded-md bg-muted/60 border border-border p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">
                OAuth alternative
              </p>
              <p>
                Leave the direct token blank if you want the app to open the
                Upstox login flow and fetch a fresh token through the callback.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                API Key <span className="text-destructive">*</span>
              </label>
              <input
                className={inputClass}
                placeholder="client_id from your Upstox developer app"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                API Secret <span className="text-destructive">*</span>
              </label>
              <input
                type="password"
                className={inputClass}
                placeholder="client_secret from your Upstox developer app"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                Redirect URI <span className="text-destructive">*</span>
              </label>
              <input
                className={cn(inputClass, 'font-mono text-xs')}
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Must match the Redirect URL in your{' '}
                <a
                  href={UPSTOX_DEVELOPER_APPS_BASE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Upstox developer app
                </a>
                .
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                Purposes
              </label>
              <div className="flex gap-2">
                {purposeBtn(
                  marketData,
                  () => setMarketData((v) => !v),
                  BarChart2,
                  'Market Data',
                )}
                {purposeBtn(
                  orders,
                  () => setOrders((v) => !v),
                  ShoppingCart,
                  'Order Placing',
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              OAuth redirect is only used when you provide API key and secret
              without a direct access token. Your API secret is used only once
              during the token exchange and is never stored.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={handleSave} disabled={!isValid} size="sm">
          <Link2 size={14} />
          {isEditing
            ? 'Save Changes'
            : hasTradingOauth && !hasDirectTradingToken
              ? 'Connect via Upstox'
              : 'Save Account'}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  )
}

// ─── Add account panel ────────────────────────────────────────────
function AddAccountPanel({
  onClose,
  existing,
}: {
  onClose: () => void
  existing?: BrokerAccount
}) {
  const isEditing = !!existing
  const [selectedBroker, setSelectedBroker] = useState<BrokerMeta | null>(
    isEditing ? (BROKERS.find((b) => b.id === existing.broker) ?? null) : null,
  )
  const [label, setLabel] = useState(existing?.label ?? '')

  const inputClass =
    'h-9 w-full px-3 rounded-md border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {selectedBroker ? (
            <div className="flex items-center gap-2">
              {!isEditing && (
                <>
                  <button
                    onClick={() => setSelectedBroker(null)}
                    className="text-muted-foreground hover:text-foreground transition-colors text-xs font-normal"
                  >
                    ← Brokers
                  </button>
                  <span className="text-muted-foreground">/</span>
                </>
              )}
              <span>
                {isEditing
                  ? `Edit · ${selectedBroker.name}`
                  : selectedBroker.name}
              </span>
            </div>
          ) : (
            'Add Broker Account'
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!selectedBroker ? (
          <div className="flex flex-col gap-2 max-w-lg">
            <p className="text-xs text-muted-foreground mb-1">
              Select a broker to connect
            </p>
            {BROKERS.map((broker) => (
              <button
                key={broker.id}
                onClick={() => broker.available && setSelectedBroker(broker)}
                disabled={!broker.available}
                className={cn(
                  'flex items-center gap-3 w-full px-4 py-3 rounded-md border text-left transition-colors',
                  broker.available
                    ? 'border-border hover:border-primary/50 hover:bg-accent cursor-pointer'
                    : 'border-border opacity-40 cursor-not-allowed',
                )}
              >
                <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary/10 text-primary font-bold text-sm shrink-0">
                  {broker.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {broker.name}
                    </span>
                    {!broker.available && (
                      <span className="text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {broker.description}
                  </p>
                </div>
                {broker.available && (
                  <ChevronRight
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4 max-w-lg">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground">
                Account Label
              </label>
              <input
                className={inputClass}
                placeholder={`e.g. My ${selectedBroker.name} Account`}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <UpstoxForm label={label} onClose={onClose} existing={existing} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Page header ─────────────────────────────────────────────────
function BrokerAccountsHeader({ action }: { action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Broker Accounts
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Connect broker accounts to enable trading and market data access
        </p>
      </div>
      {action}
    </div>
  )
}

// ─── Cloud variant ────────────────────────────────────────────────
function CloudBrokerAccounts() {
  const [accounts, setAccounts] = useState<BrokerAccount[]>(() => getAccounts())
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [editingAccount, setEditingAccount] = useState<BrokerAccount | null>(
    null,
  )

  const reload = () => setAccounts(getAccounts())

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data === 'upstox-auth-success') {
        reload()
        setShowAddPanel(false)
        setEditingAccount(null)
      }
    }
    const cleanupInterval = setInterval(() => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('upstox-pending-')) {
          const entry = localStorage.getItem(key)
          if (entry) {
            try {
              const pending = JSON.parse(entry) as { mode?: string }
              if (pending.mode === 'create' || pending.mode === 'reauth') {
                localStorage.removeItem(key)
              }
            } catch {
              localStorage.removeItem(key)
            }
          }
        }
      }
    }, 120000)

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      clearInterval(cleanupInterval)
    }
  }, [])

  const handleRemove = (id: string) => {
    removeAccount(id)
    reload()
  }

  const handlePanelClose = () => {
    setShowAddPanel(false)
    setEditingAccount(null)
    reload()
  }

  const showPanel = showAddPanel || editingAccount !== null
  const isEmpty = accounts.length === 0

  return (
    <div className="flex flex-col gap-5 p-6 min-w-0">
      <BrokerAccountsHeader
        action={
          !showPanel ? (
            <Button
              size="sm"
              onClick={() => setShowAddPanel(true)}
              className="shrink-0"
            >
              <Plus size={14} />
              Add Account
            </Button>
          ) : undefined
        }
      />

      {showPanel && (
        <AddAccountPanel
          onClose={handlePanelClose}
          existing={editingAccount ?? undefined}
        />
      )}

      {isEmpty && !showPanel ? (
        <Card>
          <CardContent className="pt-5">
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-muted">
                <Link2Off size={20} className="text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  No accounts connected
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Add a broker account to start trading and accessing market
                  data
                </p>
              </div>
              <Button size="sm" onClick={() => setShowAddPanel(true)}>
                <Plus size={14} />
                Add Account
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        !isEmpty && (
          <div className="flex flex-col gap-3 max-w-2xl">
            {accounts.map((acc) => (
              <AccountCard
                key={acc.id}
                data={accountCardData(acc, {
                  onRemove: handleRemove,
                  onEdit: (a) => {
                    setShowAddPanel(false)
                    setEditingAccount(a)
                  },
                })}
              />
            ))}
            <McpSection />
          </div>
        )
      )}
    </div>
  )
}

// ─── Daemon variant ───────────────────────────────────────────────
// Same page as the cloud dashboard, one card per "account". The daemon owns
// the Upstox token, so its rows are the master feed token and the optional
// per-user order-token override instead of browser-stored accounts.
// ─── Daemon: window-managed Upstox API credentials ──────────────────
// The daemon owns the account secrets server-side (SQLite, 0600). This form
// only ever sends them down; the daemon returns masked hints, never values.
function DaemonCredentialsInline({
  settings,
  onSaved,
}: {
  settings: DaemonUpstoxSettings | null
  onSaved: (next: DaemonUpstoxSettings) => void
}) {
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  if (!settings) return null

  const configured =
    settings.hasApiKey && settings.hasApiSecret && Boolean(settings.redirectUri)

  const openForm = () => {
    setApiKey('')
    setApiSecret('')
    setRedirectUri(
      settings.redirectUri ?? `${window.location.origin}/auth/upstox/callback`,
    )
    setFeedback(null)
    setOpen(true)
  }

  const save = async () => {
    const payload: {
      apiKey?: string
      apiSecret?: string
      redirectUri?: string
    } = {}
    if (apiKey.trim()) payload.apiKey = apiKey.trim()
    if (apiSecret.trim()) payload.apiSecret = apiSecret.trim()
    if (redirectUri.trim()) payload.redirectUri = redirectUri.trim()

    if (!settings.hasApiKey && !payload.apiKey) {
      setFeedback({
        kind: 'error',
        text: 'Enter the Upstox API Key (client id).',
      })
      return
    }
    if (!settings.hasApiSecret && !payload.apiSecret) {
      setFeedback({ kind: 'error', text: 'Enter the Upstox API Secret.' })
      return
    }
    if (!payload.redirectUri && !settings.redirectUri) {
      setFeedback({
        kind: 'error',
        text: 'Enter the redirect URI registered in your Upstox app.',
      })
      return
    }

    setSaving(true)
    setFeedback(null)
    try {
      const res = await daemonApi.saveUpstoxSettings(payload)
      onSaved(res.upstox)
      setOpen(false)
      setFeedback({
        kind: 'ok',
        text: 'Saved to the daemon — the refresh link above is ready.',
      })
    } catch (err) {
      setFeedback({
        kind: 'error',
        text:
          err instanceof Error ? err.message : 'Failed to save credentials.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      {!open ? (
        <button
          onClick={openForm}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <KeyRound size={11} />
          {configured
            ? `API credentials configured · ${settings.apiKeyHint ?? '•••'}`
            : 'Set Upstox API credentials'}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Used by the daily &ldquo;Refresh token via Upstox login&rdquo; flow.
            Stored in the daemon&rsquo;s SQLite — never in the browser. The
            redirect URI must match your Upstox developer app exactly.
          </p>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              settings.hasApiKey
                ? `API Key saved (${settings.apiKeyHint}) — type to replace`
                : 'Upstox API Key (client id)'
            }
            autoComplete="off"
            className="h-8 px-3 rounded-md border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
          <input
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder={
              settings.hasApiSecret
                ? 'API Secret saved — type to replace'
                : 'Upstox API Secret'
            }
            autoComplete="new-password"
            className="h-8 px-3 rounded-md border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
          <input
            type="text"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="Redirect URI (e.g. http://127.0.0.1:3000/auth/upstox/callback)"
            autoComplete="off"
            className="h-8 px-3 rounded-md border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs px-3"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs px-3"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {feedback && (
        <p
          className={`text-xs mt-2 ${feedback.kind === 'ok' ? 'text-success' : 'text-destructive'}`}
        >
          {feedback.text}
        </p>
      )}
    </div>
  )
}

function DaemonBrokerAccounts({ daemon }: { daemon: DaemonController }) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  const [alsoMaster, setAlsoMaster] = useState(false)
  const [creds, setCreds] = useState<DaemonUpstoxSettings | null>(null)

  // Window-managed Upstox credentials (masked view; secrets stay server-side).
  useEffect(() => {
    let cancelled = false
    daemonApi
      .settings()
      .then((s) => {
        if (!cancelled) setCreds(s.upstox)
      })
      .catch(() => {
        if (!cancelled) setCreds(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const feed = daemon.health?.feed
  const liveFeed = Boolean(feed && feed.source !== 'mock')
  const hasMaster = Boolean(daemon.status?.hasToken)
  const hasOverride = Boolean(daemon.status?.hasOrderTokenOverride)

  const saveToken = async () => {
    if (!token.trim()) {
      setFeedback({
        kind: 'error',
        text: 'Paste an Upstox access token first.',
      })
      return
    }
    setSaving(true)
    setFeedback(null)
    try {
      await daemonApi.setToken(token.trim(), alsoMaster)
      setToken('')
      setFeedback({
        kind: 'ok',
        text: alsoMaster
          ? 'Token saved — live orders and the market-data feed now use it.'
          : 'Order token saved — live orders now use it.',
      })
      daemon.refresh()
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to save the token.',
      })
    } finally {
      setSaving(false)
    }
  }

  const clearOverride = async () => {
    setClearing(true)
    setFeedback(null)
    try {
      await daemonApi.clearToken()
      setFeedback({
        kind: 'ok',
        text: 'Override removed — live orders fall back to the master token.',
      })
      daemon.refresh()
    } catch (err) {
      setFeedback({
        kind: 'error',
        text:
          err instanceof Error ? err.message : 'Failed to clear the override.',
      })
    } finally {
      setClearing(false)
    }
  }

  const masterCard: AccountCardData = {
    id: 'master-token',
    label: 'Master feed token',
    status: hasMaster ? 'connected' : 'need_auth',
    subtitle: `Upstox · ${feed?.source ?? '—'}`,
    badges: hasMaster ? ['trading'] : [],
    purposes: [
      { purpose: 'market-data', active: liveFeed },
      { purpose: 'orders', active: hasMaster },
    ],
    children: (
      <>
        <div className="mt-3 border-t border-border pt-3">
          <a
            href="/auth/upstox/start"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            <RefreshCw size={11} />
            Refresh token via Upstox login
          </a>
          <p className="text-[11px] text-muted-foreground mt-2">
            Expires daily (~03:30 IST). Refreshing needs the Upstox API
            credentials and the exact redirect URI registered in your Upstox
            developer app.
          </p>
        </div>
        <DaemonCredentialsInline settings={creds} onSaved={setCreds} />
        <TestConnection serverResolved />
      </>
    ),
  }

  const overrideCard: AccountCardData = {
    id: 'order-override',
    label: 'Order token override',
    status: hasOverride ? 'connected' : 'need_auth',
    subtitle: 'Upstox · per-user order token',
    badges: hasOverride ? ['trading'] : [],
    purposes: [{ purpose: 'orders', active: hasOverride }],
    actions: hasOverride ? (
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={() => void clearOverride()}
        disabled={clearing}
        title="Remove override"
      >
        <Link2Off size={14} />
      </Button>
    ) : undefined,
    children: (
      <div className="mt-3 border-t border-border pt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          By default live orders authenticate with the master token. Paste a
          separate Upstox access token here to override it for this user — the
          override takes precedence for every order.
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
            className={`text-xs ${feedback.kind === 'ok' ? 'text-success' : 'text-destructive'}`}
          >
            {feedback.text}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          The token is stored in the daemon's SQLite state and never leaves this
          machine.
        </p>
        <TestConnection serverResolved />
      </div>
    ),
  }

  return (
    <div className="flex flex-col gap-5 p-6 min-w-0">
      <BrokerAccountsHeader />
      <div className="flex flex-col gap-3 max-w-2xl">
        <AccountCard data={masterCard} />
        <AccountCard data={overrideCard} />
        <McpSection />
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────
// One page component for both shells: the cloud dashboard renders the
// browser-account variant, the daemon window passes its controller.
export function BrokerAccountsPage({ daemon }: { daemon?: DaemonController }) {
  return daemon ? (
    <DaemonBrokerAccounts daemon={daemon} />
  ) : (
    <CloudBrokerAccounts />
  )
}
