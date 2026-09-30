import { randomUUID } from "node:crypto";

import { createEvalServer } from "./server.mjs";
import { runProcess } from "./process.mjs";

const SCENARIOS = [
  "ordinary-form",
  "duplicate-controls",
  "modal",
  "iframe",
  "iframe-child",
  "stale-ref",
  "resume-sections",
];

function parseJson(step) {
  try {
    return JSON.parse(step.stdout);
  } catch (error) {
    throw new Error(`bsk returned non-JSON output: ${error.message}`);
  }
}

function metrics(result) {
  const text = typeof result?.text === "string" ? result.text : "";
  return {
    refCount: result?.ref_count ?? null,
    fieldCount: Array.isArray(result?.fields) ? result.fields.length : null,
    fieldAmbiguityCount: Array.isArray(result?.fields)
      ? result.fields.filter((field) => field.ambiguous === true).length
      : null,
    textBytes: Buffer.byteLength(text),
    nodeProxyCount: (text.match(/^\s*(?:@e\d+\s+)?[A-Za-z][\w-]*(?:\s|$)/gm) ?? []).length,
    canonicalScopes: [result?.canonical_scope?.document_id, result?.canonical_scope?.origin].filter(Boolean),
  };
}

async function runCommand(command, args, timeoutMs) {
  const step = await runProcess(command, [...args, "--json"], { timeoutMs });
  if (step.exitCode !== 0 || step.timedOut || step.error) {
    const detail = step.stderr.trim() || step.stdout.trim() || step.error || `exit ${step.exitCode}`;
    throw new Error(`bsk ${args.join(" ")} failed: ${detail}`);
  }
  return { raw: step, result: parseJson(step) };
}

async function captureScenario({ bskCommand, baseUrl, session, scenario, runId, timeoutMs }) {
  const url = `${baseUrl}/perception/${scenario}?run=${encodeURIComponent(runId)}`;
  const steps = [];
  const execute = async (args, label) => {
    const step = await runCommand(bskCommand, [...args, "--session", session], timeoutMs);
    steps.push({ label, command: step.raw.args, result: step.result, metrics: metrics(step.result) });
    return step.result;
  };

  await execute(["navigate", url], "navigate");
  const snapshot = await execute(["snapshot"], "snapshot");
  await execute(["observe"], "observe");

  if (scenario === "stale-ref") {
    const ref = snapshot.text?.match(/(@e\d+)[^\n]*Save draft/)?.[1];
    if (!ref) throw new Error("could not find Save draft ref in stale-ref snapshot");
    await execute(["click", "--ref", ref], "click-old-ref");
    await execute(["snapshot"], "snapshot-after-rerender");
    await execute(["observe"], "observe-after-rerender");
  }

  return { url, steps };
}

export async function capturePerceptionBaselines({ bskCommand = "bsk", timeoutMs = 90_000 } = {}) {
  const server = createEvalServer();
  const { baseUrl } = await server.start();
  const runId = `perception-${randomUUID().slice(0, 8)}`;
  let session;
  try {
    const started = await runCommand(bskCommand, ["session", "start", "--no-focus"], timeoutMs);
    session = started.result.session_id;
    if (!session) throw new Error("bsk session start did not return session_id");
    const scenarios = {};
    for (const scenario of SCENARIOS) {
      scenarios[scenario] = await captureScenario({
        bskCommand,
        baseUrl,
        session,
        scenario,
        runId: `${runId}-${scenario}`,
        timeoutMs,
      });
    }
    return { status: "captured", bskCommand, scenarios };
  } finally {
    if (session) await runCommand(bskCommand, ["session", "stop", session], timeoutMs);
    await server.stop();
  }
}

export const perceptionScenarios = SCENARIOS;
