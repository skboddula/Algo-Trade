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
// Fee model + settlement — single source of truth in
// packages/shared/src/fees.ts (shared with the Worker's D1 paper engine).
export {
  calculateOptionCharges,
  calculatePaperExitSettlement,
  MAX_PAPER_ENTRY_FEE_RATIO,
  type OptionCharges,
  type PaperExitSettlement,
  type PaperExitSettlementInput,
} from "../../../../packages/shared/src/fees";
import {
  calculateOptionCharges,
  calculatePaperExitSettlement,
  MAX_PAPER_ENTRY_FEE_RATIO,
} from "../../../../packages/shared/src/fees";
import { getLotSizeForSymbol } from "../../../client/src/lib/syntheticCalculators";

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
  /** Strike + expiry recorded on the paper trade for dashboards/alerts. */
  strikePrice?: number;
  expiry?: string;
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

/** Broker-style statement entry (cash-account ledger, Worker parity). */
export interface PaperStatementEntry {
  id: string;
  accountId: string;
  entryType: "paper_enter" | "paper_exit";
  amountPaise: number;
  balanceBeforePaise: number;
  balanceAfterPaise: number;
  note: string;
  createdAt: string;
}

/** Default margin blocked per lot for short (selling) positions, in paise. */
const MARGIN_PER_LOT_PAISE = 100000 * 100; // ₹1,00,000 per lot

export class OrderGateway {
  private paperAccounts: Map<string, PaperAccount> = new Map();
  private paperTrades: Map<string, PaperTradeRecord> = new Map();
  private paperStatements: PaperStatementEntry[] = [];
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

    this.paperStatements =
      loadRecords<PaperStatementEntry>("paper_statements").slice(-500);
    console.log(
      `[orderGateway] Restored ${this.paperStatements.length} statement(s) from disk`,
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

  /** Records a broker-style statement row and persists it. */
  private recordStatement(
    account: PaperAccount,
    entryType: PaperStatementEntry["entryType"],
    amountPaise: number,
    balanceBeforePaise: number,
    note: string,
  ): void {
    const entry: PaperStatementEntry = {
      id: `stmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      accountId: account.id,
      entryType,
      amountPaise,
      balanceBeforePaise,
      balanceAfterPaise: account.balance,
      note,
      createdAt: new Date().toISOString(),
    };
    this.paperStatements.push(entry);
    if (this.paperStatements.length > 500) {
      this.paperStatements.splice(0, this.paperStatements.length - 500);
    }
    appendRecord("paper_statements", entry);
  }

  /** Recent statement entries for an account (newest first). */
  public getStatements(userId: string, limit = 50): PaperStatementEntry[] {
    const account = this.getOrCreatePaperAccount(userId);
    return this.paperStatements
      .filter((s) => s.accountId === account.id)
      .slice(-limit)
      .reverse();
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

    // 0.1% simulated market slippage
    const slippageMultiplier = req.tradeType === "buying" ? 1.001 : 0.999;
    const filledPrice = Math.round(req.price * slippageMultiplier * 100) / 100;
    const entryValuePaise = Math.round(filledPrice * req.quantity * 100);
    const isSelling = req.tradeType === "selling";

    const entryCharges = calculateOptionCharges(entryValuePaise, isSelling);

    // Fee-ratio guard (Worker parity): reject fee-dominated trades
    if (
      entryValuePaise > 0 &&
      entryCharges.totalCharges / entryValuePaise > MAX_PAPER_ENTRY_FEE_RATIO
    ) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: `Paper entry rejected: fees are ${((entryCharges.totalCharges / entryValuePaise) * 100).toFixed(2)}% of the trade value`,
      };
    }

    // Cash model (Worker parity): selling blocks margin per lot; the
    // premium is received minus fees. Buying pays premium plus fees.
    const lotSize = getLotSizeForSymbol(
      req.underlyingSymbol || req.instrumentKey,
    );
    const marginBlockedPaise = isSelling
      ? Math.round((req.quantity / lotSize) * MARGIN_PER_LOT_PAISE)
      : 0;
    const netChangePaise = isSelling
      ? entryValuePaise - entryCharges.totalCharges - marginBlockedPaise
      : -(entryValuePaise + entryCharges.totalCharges);

    // Affordability: buying needs premium + fees; selling needs the
    // blocked margin + fees (the premium itself is received).
    const requiredPaise = isSelling
      ? marginBlockedPaise + entryCharges.totalCharges
      : entryValuePaise + entryCharges.totalCharges;
    if (account.balance < requiredPaise) {
      return {
        success: false,
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: `Insufficient paper balance: ₹${(account.balance / 100).toFixed(2)} required ₹${(requiredPaise / 100).toFixed(2)}`,
      };
    }

    const tradeId = `paper_tr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const balanceBeforePaise = account.balance;
    account.balance += netChangePaise;
    account.updatedAt = new Date().toISOString();

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
        strikePrice: req.strikePrice,
        expiry: req.expiry,
        entryCharges: {
          totalCharges: entryCharges.totalCharges,
          brokerage: entryCharges.brokerage,
          statutoryTaxes: entryCharges.statutoryTaxes,
        },
        // Rupees, matching the Worker's metadata convention
        marginBlocked: marginBlockedPaise / 100,
      },
    };

    this.paperTrades.set(tradeId, record);
    this.persistTrade(record);
    this.recordStatement(
      account,
      "paper_enter",
      netChangePaise,
      balanceBeforePaise,
      isSelling
        ? `Paper SELL ${req.direction} (Fee: ₹${(entryCharges.totalCharges / 100).toFixed(2)}, Margin blocked: ₹${(marginBlockedPaise / 100).toFixed(2)})`
        : `Paper BUY ${req.direction} (Fee: ₹${(entryCharges.totalCharges / 100).toFixed(2)})`,
    );
    this.persistAccounts();

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

    // 0.1% simulated exit slippage
    const slippageMultiplier = position.tradeType === "selling" ? 1.001 : 0.999;
    const filledExitPrice =
      Math.round(req.exitPrice * slippageMultiplier * 100) / 100;
    const isSelling = position.tradeType === "selling";

    const storedRecord = position.paperTradeId
      ? this.paperTrades.get(position.paperTradeId)
      : undefined;
    const entryValuePaise =
      storedRecord?.entryValue ??
      Math.round(position.entryPrice * position.quantity * 100);
    const entryChargesPaise = Math.round(
      (
        storedRecord?.metadata?.entryCharges as
          | { totalCharges?: number }
          | undefined
      )?.totalCharges ?? 0,
    );
    const marginBlockedPaise = Math.round(
      ((storedRecord?.metadata?.marginBlocked as number | undefined) ?? 0) *
        100,
    );

    // Cash-account settlement (shared canonical, Worker parity)
    const settlement = calculatePaperExitSettlement({
      entryValuePaise,
      exitPricePaise: Math.round(filledExitPrice * 100),
      quantity: position.quantity,
      isSelling,
      entryChargesPaise,
      marginBlockedPaise,
      isRollback: false,
    });

    const balanceBeforePaise = account.balance;
    account.balance += settlement.netChangePaise;
    account.updatedAt = new Date().toISOString();

    if (position.paperTradeId && this.paperTrades.has(position.paperTradeId)) {
      const record = this.paperTrades.get(position.paperTradeId)!;
      record.status = "CLOSED";
      record.exitPrice = Math.round(filledExitPrice * 100);
      record.exitValue = settlement.exitValuePaise;
      record.realizedPnl = settlement.realizedPnlPaise;
      record.closedAt = new Date().toISOString();
      record.metadata = {
        ...(record.metadata || {}),
        exitReason: req.reason,
        exitCharges: {
          totalCharges: settlement.exitCharges.totalCharges,
          brokerage: settlement.exitCharges.brokerage,
          statutoryTaxes: settlement.exitCharges.statutoryTaxes,
        },
        totalTradeFees: settlement.totalTradeFeesPaise,
        grossPnl: settlement.grossPnlPaise,
      };
      this.persistTrade(record);
    }

    this.recordStatement(
      account,
      "paper_exit",
      settlement.netChangePaise,
      balanceBeforePaise,
      `Paper EXIT ${position.direction} (Fee: ₹${(settlement.exitCharges.totalCharges / 100).toFixed(2)}, PnL: ₹${(settlement.realizedPnlPaise / 100).toFixed(2)}) — ${req.reason}`,
    );
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
