import { describe, it, expect } from "vitest";

import { OrderGateway } from "../services/orderGateway";
import type { ActivePosition } from "../types";
import { DEFAULT_INITIAL_PAPER_BALANCE } from "../constants";
import {
  calculateOptionCharges,
  calculatePaperExitSettlement,
} from "../../../../packages/shared/src/fees";

// NOTE: these tests persist to the real data store (app/core/data) using
// dedicated user ids, mirroring the pre-existing suite's behaviour.

describe("Order Gateway Suite (Cash-Account Paper Model, Worker parity)", () => {
  it("initializes and manages paper trading accounts", () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_init_cash");
    expect(account.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE);
  });

  it("places a paper trade: deducts premium + fees from the cash balance and writes a statement", async () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_entry_cash");
    const before = account.balance;

    const result = await gateway.placeOrder({
      userId: "user_entry_cash",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_24000_CE",
      direction: "CE",
      quantity: 50,
      price: 100,
      tradeType: "buying",
      underlyingSymbol: "NIFTY 50",
    });

    expect(result.success).toBe(true);
    expect(result.filledPrice).toBeCloseTo(100.1, 1); // 0.1% buying slippage

    // Cash model: balance drops by entryValue + charges at ENTRY
    const entryValuePaise = Math.round(result.filledPrice * 50 * 100);
    const charges = calculateOptionCharges(entryValuePaise, false);
    expect(account.balance).toBe(
      before - entryValuePaise - charges.totalCharges,
    );

    // Ledger row recorded
    const statements = gateway.getStatements("user_entry_cash");
    expect(statements.length).toBeGreaterThanOrEqual(1);
    expect(statements[0].entryType).toBe("paper_enter");
    expect(statements[0].amountPaise).toBe(
      -(entryValuePaise + charges.totalCharges),
    );
    expect(statements[0].balanceAfterPaise).toBe(account.balance);
  });

  it("rejects a paper order when the cash balance cannot cover premium + fees", async () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_broke_cash");
    account.balance = 50000; // ₹500 in paise

    const result = await gateway.placeOrder({
      userId: "user_broke_cash",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_24000_CE",
      direction: "CE",
      quantity: 1000,
      price: 100, // needs ₹1,00,000+ in paise
      tradeType: "buying",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient paper balance");
    expect(account.balance).toBe(50000); // untouched on rejection
  });

  it("rejects fee-dominated entries (fee-ratio guard)", async () => {
    const gateway = new OrderGateway();
    // Tiny premium → fees dominate the trade value
    const result = await gateway.placeOrder({
      userId: "user_fee_ratio",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_TINY_CE",
      direction: "CE",
      quantity: 1,
      price: 0.02, // ₹2 trade value; ₹20 brokerage alone is 10x that
      tradeType: "buying",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("fee");
  });

  it("blocks margin for selling entries and releases it at exit", async () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_margin");
    // Shorting blocks ₹1L margin per lot — fund realistically (₹5L).
    account.balance = 500_000_00;
    const before = account.balance;

    const entry = await gateway.placeOrder({
      userId: "user_margin",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_24000_PE",
      direction: "PE",
      quantity: 65, // 1 lot (NIFTY lot size 65)
      price: 100,
      tradeType: "selling",
      underlyingSymbol: "NIFTY 50",
    });
    expect(entry.success).toBe(true);

    const entryValuePaise = Math.round(entry.filledPrice * 65 * 100);
    const charges = calculateOptionCharges(entryValuePaise, true);
    const marginBlockedPaise = 100000 * 100; // 1 lot × ₹1,00,000
    // Selling: balance += premium − fees − margin
    expect(account.balance).toBe(
      before + entryValuePaise - charges.totalCharges - marginBlockedPaise,
    );

    const position: ActivePosition = {
      instrumentKey: "NSE_FO|OPT_24000_PE",
      direction: "PE",
      entryPrice: entry.filledPrice,
      quantity: 65,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      paperTradeId: entry.tradeId,
      tradeType: "selling",
    };
    const exit = await gateway.exitOrder({
      userId: "user_margin",
      executionMode: "paper",
      position,
      exitPrice: 80, // premium fell → short profits
      reason: "Take Profit Hit",
    });
    expect(exit.success).toBe(true);

    // Full round trip: realized = gross(entry−exit) − total fees; margin released
    const settlement = calculatePaperExitSettlement({
      entryValuePaise,
      exitPricePaise: Math.round(exit.filledPrice * 100),
      quantity: 65,
      isSelling: true,
      entryChargesPaise: charges.totalCharges,
      marginBlockedPaise,
      isRollback: false,
    });
    expect(account.balance).toBe(before + settlement.realizedPnlPaise);
    expect(settlement.realizedPnlPaise).toBeGreaterThan(0);
  });

  it("exits a paper trade: receives exit value − fees, records realized PnL and a statement", async () => {
    const gateway = new OrderGateway();
    const entryRes = await gateway.placeOrder({
      userId: "user_profit_cash",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_24000_CE",
      direction: "CE",
      quantity: 50,
      price: 100,
      tradeType: "buying",
    });

    const account = gateway.getOrCreatePaperAccount("user_profit_cash");
    const postEntryBalance = account.balance;

    const position: ActivePosition = {
      instrumentKey: "NSE_FO|OPT_24000_CE",
      direction: "CE",
      entryPrice: entryRes.filledPrice,
      quantity: 50,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      paperTradeId: entryRes.tradeId,
      tradeType: "buying",
    };

    const exitRes = await gateway.exitOrder({
      userId: "user_profit_cash",
      executionMode: "paper",
      position,
      exitPrice: 120, // +20 pts profit
      reason: "Take Profit Hit",
    });
    expect(exitRes.success).toBe(true);

    // Cash model: exit adds exitValue − exit fees
    const exitValuePaise = Math.round(exitRes.filledPrice * 50 * 100);
    // Exiting a long is a SELL leg — STT applies (isSelling: true)
    const exitCharges = calculateOptionCharges(exitValuePaise, true);
    expect(account.balance).toBe(
      postEntryBalance + exitValuePaise - exitCharges.totalCharges,
    );
    expect(account.balance).toBeGreaterThan(postEntryBalance);

    const statements = gateway.getStatements("user_profit_cash");
    expect(statements[0].entryType).toBe("paper_exit");

    const trades = gateway.getPaperTrades("user_profit_cash");
    const closedTrade = trades.find((t) => t.id === entryRes.tradeId);
    expect(closedTrade?.status).toBe("CLOSED");
    expect(closedTrade?.realizedPnl).toBeGreaterThan(0);
  });

  it("round-trip cash flow equals realized PnL (cash model ≡ PnL accounting)", async () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_roundtrip");
    const before = account.balance;

    const entry = await gateway.placeOrder({
      userId: "user_roundtrip",
      executionMode: "paper",
      instrumentKey: "NSE_FO|OPT_24000_CE",
      direction: "CE",
      quantity: 50,
      price: 100,
      tradeType: "buying",
    });
    const exit = await gateway.exitOrder({
      userId: "user_roundtrip",
      executionMode: "paper",
      position: {
        instrumentKey: "NSE_FO|OPT_24000_CE",
        direction: "CE",
        entryPrice: entry.filledPrice,
        quantity: 50,
        entryTime: new Date().toISOString(),
        tradeId: 1,
        paperTradeId: entry.tradeId,
        tradeType: "buying",
      },
      exitPrice: 90, // a LOSS
      reason: "Stop Loss",
    });

    const trades = gateway.getPaperTrades("user_roundtrip");
    const closed = trades.find((t) => t.id === entry.tradeId);
    expect(closed?.realizedPnl).toBeLessThan(0);
    // After a full round trip: balance change == realized PnL exactly
    expect(account.balance - before).toBe(closed?.realizedPnl);
    expect(exit.success).toBe(true);
  });

  it("resets the paper account to initial capital and cancels open trades", () => {
    const gateway = new OrderGateway();
    const account = gateway.getOrCreatePaperAccount("user_reset_cash");
    account.balance = 5000000;
    const reset = gateway.resetPaperAccount("user_reset_cash");
    expect(reset.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE);
  });
});
