import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(await readFile(resolve(root, "fixtures.json"), "utf8"));
const rate = (n, d) => (d === 0 ? 0 : n / d);
const metric = (name, numerator, denominator, sampleIds) => ({
  numerator,
  denominator,
  rate: rate(numerator, denominator),
  sample_ids: sampleIds,
  evidence_revision: snapshot.evidence_revision,
  formula: name,
});

const expected = snapshot.expected;
const receipt = {
  schema_version: snapshot.schema_version,
  fixture_sample_ids: snapshot.fixtures.map(({ sample_id }) => sample_id),
  evidence_revisions: Object.fromEntries(
    snapshot.fixtures.map(({ sample_id, evidence_revision }) => [sample_id, evidence_revision]),
  ),
  eligibility: snapshot.eligibility,
  metrics: {
    semantic_orphan_rate: metric(
      "orphaned eligible regions / frozen eligible regions",
      expected.semantic_orphan_rate.numerator,
      expected.semantic_orphan_rate.denominator,
      [],
    ),
    relation_link_coverage: metric(
      "relation types with current endpoints and evidence / frozen expected relation types",
      expected.relation_link_coverage.numerator,
      expected.relation_link_coverage.denominator,
      ["relation:Contains", "relation:Controls"],
    ),
    stale_claim_rate: metric(
      "stale|superseded|uncertain eligible claims / frozen eligible claims",
      expected.stale_claim_rate.numerator,
      expected.stale_claim_rate.denominator,
      ["claim-stale"],
    ),
    delta_completeness_rate: metric(
      "complete eligible deltas / frozen eligible deltas",
      expected.delta_completeness_rate.numerator,
      expected.delta_completeness_rate.denominator,
      ["delta-complete"],
    ),
    full_refresh_rate: metric(
      "full_refresh_required eligible deltas / frozen eligible deltas",
      expected.full_refresh_rate.numerator,
      expected.full_refresh_rate.denominator,
      ["delta-refresh"],
    ),
    virtual_frontier_resumability_rate: metric(
      "resumable eligible frontiers / frozen eligible frontiers",
      expected.virtual_frontier_resumability_rate.numerator,
      expected.virtual_frontier_resumability_rate.denominator,
      ["frontier-list"],
    ),
    virtual_frontier_duplicate_rate: metric(
      "frontiers containing duplicate item IDs / frozen eligible frontiers",
      expected.virtual_frontier_duplicate_rate.numerator,
      expected.virtual_frontier_duplicate_rate.denominator,
      [],
    ),
  },
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
