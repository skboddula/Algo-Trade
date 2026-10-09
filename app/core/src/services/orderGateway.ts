import type {
  ActivePosition,
  ExecutionMode,
  PaperAccount,
  PaperTradeRecord,
} from "../types";
import { DEFAULT_INITIAL_PAPER_BALANCE } from "../constants";
import {
  loadState,
  saveState,
  loadRecords,
  appendRecord,
} from "../utils/store";

/** Flat ₹20 brokerage per order, in paise (parity with the Worker engine). */
const PAPER_BROKERAGE_PAISE = 20_00;

export interface OptionCharges {
  totalCharges: number;
  brokerage: number;
  statutoryTaxes: number;
}

/**
 * Realistic option order charges, in paise (direct port of the Worker's
 * calculateOptionCharges — STT on the sell leg, stamp duty on the buy leg,
 * exchange transaction fee, and GST on brokerage + exchange fee).
 */
export function calculateOptionCharges(
  tradeValuePaise: number,
  isSelling: boolean,
): OptionCharges {
  const brokerage = PAPER_BROKERAGE_PAISE;
  const stt = isSelling ? Math.round(tradeValuePaise * 0.001) : 0;
  const stampDuty = !isSelling ? Math.round(tradeValuePaise * 0.00003) : 0;
  const exchangeFee = Math.round(tradeValuePaise * 0.0003503);
  const gst = Math.round((brokerage + exchangeFee) * 0.18);
  const statutoryTaxes = stt + stampDuty + exchangeFee + gst;
  const totalCharges = brokerage + statutoryTaxes;
  return { totalCharges, brokerage, statutoryTaxes };
}

export interface OrderPlacementRequest {
  userId: string;
  executionMode: ExecutionMode;
  token?: string;
  instrumentKey: string;
  direction: "CE" | "PE";
  quantity: number;
  price: number;
  tradeType: "buying" | "selling";
  underlyingSymbol?: string;
}

export interface OrderExitRequest {
  userId: string;
  executionMode: ExecutionMode;
  token?: string;
  position: ActivePosition;
  exitPrice: number;
  reason: string;
}

export interface OrderResult {
  success: boolean;
  tradeId: string;
  filledPrice: number;
  quantity: number;
  error?: string;
}

export class OrderGateway {
  private paperAccounts: Map<string, PaperAccount> = new Map();
  private paperTrades: Map<string, PaperTradeRecord> = new Map();
  private upstoxApiBaseUrl: string;

  constructor(upstoxApiBaseUrl = "https://api.upstox.com/v2") {
    this.upstoxApiBaseUrl = upstoxApiBaseUrl;
    this.restoreFromDisk();
  }

  /** Restores paper accounts and trade history from disk on startup. */
  private restoreFromDisk(): void {
    const accounts = loadState<Record<string, PaperAccount>>("paper_accounts");
    if (accounts) {
      for (const [userId, account] of Object.entries(accounts)) {
        this.paperAccounts.set(userId, account);
      }
      console.log(
        `[orderGateway] Restored ${this.paperAccounts.size} paper account(s) from disk`,
      );
    }

    const trades = loadRecords<PaperTradeRecord>("paper_trades");
    for (const trade of trades) {
      this.paperTrades.set(trade.id, trade);
    }
    console.log(
      `[orderGateway] Restored ${this.paperTrades.size} paper trade(s) from disk`,
    );
  }

  /** Persists paper accounts to disk (call after balance changes). */
  private persistAccounts(): void {
    const accounts: Record<string, PaperAccount> = {};
    for (const [userId, account] of this.paperAccounts.entries()) {
      accounts[userId] = account;
    }
    saveState("paper_accounts", accounts);
  }

  /** Persists a single trade record to the append-only JSONL log. */
  private persistTrade(trade: PaperTradeRecord): void {
    appendRecord("paper_trades", trade);
  }

  public getOrCreatePaperAccount(userId: string): PaperAccount {
    let account = this.paperAccounts.get(userId);
    if (!account) {
      account = {
        id: `paper_acc_${userId}`,
        userId,
        balance: DEFAULT_INITIAL_PAPER_BALANCE,
        currency: "INR",
        updatedAt: new Date().toISOString(),
      };
      this.paperAccounts.set(userId, account);
    }
    return account;
  }

  public resetPaperAccount(userId: string): PaperAccount {
    const account: PaperAccount = {
      id: `paper_acc_${userId}`,
      userId,
      balance: DEFAULT_INITIAL_PAPER_BALANCE,
      currency: "INR",
      updatedAt: new Date().toISOString(),
    };
    this.paperAccounts.set(userId, account);

    // Clear user's open paper trades
    for (const [_id, trade] of this.paperTrades.entries()) {
      if (trade.accountId === account.id && trade.status === "OPEN") {
        trade.status = "CANCELLED";
        trade.closedAt = new Date().toISOString();
      }
    }
    return account;
  }

  public getPaperTrades(userId: string): PaperTradeRecord[] {
    const account = this.getOrCreatePaperAccount(userId);
    return Array.from(this.paperTrades.values()).filter(
      (t) => t.accountId === account.id,
    );
  }

  public async placeOrder(req: OrderPlacementRequest): Promise<OrderResult> {
    if (req.executionMode === "paper") {
      return this.placePaperOrder(req);
    }
    return this.placeLiveUpstoxOrder(req);
  }

  public async exitOrder(req: OrderExitRequest): Promise<OrderResult> {
    if (req.executionMode === "paper") {
      return this.exitPaperOrder(req);
    }
    return this.exitLiveUpstoxOrder(req);
  }

  private async placePaperOrder(
    req: OrderPlacementRequest,
  ): Promise<OrderResult> {
    const account = this.getOrCreatePaperAccount(req.userId);

    // Add 0.1% simulated market slippage
    const slippageMultiplier = req.tradeType === "buying" ? 1.001 : 0.999;
    const filledPrice = Math.round(req.price * slippageMultiplier * 100) / 100;
    const entryValuePaise = Math.round(filledPrice * req.quantity * 100);

    if (req.tradeType === "buying" && account.balance < entryValuePaise) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: `Insufficient paper balance: ₹${(account.balance / 100).toFixed(2)} required ₹${(entryValuePaise / 100).toFixed(2)}`,
      };
    }

    const tradeId = `paper_tr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isSelling = req.tradeType === "selling";
    const entryCharges = calculateOptionCharges(entryValuePaise, isSelling);
    const record: PaperTradeRecord = {
      id: tradeId,
      accountId: account.id,
      status: "OPEN",
      instrumentKey: req.instrumentKey,
      direction: req.direction,
      quantity: req.quantity,
      entryPrice: Math.round(filledPrice * 100),
      entryValue: entryValuePaise,
      openedAt: new Date().toISOString(),
      metadata: {
        tradeType: req.tradeType,
        underlyingSymbol: req.underlyingSymbol,
        entryCharges: {
          totalCharges: entryCharges.totalCharges,
          brokerage: entryCharges.brokerage,
          statutoryTaxes: entryCharges.statutoryTaxes,
        },
      },
    };

    this.paperTrades.set(tradeId, record);
    this.persistTrade(record);

    return {
      success: true,
      tradeId,
      filledPrice,
      quantity: req.quantity,
    };
  }

  private async exitPaperOrder(req: OrderExitRequest): Promise<OrderResult> {
    const account = this.getOrCreatePaperAccount(req.userId);
    const position = req.position;

    // Add 0.1% simulated exit slippage
    const slippageMultiplier = position.tradeType === "selling" ? 1.001 : 0.999;
    const filledExitPrice =
      Math.round(req.exitPrice * slippageMultiplier * 100) / 100;
    const isSelling = position.tradeType === "selling";

    const entryPrice = position.entryPrice;
    const pnlPerUnit = isSelling
      ? entryPrice - filledExitPrice
      : filledExitPrice - entryPrice;
    const grossPnlPaise = Math.round(pnlPerUnit * position.quantity * 100);

    // Fee-adjusted settlement (parity with the Worker's paper engine):
    // realized PnL = gross PnL − (entry charges + exit charges)
    const exitValuePaise = Math.round(
      filledExitPrice * position.quantity * 100,
    );
    const exitCharges = calculateOptionCharges(exitValuePaise, !isSelling);
    const storedRecord = position.paperTradeId
      ? this.paperTrades.get(position.paperTradeId)
      : undefined;
    const entryChargesPaise = Math.round(
      (
        storedRecord?.metadata?.entryCharges as
          | { totalCharges?: number }
          | undefined
      )?.totalCharges ?? 0,
    );
    const totalTradeFeesPaise = entryChargesPaise + exitCharges.totalCharges;
    const realizedPnlPaise = grossPnlPaise - totalTradeFeesPaise;

    account.balance += realizedPnlPaise;
    account.updatedAt = new Date().toISOString();

    if (position.paperTradeId && this.paperTrades.has(position.paperTradeId)) {
      const record = this.paperTrades.get(position.paperTradeId)!;
      record.status = "CLOSED";
      record.exitPrice = Math.round(filledExitPrice * 100);
      record.exitValue = Math.round(filledExitPrice * position.quantity * 100);
      record.realizedPnl = realizedPnlPaise;
      record.closedAt = new Date().toISOString();
      record.metadata = {
        ...(record.metadata || {}),
        exitReason: req.reason,
        exitCharges: {
          totalCharges: exitCharges.totalCharges,
          brokerage: exitCharges.brokerage,
          statutoryTaxes: exitCharges.statutoryTaxes,
        },
        totalTradeFees: totalTradeFeesPaise,
        grossPnl: grossPnlPaise,
      };
      this.persistTrade(record);
    }

    // Persist the updated account balance after every exit
    this.persistAccounts();

    return {
      success: true,
      tradeId: position.paperTradeId || `exit_${Date.now()}`,
      filledPrice: filledExitPrice,
      quantity: position.quantity,
    };
  }

  private async placeLiveUpstoxOrder(
    req: OrderPlacementRequest,
  ): Promise<OrderResult> {
    if (!req.token) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: "Missing Upstox access token",
      };
    }

    const payload = {
      instrument_token: req.instrumentKey,
      quantity: req.quantity,
      transaction_type: req.tradeType === "buying" ? "BUY" : "SELL",
      order_type: "MARKET",
      product: "I",
      validity: "DAY",
      price: 0,
      trigger_price: 0,
      disclosed_quantity: 0,
      is_amo: false,
      tag: `algo-v5-${req.userId.slice(0, 8)}`,
    };

    try {
      // Outbound request executes from the VM's static IP address
      const response = await fetch(`${this.upstoxApiBaseUrl}/order/place`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as any;
      if (!response.ok || data?.status === "error") {
        const errorMsg =
          data?.message || data?.errors?.[0]?.message || "Upstox order failed";
        return {
          success: false,
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error: errorMsg,
        };
      }

      return {
        success: true,
        tradeId: data?.data?.order_id || `upstox_${Date.now()}`,
        filledPrice: req.price,
        quantity: req.quantity,
      };
    } catch (err: any) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: err.message || "Network error reaching Upstox",
      };
    }
  }

  private async exitLiveUpstoxOrder(
    req: OrderExitRequest,
  ): Promise<OrderResult> {
    if (!req.token) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: "Missing Upstox access token",
      };
    }

    const position = req.position;
    const oppositeTransaction =
      position.tradeType === "selling" ? "BUY" : "SELL";

    const payload = {
      instrument_token: position.instrumentKey,
      quantity: position.quantity,
      transaction_type: oppositeTransaction,
      order_type: "MARKET",
      product: "I",
      validity: "DAY",
      price: 0,
      trigger_price: 0,
      disclosed_quantity: 0,
      is_amo: false,
      tag: `exit-${req.reason.slice(0, 10)}`,
    };

    try {
      const response = await fetch(`${this.upstoxApiBaseUrl}/order/place`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as any;
      if (!response.ok || data?.status === "error") {
        const errorMsg = data?.message || "Failed to square off live position";
        return {
          success: false,
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error: errorMsg,
        };
      }

      return {
        success: true,
        tradeId: data?.data?.order_id || `exit_upstox_${Date.now()}`,
        filledPrice: req.exitPrice,
        quantity: position.quantity,
      };
    } catch (err: any) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: err.message,
      };
    }
  }
}
