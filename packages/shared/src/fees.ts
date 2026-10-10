/**
 * Paper-trading fee model — the single source of truth for option order
 * charges, shared by the Worker's D1 paper engine and the daemon's
 * file-backed order gateway. Both paper accounts therefore compute
 * identical, realistic fees.
 *
 * All amounts are in PAISE.
 */

/** Flat ₹20 brokerage per order (2000 paise), both legs. */
const PAPER_BROKERAGE_PAISE = 20_00

export interface OptionCharges {
  totalCharges: number
  brokerage: number
  statutoryTaxes: number
}

/**
 * Realistic option order charges (SEBI/Zerodha-style):
 *  - brokerage: flat ₹20 per order
 *  - STT: 0.1% on the SELL leg only
 *  - stamp duty: 0.003% on the BUY leg only
 *  - exchange transaction fee: 0.03503%
 *  - GST: 18% on (brokerage + exchange fee)
 */
export function calculateOptionCharges(
  tradeValuePaise: number,
  isSelling: boolean,
): OptionCharges {
  const brokerage = PAPER_BROKERAGE_PAISE
  const stt = isSelling ? Math.round(tradeValuePaise * 0.001) : 0
  const stampDuty = !isSelling ? Math.round(tradeValuePaise * 0.00003) : 0
  const exchangeFee = Math.round(tradeValuePaise * 0.0003503)
  const gst = Math.round((brokerage + exchangeFee) * 0.18)
  const statutoryTaxes = stt + stampDuty + exchangeFee + gst
  const totalCharges = brokerage + statutoryTaxes
  return { totalCharges, brokerage, statutoryTaxes }
}
