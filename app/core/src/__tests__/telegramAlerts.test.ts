import { describe, it, expect } from "vitest";

/**
 * Alert-builder unification guard.
 *
 * The daemon must CONSUME the browser client's Telegram message builders
 * (app/client/src/lib/telegram.ts) — the single source of truth for alert
 * wording. These tests assert REFERENCE IDENTITY so any future
 * re-introduction of parallel formatting fails immediately.
 *
 * The builders' behavior is tested in the client suite
 * (app/client/src/lib/__tests__/telegramAlerts.test.ts). The transport
 * (sendTelegramMessage — direct Telegram API) is legitimately daemon-only.
 */
import * as clientTelegram from "../../../client/src/lib/telegram";

import * as daemonTelegram from "../services/telegramAlerts";

describe("Alert-builder unification — daemon consumes the client builders", () => {
  it("entry/exit builders are the client functions", () => {
    expect(daemonTelegram.buildEntryAlertMessage).toBe(
      clientTelegram.buildEntryAlertMessage,
    );
    expect(daemonTelegram.buildExitAlertMessage).toBe(
      clientTelegram.buildExitAlertMessage,
    );
  });

  it("VIX + daily-summary builders are the client functions", () => {
    expect(daemonTelegram.buildVixAlertMessage).toBe(
      clientTelegram.buildVixAlertMessage,
    );
    expect(daemonTelegram.buildDailySummaryMessage).toBe(
      clientTelegram.buildDailySummaryMessage,
    );
  });

  it("the daemon keeps only its own transport (not the browser sender)", () => {
    expect(typeof daemonTelegram.sendTelegramMessage).toBe("function");
    expect(typeof daemonTelegram.getTelegramConfig).toBe("function");
  });
});
