import { Settings } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { StrategyConfig as StrategyConfigPanel } from '@/components/dashboard/strategy/strategy-config'
import type { DaemonController } from '@/hooks/useDaemon'
import { DEFAULT_CONFIG } from '@/lib/types'

/**
 * Strategy config editor bound to the daemon: saving POSTs to
 * `/api/bot/config`, so changes apply to the running engine immediately and
 * persist in its SQLite state.
 */
export function DaemonConfigPage({ daemon }: { daemon: DaemonController }) {
  const user = daemon.status?.userState
  const config = user?.config ?? DEFAULT_CONFIG

  return (
    <div className="p-4 space-y-4 max-w-[1000px] mx-auto">
      <Card>
        <CardContent className="pt-4 flex items-start gap-2">
          <Settings size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Editing the <span className="font-medium">running daemon</span> —
            thresholds, risk limits and execution mode apply immediately on save
            (persisted in the daemon's SQLite state). Execution mode here is the
            mode the daemon trades in when armed.
          </p>
        </CardContent>
      </Card>

      {user ? (
        <StrategyConfigPanel
          config={config}
          onSave={(next) => {
            void daemon.saveConfig(next)
          }}
        />
      ) : (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Waiting for the daemon link…
        </div>
      )}
    </div>
  )
}
