import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createEvalServer } from "../lib/server.mjs";
import { loadFixtureRegistry } from "../lib/fixture-registry.mjs";

const baselines = JSON.parse(
  await readFile(resolve("evals/browser/fixtures/perception-baselines.json"), "utf8"),
);
const registry = await loadFixtureRegistry();

function evidence(html, baseline) {
  const nodeCount = (html.match(/<[a-z][\w-]*(?:\s|>)/gi) ?? []).length;
  const ambiguity = (html.match(/data-ambiguity="[^"]+"/g) ?? []).length;
  const compact = JSON.stringify({
    fixture: baseline.path,
    marker: baseline.marker,
    ambiguity,
    nodeCount,
  });
  return { htmlBytes: Buffer.byteLength(html), nodeCount, ambiguity, compactBytes: Buffer.byteLength(compact) };
}

test("P0 perception fixtures are registered and preserve current evidence baselines", async () => {
  const server = createEvalServer({ fixtureRegistry: registry });
  const { baseUrl } = await server.start();
  try {
    for (const baseline of Object.values(baselines.scenarios)) {
      const response = await fetch(`${baseUrl}${baseline.path}?run=perception-baseline`);
      assert.equal(response.status, 200, baseline.path);
      const html = await response.text();
      assert.match(html, new RegExp(baseline.marker), baseline.path);
      assert.deepEqual(evidence(html, baseline), {
        htmlBytes: baseline.htmlBytes,
        nodeCount: baseline.nodeCount,
        ambiguity: baseline.ambiguity,
        compactBytes: baseline.compactBytes,
      });
    }
  } finally {
    await server.stop();
  }
});

test("P0 baselines expose the intended ambiguity lanes", () => {
  assert.equal(baselines.scenarios["duplicate-controls"].ambiguity, 2);
  assert.equal(baselines.scenarios["resume-sections"].ambiguity, 2);
  assert.equal(baselines.scenarios["ordinary-form"].ambiguity, 0);
  assert.equal(baselines.scenarios.modal.ambiguity, 0);
  assert.equal(baselines.scenarios.iframe.ambiguity, 0);
  assert.equal(baselines.scenarios["stale-ref"].ambiguity, 0);
});
