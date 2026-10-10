/**
 * Strategy engine — re-exported from the BROWSER CLIENT.
 *
 * Exposes the client's exact functions:
 *  - getFinalSignal   (5-layer scoring + confluence/multi-TF/immediate-exit gates)
 *  - shouldExit       (position exit supervision: profit/SL/trailing/V4/V3/breadth)
 *  - runHardStopChecks(vrd) (entry hard-stop gate: VIX tradeability band + macro news)
 *  - scoreBullish / scoreBearish
 *
 * Never re-implement anything here — extend app/client/src/lib/strategyEngine.ts.
 */
export * from "../../../client/src/lib/strategyEngine";
