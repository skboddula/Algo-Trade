import type {
  CostModelName,
  CostRates,
  OptionCharges,
} from './types'

/**
 * NSE index-option cost assumptions.
 *
 * The `paper-parity` model is byte-for-byte the fee math used by the browser
 * paper ledger (`app/client/worker/paperTrading.ts`): ₹20 brokerage per order,
 * 0.1% STT on sell-side premium, 0.003% stamp duty on buy-side premium,
 * 0.03503% exchange transaction charge and 18% GST on brokerage + exchange fee.
 *
 * `statutory` adds the SEBI turnover fee (₹10 per crore) that the paper model
 * omits. The engine defaults to `statutory`; `paper-parity` exists so replay
 * results can be reconciled with the paper ledger.
 */
export const COST_RATES: Record<CostModelName, CostRates> = {
  statutory: {
    brokeragePerOrder: 20,
    sttSellRate: 0.001,
    exchangeRate: 0.0003503,
    stampBuyRate: 0.00003,
    sebiRate: 0.000001,
    gstRate: 0.18,
  },
  'paper-parity': {
    brokeragePerOrder: 20,
    sttSellRate: 0.001,
    exchangeRate: 0.0003503,
    stampBuyRate: 0.00003,
    sebiRate: 0,
    gstRate: 0.18,
  },
}

const toPaise = (value: number): number => Math.round(value * 100)
const toRupees = (paise: number): number => Math.round(paise) / 100

/**
 * Computes one leg's charges on option premium. Long-only replay uses
 * `side: 'buy'` on entry and `side: 'sell'` on exit.
 */
export function calculateOptionCharges(
  tradeValue: number,
  side: 'buy' | 'sell',
  rates: CostRates = COST_RATES.statutory,
): OptionCharges {
  const valuePaise = toPaise(Math.max(0, tradeValue))
  const brokeragePaise = toPaise(rates.brokeragePerOrder)
  const sttPaise = side === 'sell' ? Math.round(valuePaise * rates.sttSellRate) : 0
  const stampDutyPaise =
    side === 'buy' ? Math.round(valuePaise * rates.stampBuyRate) : 0
  const exchangePaise = Math.round(valuePaise * rates.exchangeRate)
  const sebiPaise = Math.round(valuePaise * rates.sebiRate)
  const gstPaise = Math.round(
    (brokeragePaise + exchangePaise + sebiPaise) * rates.gstRate,
  )
  const statutoryPaise =
    sttPaise + stampDutyPaise + exchangePaise + sebiPaise + gstPaise
  const totalPaise = brokeragePaise + statutoryPaise

  return {
    brokerage: toRupees(brokeragePaise),
    stt: toRupees(sttPaise),
    stampDuty: toRupees(stampDutyPaise),
    exchangeFee: toRupees(exchangePaise),
    sebi: toRupees(sebiPaise),
    gst: toRupees(gstPaise),
    statutoryTaxes: toRupees(statutoryPaise),
    total: toRupees(totalPaise),
    totalPaise,
  }
}

/** Applies a symmetric bps slippage to a market fill. */
export function applySlippage(
  price: number,
  bps: number,
  side: 'buy' | 'sell',
): number {
  const factor = bps / 10_000
  const adjusted = side === 'buy' ? price * (1 + factor) : price * (1 - factor)
  return Math.round(adjusted * 100) / 100
}

export function costRatesFor(model: CostModelName): CostRates {
  return COST_RATES[model]
}
