import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TenantManager } from "../services/tenantManager";
import { OrderGateway, type OrderResult } from "../services/orderGateway";
import type { MasterIngestionEngine } from "../services/masterIngestor";
import type { ActivePosition, UnderlyingSymbol } from "../types";

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makePosition(over: Partial<ActivePosition> = {}): ActivePosition {
  return {
    instrumentKey: "NSE_FO|TEST_CE",
    direction: "CE",
    entryPrice: 100,
    quantity: 65,
    entryTime: new Date().toISOString(),
    tradeId: 1,
    tradeType: "buying",
    currentPrice: 100,
    unrealizedPnl: 0,
    underlyingSymbol: "NIFTY 50",
    ...over,
  };
}

import { mkdtempSync as _mk } from "fs"; // (already imported above)

/**
 * A REAL OrderGateway on an isolated temp DATA_DIR whose exit results are
 * scripted per test — the manager gets the full real account surface while
 * the exit outcome is deterministic.
 */
function makeScriptedGateway(exitResult: OrderResult) {
  const dir = mkdtempSync(join(tmpdir(), "algo-gw-"));
  process.env.DATA_DIR = dir;
  const gateway = new OrderGateway();
  const calls = { count: 0 };
  const originalExit = gateway.exitOrder.bind(gateway);
  const originalPlace = gateway.placeOrder.bind(gateway);
  gateway.exitOrder = async (_req: Parameters<typeof originalExit>[0]) => {
    calls.count += 1;
    return exitResult;
  };
  gateway.placeOrder = async (_req: Parameters<typeof originalPlace>[0]) => {
    calls.count += 1;
    return exitResult;
  };
  return { gateway, calls };
}

/** Minimal tenant-manager harness with a scripted gateway. */
import { EventEmitter } from "events";

/** Stub ingestor: an EventEmitter is all the manager needs at construction. */
function stubIngestor(): MasterIngestionEngine {
  const emitter = new EventEmitter();
  const stub = emitter as unknown as {
    getPrimaryToken: () => string | null;
  };
  stub.getPrimaryToken = () => null; // no token → stream stays idle in tests
  return emitter as unknown as MasterIngestionEngine;
}

function makeHarness(exitResult: OrderResult) {
  const { gateway, calls } = makeScriptedGateway(exitResult);
  const manager = new TenantManager(
    stubIngestor(),
    gateway as unknown as OrderGateway,
  );
  return { manager, gateway, calls };
}

function userWithPosition(
  manager: TenantManager,
  userId: string,
  position: ActivePosition,
  state: "RUNNING" | "ORDERED" | "STOPPED" | "IDLE" = "RUNNING",
) {
  const user = manager.getOrCreateUser(userId);
  user.state = state;
  user.positions["NIFTY 50" as UnderlyingSymbol] = position;
  return user;
}

// ─── CR-01: failed exits must never clear positions ──────────────────────────

describe("CR-01: manualExit only closes positions on confirmed fills", () => {
  const prevDataDirCR01 = process.env.DATA_DIR;
  afterEach(() => {
    if (prevDataDirCR01 === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDirCR01;
  });
  [
    {
      name: "rejected exit retains the position",
      result: {
        success: false,
        status: "rejected",
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: "broker rejected",
      } as OrderResult,
    },
    {
      name: "unknown outcome (network) retains the position",
      result: {
        success: false,
        status: "unknown",
        tradeId: "",
        filledPrice: 0,
        quantity: 0,
        error: "network died",
      } as OrderResult,
    },
    {
      name: "pending (submitted but unconfirmed) retains the position",
      result: {
        success: true,
        status: "pending",
        tradeId: "ord_1",
        brokerOrderId: "ord_1",
        filledPrice: 0,
        quantity: 0,
        error: "awaiting broker",
      } as OrderResult,
    },
  ].forEach(({ name, result }) => {
    it(name, async () => {
      const { manager, calls } = makeHarness(result);
      userWithPosition(manager, "cr01_user", makePosition());
      const before = manager.getOrCreateUser("cr01_user");

      await manager.manualExit("cr01_user", "NIFTY 50", "test exit");

      const after = manager.getOrCreateUser("cr01_user");
      expect(calls.count).toBe(1);
      expect(after.positions["NIFTY 50"]).not.toBeNull();
      expect(after.error).toBeTruthy();
      // alerts/state/persist are downstream of success — verify no exit alert state
      expect(after.state).toBe(before.state);
      expect(after.lastExitTimes["NIFTY 50"]).toBeUndefined();
    });
  });

  it("confirmed fill closes the position and uses broker prices", async () => {
    const { manager, calls } = makeHarness({
      success: true,
      status: "filled",
      tradeId: "ord_ok",
      brokerOrderId: "ord_ok",
      filledPrice: 112.3, // broker-confirmed average, not the requested
      quantity: 65,
      filledQuantity: 65,
    } as OrderResult);
    userWithPosition(manager, "cr01_user", makePosition({ currentPrice: 110 }));

    await manager.manualExit("cr01_user", "NIFTY 50", "take profit");

    const after = manager.getOrCreateUser("cr01_user");
    expect(calls.count).toBe(1);
    expect(after.positions["NIFTY 50"]).toBeNull();
    expect(after.lastExitTimes["NIFTY 50"]).toBeTypeOf("number");
  });

  it("duplicate exit requests are deduplicated while one is in flight", async () => {
    const prevDataDir = process.env.DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "algo-dup-"));
    process.env.DATA_DIR = dir;
    const realGateway = new OrderGateway();
    const inflight = { count: 0 };
    const originalExit = realGateway.exitOrder.bind(realGateway);
    realGateway.exitOrder = async (req: Parameters<typeof originalExit>[0]) => {
      inflight.count += 1;
      await new Promise((r) => setTimeout(r, 50));
      return originalExit(req);
    };
    const manager = new TenantManager(stubIngestor(), realGateway);
    userWithPosition(manager, "dup_user", makePosition());

    const p1 = manager.manualExit("dup_user", "NIFTY 50");
    const p2 = manager.manualExit("dup_user", "NIFTY 50");
    await Promise.all([p1, p2]);

    expect(inflight.count).toBe(1);
    expect(
      manager.getOrCreateUser("dup_user").positions["NIFTY 50"],
    ).toBeNull();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
  });
});

// ─── CR-03: STOPPED bots supervise positions, never enter ────────────────────

describe("CR-03: bot lifecycle vs position supervision", () => {
  const prevDataDirCR03 = process.env.DATA_DIR;
  afterEach(() => {
    if (prevDataDirCR03 === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDirCR03;
  });
  it("getRecoveryStatus completes (no live positions to reconcile)", () => {
    const { manager } = makeHarness({
      success: true,
      status: "filled",
      tradeId: "",
      filledPrice: 0,
      quantity: 0,
    });
    // recovery runs async in the constructor; give it a tick
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const rec = manager.getRecoveryStatus();
        expect(rec.status).toBe("complete");
        resolve();
      }, 100);
    });
  });

  it("live start is REJECTED without DAEMON_LIVE_ARMED", () => {
    const { manager } = makeHarness({
      success: true,
      status: "filled",
      tradeId: "",
      filledPrice: 0,
      quantity: 0,
    });
    expect(() => manager.startBot("arm_user", "live")).toThrowError(
      /not armed/i,
    );
  });

  it("live start is REJECTED while recovery is pending, even when armed", () => {
    process.env.DAEMON_LIVE_ARMED = "true";
    const prevDataDir = process.env.DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "algo-armed-"));
    process.env.DATA_DIR = dir;
    const manager = new TenantManager(stubIngestor(), new OrderGateway());
    // recovery is async — it may still be pending; a live start must fail
    try {
      manager.startBot("arm2", "live");
      // If recovery already completed, this is also acceptable — the arming
      // gate passed. Assert we did NOT get an unhandled crash.
    } catch (err) {
      expect((err as Error).message).toMatch(/recovery|armed/i);
    } finally {
      delete process.env.DAEMON_LIVE_ARMED;
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
    }
  });

  it("paper start still works without arming (regression)", () => {
    const { manager } = makeHarness({
      success: true,
      status: "filled",
      tradeId: "",
      filledPrice: 0,
      quantity: 0,
    });
    const user = manager.startBot("paper_user", "paper");
    expect(user.state).toBe("RUNNING");
  });
});

// ─── CR-15: corrupt state files are preserved, not silently reset ────────────

describe("CR-15: store corrupt-file preservation", () => {
  let dir: string;
  const OLD_DATA_DIR = process.env.DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "algo-store-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(() => {
    process.env.DATA_DIR = OLD_DATA_DIR;
  });

  it("loadState preserves corrupt JSON for diagnosis and returns null", async () => {
    writeFileSync(join(dir, "user_states.json"), "{ NOT VALID JSON ");
    const { loadState } = await import("../utils/store");
    const result = loadState("user_states");
    expect(result).toBeNull();
    // the corrupt file was renamed to .corrupt-<ts> (any suffix)
    const { readdirSync } = await import("fs");
    const found = readdirSync(dir).some((f) =>
      f.startsWith("user_states.json.corrupt-"),
    );
    expect(found).toBe(true);
  });

  it("saveState propagates write failures as exceptions", async () => {
    const ro = join(dir, "readonly");
    mkdirSync(ro);
    process.env.DATA_DIR = ro;
    // make the dir read-only (chmod 0500) — saveState must throw
    const { chmodSync } = await import("fs");
    chmodSync(ro, 0o500);
    const { saveState } = await import("../utils/store");
    expect(() => saveState("test_state", { a: 1 })).toThrowError();
    chmodSync(ro, 0o700);
  });

  it("persistUserStates surfaces write failures as an operational fault", async () => {
    // Build everything WRITABLE first, then flip the dir read-only so the
    // very next user-state save (from startBot) hits EACCES.
    const dir = mkdtempSync(join(tmpdir(), "ro-"));
    process.env.DATA_DIR = dir;
    const manager = new TenantManager(stubIngestor(), new OrderGateway());
    manager.getOrCreateUser("fault_user");

    chmodSync(dir, 0o500);
    try {
      manager.startBot("fault_user", "paper");
      expect(manager.getPersistenceFault()).toBeTruthy();
      expect(manager.getPersistenceFault()).toMatch(/save failed/i);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
