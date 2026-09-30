import test from "node:test";

import { capturePerceptionBaselines } from "../lib/perception-baseline-runner.mjs";

test("live perception harness runs only with an explicitly configured BSK CLI", async (t) => {
  const bskCommand = process.env.BSK_PERCEPTION_COMMAND;
  if (!bskCommand) {
    t.skip("set BSK_PERCEPTION_COMMAND to a connected BSK CLI to capture live evidence");
    return;
  }
  const report = await capturePerceptionBaselines({ bskCommand });
  assertLiveReport(report);
});

function assertLiveReport(report) {
  if (report.status !== "captured") throw new Error(`live capture status: ${report.status}`);
  for (const [scenario, evidence] of Object.entries(report.scenarios)) {
    if (!evidence.steps.some(({ label }) => label === "snapshot")) {
      throw new Error(`${scenario} has no real snapshot result`);
    }
    if (!evidence.steps.some(({ label }) => label === "observe")) {
      throw new Error(`${scenario} has no real observe result`);
    }
    for (const step of evidence.steps) {
      if (!Number.isInteger(step.metrics.textBytes) || !Number.isInteger(step.metrics.nodeProxyCount)) {
        throw new Error(`${scenario}/${step.label} has incomplete live metrics`);
      }
    }
  }
}
