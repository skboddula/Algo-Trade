import type { PaperAccountSummary } from '@/lib/types'
import { useEffect, useState } from 'react'
import { fetchPaperHistory } from '@/lib/paperTrading'
import { getLotSizeForSymbol } from '@/utils/tradeUtils'
import { STORAGE_KEY_BOT_POSITION } from '@/lib/constants'
import { getSensibullUrl, extractCleanTradingSymbol } from '@/lib/utils'
import {
  HistoryView,
  type HistoryStatementRow,
  type HistoryTradeRow,
} from '@/components/dashboard/history/history-view'

function fmtCurrency(value: number, signed = false) {
  const formatted = Math.abs(value).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  })
  if (!signed) {
    return value < 0 ? `-${formatted}` : formatted
  }
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  })
}

export function HistoryPage() {
  const [data, setData] = useState<PaperAccountSummary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchPaperHistory()
      .then((summary) => {
        if (!cancelled) {
          setData(summary)
          setError('')
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const recentTrades = data?.trades ?? []
  const openTrades = data?.openTrades ?? []
  const openTradeIds = new Set(openTrades.map((trade) => trade.id))
  const trades = [
    ...openTrades,
    ...recentTrades.filter((trade) => !openTradeIds.has(trade.id)),
  ].sort((left, right) => right.opened_at.localeCompare(left.opened_at))

  const statementRows: HistoryStatementRow[] = (data?.recentEntries ?? []).map(
    (entry) => ({
      id: entry.id,
      timeLabel: new Date(entry.created_at).toLocaleString('en-IN'),
      type: entry.entry_type,
      amountLabel: fmtCurrency(entry.amount, true),
      amountPositive: entry.amount >= 0,
      balanceLabel: fmtCurrency(entry.balance_after),
      note: entry.note ?? '—',
    }),
  )

  const tradeRows: HistoryTradeRow[] = trades.map((trade) => {
    const pnl = trade.realized_pnl
    let currentMtmPrice: number | null = null
    let mtmUrPnl: number | null = null

    if (trade.status === 'OPEN') {
      try {
        const rawPos = localStorage.getItem(STORAGE_KEY_BOT_POSITION)
        if (rawPos) {
          const botPos = JSON.parse(rawPos) as {
            instrumentKey?: string
            currentPrice?: number
            legs?: {
              instrumentKey?: string
              currentPrice?: number
            }[]
          }
          if (botPos.legs?.length) {
            const legMatch = botPos.legs.find(
              (l) => l.instrumentKey === trade.instrument_key,
            )
            if (legMatch?.currentPrice) currentMtmPrice = legMatch.currentPrice
          }
          if (currentMtmPrice === null && botPos.currentPrice) {
            currentMtmPrice = botPos.currentPrice
          }
        }
      } catch {
        // ignore
      }

      if (currentMtmPrice !== null) {
        let isSelling = false
        try {
          const meta = JSON.parse(trade.metadata_json ?? '{}') as {
            tradeType?: string
          }
          if (meta?.tradeType === 'selling') isSelling = true
        } catch {
          // ignore
        }
        mtmUrPnl = isSelling
          ? (trade.entry_price - currentMtmPrice) * trade.quantity
          : (currentMtmPrice - trade.entry_price) * trade.quantity
      }
    }

    let displaySymbol = trade.instrument_key
    let metaSubtext: string | null = null
    let contractLotSize: number | null = null
    let metaTradingSymbol: string | undefined = undefined
    let metaUnderlyingSymbol: string | undefined = undefined
    try {
      const meta = JSON.parse(trade.metadata_json ?? '{}') as {
        tradingSymbol?: string
        strikePrice?: number
        expiry?: string
        underlyingSymbol?: string
        lotSize?: number
      } | null
      if (Number.isInteger(meta?.lotSize) && Number(meta?.lotSize) > 0) {
        contractLotSize = Number(meta?.lotSize)
      }
      if (meta?.underlyingSymbol) {
        metaUnderlyingSymbol = meta.underlyingSymbol
      }
      metaTradingSymbol =
        meta?.tradingSymbol ??
        extractCleanTradingSymbol(trade.instrument_key) ??
        metaUnderlyingSymbol
      if (meta?.tradingSymbol || meta?.strikePrice) {
        const underlying = meta.underlyingSymbol ?? 'NIFTY'
        const strikeStr = meta.strikePrice ? `${meta.strikePrice}` : ''
        displaySymbol =
          meta.tradingSymbol ?? `${underlying} ${strikeStr} ${trade.direction}`
        metaSubtext = `${trade.instrument_key}${meta.expiry ? ` · Exp: ${meta.expiry}` : ''}`
      }
    } catch {
      // ignore
    }

    const sensibullUrl = getSensibullUrl(
      displaySymbol ?? metaTradingSymbol,
      metaUnderlyingSymbol,
    )

    let pnlView: HistoryTradeRow['pnl'] = null
    if (pnl !== null) {
      pnlView = {
        label: fmtCurrency(pnl, true),
        positive: pnl >= 0,
        mtm: false,
      }
    } else if (mtmUrPnl !== null) {
      pnlView = {
        label: fmtCurrency(mtmUrPnl, true),
        positive: mtmUrPnl >= 0,
        mtm: true,
      }
    }

    return {
      id: trade.id,
      displaySymbol,
      subtext: metaSubtext,
      sensibullUrl: sensibullUrl ?? null,
      direction: trade.direction,
      quantity: trade.quantity,
      lotSize:
        contractLotSize ??
        getLotSizeForSymbol(displaySymbol || trade.instrument_key),
      entryLabel: fmtCurrency(trade.entry_price),
      exitLabel:
        trade.exit_price !== null
          ? fmtCurrency(trade.exit_price)
          : currentMtmPrice !== null
            ? fmtCurrency(currentMtmPrice)
            : '—',
      pnl: pnlView,
      status: trade.status,
      openedLabel: stamp(trade.opened_at),
      closedLabel: trade.closed_at ? stamp(trade.closed_at) : '—',
    }
  })

  return (
    <HistoryView
      subtitle="Paper trading ledger and simulated trade statement"
      error={error || null}
      balance={data ? fmtCurrency(data.account.balance) : '—'}
      openCount={data?.openTradeCount ?? 0}
      statementRows={statementRows}
      tradeRows={tradeRows}
    />
  )
}
