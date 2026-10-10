import { describe, it, expect } from "vitest";

/**
 * Engine unification guard.
 *
 * The daemon must CONSUME the browser client's calculation engine — the
 * client's files are the single source of truth for all trading math.
 * These tests assert REFERENCE IDENTITY: the daemon's service modules must
 * resolve to the very same function objects the client exports. Any future
 * re-introduction of a local copy (the root cause of 10 historical
 * divergences) fails here immediately.
 *
 * The math itself is verified by the client's own suites
 * (app/client/src/lib/__tests__/**) and the live parity gate
 * (daemonLiveParity.test.ts) — this file only guards the wiring.
 */
import * as clientIndicators from "../../../client/src/lib/indicators";
import * as clientStrategyEngine from "../../../client/src/lib/strategyEngine";
import * as clientVrdSignals from "../../../client/src/lib/vrdSignals";
import * as clientSyntheticCalculators from "../../../client/src/lib/syntheticCalculators";
import * as clientV3Sentiment from "../../../client/src/lib/v3Sentiment";
import * as clientBacktestEngine from "../../../client/src/lib/backtestEngine";

import * as daemonIndicators from "../services/indicators";
import * as daemonStrategyEngine from "../services/strategyEngine";
import * as daemonVrdSignals from "../services/vrdSignals";
import * as daemonSyntheticCalculators from "../services/syntheticCalculators";
import * as daemonV3Sentiment from "../services/v3Sentiment";
import * as daemonBacktestEngine from "../services/backtestEngine";

describe("Engine unification — daemon consumes the client engine", () => {
  it("indicators are the client functions", () => {
    expect(daemonIndicators.computeAllIndicators).toBe(
      clientIndicators.computeAllIndicators,
    );
    expect(daemonIndicators.getOtmStrike).toBe(clientIndicators.getOtmStrike);
    expect(daemonIndicators.resampleCandles).toBe(
      clientIndicators.resampleCandles,
    );
    expect(daemonIndicators.calcHigherTimeframeTrend).toBe(
      clientIndicators.calcHigherTimeframeTrend,
    );
  });

  it("strategy engine functions are the client functions", () => {
    expect(daemonStrategyEngine.getFinalSignal).toBe(
      clientStrategyEngine.getFinalSignal,
    );
    expect(daemonStrategyEngine.shouldExit).toBe(
      clientStrategyEngine.shouldExit,
    );
    expect(daemonStrategyEngine.runHardStopChecks).toBe(
      clientStrategyEngine.runHardStopChecks,
    );
    expect(daemonStrategyEngine.scoreBullish).toBe(
      clientStrategyEngine.scoreBullish,
    );
    expect(daemonStrategyEngine.scoreBearish).toBe(
      clientStrategyEngine.scoreBearish,
    );
  });

  it("VRD scorers + news classification are the client functions", () => {
    expect(daemonVrdSignals.scoreMMI).toBe(clientVrdSignals.scoreMMI);
    expect(daemonVrdSignals.scoreADRatio).toBe(clientVrdSignals.scoreADRatio);
    expect(daemonVrdSignals.scoreFiiLongShort).toBe(
      clientVrdSignals.scoreFiiLongShort,
    );
    expect(daemonVrdSignals.scoreFiiPositioning).toBe(
      clientVrdSignals.scoreFiiPositioning,
    );
    expect(daemonVrdSignals.scoreNiftyPE).toBe(clientVrdSignals.scoreNiftyPE);
    expect(daemonVrdSignals.scoreVix).toBe(clientVrdSignals.scoreVix);
    expect(daemonVrdSignals.scoreStraddleIV).toBe(
      clientVrdSignals.scoreStraddleIV,
    );
    expect(daemonVrdSignals.classifyNews).toBe(clientVrdSignals.classifyNews);
  });

  it("synthetic calculators are the client functions", () => {
    expect(daemonSyntheticCalculators.computeMMI).toBe(
      clientSyntheticCalculators.computeMMI,
    );
    expect(daemonSyntheticCalculators.computeStraddleIV).toBe(
      clientSyntheticCalculators.computeStraddleIV,
    );
    expect(daemonSyntheticCalculators.computeProxyFlow).toBe(
      clientSyntheticCalculators.computeProxyFlow,
    );
    expect(daemonSyntheticCalculators.computeProxyValuation).toBe(
      clientSyntheticCalculators.computeProxyValuation,
    );
    expect(daemonSyntheticCalculators.getLotSizeForSymbol).toBe(
      clientSyntheticCalculators.getLotSizeForSymbol,
    );
  });

  it("V3 evaluators are the client functions (computeV3Signal is daemon glue)", () => {
    expect(daemonV3Sentiment.evaluateGlobalSentiment).toBe(
      clientV3Sentiment.evaluateGlobalSentiment,
    );
    expect(daemonV3Sentiment.evaluatePCR).toBe(clientV3Sentiment.evaluatePCR);
    expect(daemonV3Sentiment.getV3Signal).toBe(clientV3Sentiment.getV3Signal);
    expect(typeof daemonV3Sentiment.computeV3Signal).toBe("function");
  });

  it("backtest engine is the client engine (fetch is daemon-local)", () => {
    expect(daemonBacktestEngine.runBacktest).toBe(
      clientBacktestEngine.runBacktest,
    );
    expect(daemonBacktestEngine.approximatePremium).toBe(
      clientBacktestEngine.approximatePremium,
    );
    expect(daemonBacktestEngine.getBacktestDefaults).toBe(
      clientBacktestEngine.getBacktestDefaults,
    );
    expect(typeof daemonBacktestEngine.fetchHistoricalCandles).toBe("function");
  });
});
