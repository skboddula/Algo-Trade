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

/**
 * Order lifecycle result. `success` alone must NEVER be read as "filled":
 * for live orders, SUBMISSION success means the broker accepted the order
 * (status "pending" with a brokerOrderId); only status "filled" means the
 * broker confirmed execution, and then filledPrice/quantity come from the
 * broker's own confirmation, not from the request. Paper orders are an
 * instant-fill simulation by design and always resolve to "filled".
 */
export interface OrderResult {
  success: boolean;
  tradeId: string;
  filledPrice: number;
  quantity: number;
  error?: string;
  /** Lifecycle: filled (confirmed) | pending (submitted, unconfirmed) |
   *  rejected | unknown (submission outcome could not be determined). */
  status?: "filled" | "pending" | "rejected" | "unknown";
  /** Broker order id as soon as it is available (live orders). */
  brokerOrderId?: string;
  /** Broker-confirmed filled quantity (differs from requested on partial fills). */
  filledQuantity?: number;
  /** True when the exit/entry was reconciled rather than directly confirmed. */
  reconciled?: boolean;
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
        startingBalance: DEFAULT_INITIAL_PAPER_BALANCE,
        currency: "INR",
        updatedAt: new Date().toISOString(),
      };
      this.paperAccounts.set(userId, account);
      this.persistAccounts();
    }
    return account;
  }

  public resetPaperAccount(userId: string): PaperAccount {
    const account: PaperAccount = {
      id: `paper_acc_${userId}`,
      userId,
      balance: DEFAULT_INITIAL_PAPER_BALANCE,
      startingBalance: DEFAULT_INITIAL_PAPER_BALANCE,
      currency: "INR",
      updatedAt: new Date().toISOString(),
    };
    this.paperAccounts.set(userId, account);

    // Cancel open paper trades and persist each cancellation so a restart
    // cannot resurrect them (the trade log is append-only).
    for (const [_id, trade] of this.paperTrades.entries()) {
      if (trade.accountId === account.id && trade.status === "OPEN") {
        trade.status = "CANCELLED";
        trade.closedAt = new Date().toISOString();
        this.persistTrade(trade);
      }
    }

    // Audit trail: a ledger row proving the reset happened and why
    this.recordStatement(
      account,
      "paper_enter",
      account.balance,
      0,
      "Paper account RESET — balance restored to initial capital",
    );

    // Persist account state so a restart cannot revert the reset
    this.persistAccounts();
    return account;
  }

  public getPaperTrades(userId: string): PaperTradeRecord[] {
    const account = this.getOrCreatePaperAccount(userId);
    return Array.from(this.paperTrades.values()).filter(
      (t) => t.accountId === account.id,
    );
  }

  public async placeOrder(req: OrderPlacementRequest): Promise<OrderResult> {
    // CR-01 isolation: fail-CLOSED. Only an explicit "live" can reach the
    // broker order API. "paper" routes to the simulation. Anything else
    // (undefined, null, malformed) is REJECTED — never silently treated
    // as either mode. A typo or missing field cannot submit real orders.
    if (req.executionMode === "live") {
      return this.placeLiveUpstoxOrder(req);
    }
    if (req.executionMode === "paper") {
      return this.placePaperOrder(req);
    }
    return {
      success: false,
      status: "rejected",
      tradeId: "",
      filledPrice: 0,
      quantity: 0,
      error: `Invalid executionMode "${String(req.executionMode)}" — must be "paper" or "live". Order rejected.`,
    };
  }

  public async exitOrder(req: OrderExitRequest): Promise<OrderResult> {
    // CR-01 isolation: same fail-closed dispatch for exits
    if (req.executionMode === "live") {
      return this.exitLiveUpstoxOrder(req);
    }
    if (req.executionMode === "paper") {
      return this.exitPaperOrder(req);
    }
    return {
      success: false,
      status: "rejected",
      tradeId: "",
      filledPrice: 0,
      quantity: 0,
      error: `Invalid executionMode "${String(req.executionMode)}" — must be "paper" or "live". Exit rejected.`,
    };
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
      status: "filled",
      tradeId,
      filledPrice,
      quantity: req.quantity,
    };
  }

  private async exitPaperOrder(req: OrderExitRequest): Promise<OrderResult> {
    const account = this.getOrCreatePaperAccount(req.userId);
    const position = req.position;

    // CR-02: duplicate-exit ledger guard — an already-CLOSED trade must
    // never be settled again (double-credit). The tenant-level pendingExit
    // flag prevents concurrent duplicates; this is the gateway-level guard
    // for sequential re-submissions.
    const preCheckRecord = position.paperTradeId
      ? this.paperTrades.get(position.paperTradeId)
      : undefined;
    if (preCheckRecord?.status === "CLOSED") {
      return {
        success: false,
        status: "rejected",
        tradeId: position.paperTradeId ?? "",
        filledPrice: preCheckRecord.exitPrice ?? 0,
        quantity: preCheckRecord.quantity,
        error: `Trade ${position.paperTradeId} is already CLOSED — duplicate exit rejected (ledger unchanged)`,
      };
    }

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
          { totalCharges?: number } | undefined
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
      status: "filled",
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
        status: "rejected",
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

    // ── Stage 1: SUBMIT ──────────────────────────────────────────────────
    // An accepted submission is NOT a fill. Capture the broker order id
    // immediately; the caller gets status "pending" unless the broker has
    // already confirmed execution in the response.
    let brokerOrderId: string | null = null;
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

      let data: Record<string, unknown> | null = null;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        data = null;
      }

      if (!response.ok || data?.status === "error") {
        const dataRecord = data as {
          message?: string;
          errors?: { message?: string }[];
        } | null;
        const errorMsg =
          dataRecord?.message ||
          dataRecord?.errors?.[0]?.message ||
          `Upstox order rejected (HTTP ${response.status})`;
        return {
          success: false,
          status: "rejected",
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error: errorMsg,
        };
      }

      const orderId =
        (data as { data?: { order_id?: string } } | null)?.data?.order_id ??
        null;
      if (!orderId) {
        // Accepted HTTP response with no order id: outcome UNKNOWN — do
        // NOT invent success or failure. The caller must reconcile.
        return {
          success: false,
          status: "unknown",
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error:
            "Upstox acknowledged the request without an order id — order outcome unknown; reconcile against the broker order book before assuming anything",
        };
      }
      brokerOrderId = orderId;
    } catch (err) {
      // Network failure mid-submit: the order MAY have reached the broker.
      return {
        success: false,
        status: "unknown",
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: `Order submission outcome unknown (network error: ${(err as Error).message}); reconcile against the broker order book before retrying`,
      };
    }

    // ── Stage 2: CONFIRM via the broker order book (bounded polling) ─────
    // Only broker-confirmed state may produce a filled position; filled
    // quantity and average price come from the broker, not the request.
    const confirmation = await this.confirmLiveOrder(req.token, brokerOrderId);
    if (confirmation.status === "filled") {
      return {
        success: true,
        status: "filled",
        tradeId: brokerOrderId,
        brokerOrderId,
        filledPrice: confirmation.averagePrice,
        quantity: confirmation.filledQuantity,
        filledQuantity: confirmation.filledQuantity,
      };
    }
    if (confirmation.status === "rejected") {
      return {
        success: false,
        status: "rejected",
        tradeId: brokerOrderId,
        brokerOrderId,
        filledPrice: 0,
        quantity: 0,
        error: confirmation.message ?? "Broker rejected the order",
      };
    }
    // Still pending (or poll failed): report pending with the order id so
    // the caller can hold an explicit pending state and reconcile later.
    return {
      success: true,
      status: "pending",
      tradeId: brokerOrderId,
      brokerOrderId,
      filledPrice: 0,
      quantity: 0,
      error:
        confirmation.message ?? "Order submitted; awaiting broker confirmation",
    };
  }

  /**
   * Polls the Upstox order details endpoint (bounded attempts) until the
   * order reaches a terminal state or the poll budget is exhausted.
   * Never fabricates a fill: "pending" is returned when unconfirmed.
   */
  private async confirmLiveOrder(
    token: string,
    orderId: string,
    opts?: { attempts?: number; intervalMs?: number },
  ): Promise<
    | { status: "filled"; filledQuantity: number; averagePrice: number }
    | { status: "rejected"; message?: string }
    | { status: "pending"; message?: string }
  > {
    const attempts = opts?.attempts ?? 3;
    const intervalMs = opts?.intervalMs ?? 500;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      try {
        const res = await fetch(
          `${this.upstoxApiBaseUrl}/order/details?order_id=${encodeURIComponent(orderId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
          },
        );
        if (!res.ok) {
          // Transient failure — keep polling within the budget
          continue;
        }
        const raw = (await res.json()) as {
          data?: Array<{
            status?: string;
            filled_quantity?: number;
            average_price?: number;
            message?: string;
            total_quantity?: number;
          }>;
        };
        const order = raw.data?.[0];
        if (!order)
          return { status: "pending", message: "No order details yet" };
        const status = (order.status ?? "").toLowerCase();
        if (status === "complete" || status === "filled") {
          const filledQuantity = Number(order.filled_quantity ?? 0);
          const averagePrice = Number(order.average_price ?? 0);
          if (filledQuantity > 0 && averagePrice > 0) {
            return { status: "filled", filledQuantity, averagePrice };
          }
          // Complete without fill data — treat as pending, never invent prices
          return {
            status: "pending",
            message:
              "Order complete but fill data missing — reconcile required",
          };
        }
        if (
          status === "rejected" ||
          status === "cancelled" ||
          status === "rejected_by_ams"
        ) {
          return { status: "rejected", message: order.message ?? status };
        }
        // open/pending states — keep polling
      } catch {
        // network glitch — keep polling within the budget
      }
    }
    return {
      status: "pending",
      message: `Order ${orderId} not confirmed within ${attempts} attempts — hold as pending and reconcile`,
    };
  }

  private async exitLiveUpstoxOrder(
    req: OrderExitRequest,
  ): Promise<OrderResult> {
    if (!req.token) {
      return {
        success: false,
        status: "rejected",
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

    // ── Stage 1: SUBMIT — capture the broker order id, never assume fill ──
    let brokerOrderId: string | null = null;
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

      let data: Record<string, unknown> | null = null;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        data = null;
      }

      if (!response.ok || data?.status === "error") {
        const dataRecord = data as {
          message?: string;
          errors?: { message?: string }[];
        } | null;
        return {
          success: false,
          status: "rejected",
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error:
            dataRecord?.message ||
            dataRecord?.errors?.[0]?.message ||
            `Live exit rejected (HTTP ${response.status})`,
        };
      }

      brokerOrderId =
        (data as { data?: { order_id?: string } } | null)?.data?.order_id ??
        null;
      if (!brokerOrderId) {
        return {
          success: false,
          status: "unknown",
          tradeId: "",
          filledPrice: 0,
          quantity: 0,
          error:
            "Exit order acknowledged without an order id — outcome unknown; reconcile against the broker order book before retrying (the position may already be closed)",
        };
      }
    } catch (err) {
      return {
        success: false,
        status: "unknown",
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: `Exit submission outcome unknown (network error: ${(err as Error).message}); reconcile before retrying`,
      };
    }

    // ── Stage 2: CONFIRM — only broker-confirmed fills close a position ──
    const confirmation = await this.confirmLiveOrder(req.token, brokerOrderId);
    if (confirmation.status === "filled") {
      return {
        success: true,
        status: "filled",
        tradeId: brokerOrderId,
        brokerOrderId,
        filledPrice: confirmation.averagePrice,
        quantity: confirmation.filledQuantity,
        filledQuantity: confirmation.filledQuantity,
      };
    }
    if (confirmation.status === "rejected") {
      return {
        success: false,
        status: "rejected",
        tradeId: brokerOrderId,
        brokerOrderId,
        filledPrice: 0,
        quantity: 0,
        error: confirmation.message ?? "Broker rejected the exit order",
      };
    }
    return {
      success: true,
      status: "pending",
      tradeId: brokerOrderId,
      brokerOrderId,
      filledPrice: 0,
      quantity: 0,
      error:
        confirmation.message ?? "Exit submitted; awaiting broker confirmation",
    };
  }

  /**
   * Fetches the broker's CURRENT open positions (Upstox order & positions
   * API) for startup reconciliation (CR-04). Returns null when the broker
   * API is unreachable so callers can fail safe rather than guess.
   */
  public async getLivePositions(token: string): Promise<Array<{
    instrumentKey: string;
    quantity: number;
    averagePrice: number;
    product: string;
  }> | null> {
    try {
      const res = await fetch(`${this.upstoxApiBaseUrl}/order&positions`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) return null;
      const raw = (await res.json()) as {
        data?: Array<{
          instrument_token?: string;
          quantity?: number;
          average_price?: number;
          product?: string;
        }>;
      };
      return (raw.data ?? [])
        .filter((row) => Number(row.quantity ?? 0) !== 0)
        .map((row) => ({
          instrumentKey: row.instrument_token ?? "",
          quantity: Number(row.quantity ?? 0),
          averagePrice: Number(row.average_price ?? 0),
          product: row.product ?? "",
        }));
    } catch {
      return null;
    }
  }
}
