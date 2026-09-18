# Stage 4.8 Wiki health and evaluation receipt

The health calculator is read-only and consumes one immutable evidence snapshot
plus `FrozenEligibility`. Eligibility is an input, not a query over record
status, so retiring or invalidating a claim cannot remove it from a denominator.

The formulas are:

```text
orphan rate = orphaned eligible regions / frozen eligible regions
link coverage = relation types with current endpoints and evidence /
                frozen expected relation types
stale rate = stale|superseded|uncertain eligible claims / frozen eligible claims
delta completeness = complete eligible deltas / frozen eligible deltas
full-refresh rate = full_refresh_required eligible deltas / frozen eligible deltas
frontier resumability = resumable eligible frontiers / frozen eligible frontiers
duplicate rate = frontiers containing duplicate item IDs / frozen eligible frontiers
```

Every metric receipt contains numerator, denominator, rate, sample IDs, and the
evidence revision. Zero denominators produce `0.0`, never `NaN`. Metrics are
diagnostic only: this module does not edit facts or authorize actions.

Run the representative fixture receipt with:

```sh
node evals/wiki-health/run.mjs
cargo test -p bsk-protocol wiki_health
```
