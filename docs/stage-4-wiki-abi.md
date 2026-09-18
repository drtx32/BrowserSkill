# Stage 4 Browser Wiki ABI 1.0

This is the implementation-facing freeze of the Stage 4 architecture proposal.
It is additive to Stage 1–3 and is not a runtime rollout. The Rust types in
`crates/bsk-protocol/src/wiki.rs` and the fixture schemas are the wire
authority; examples in the architecture proposal are explanatory only.

## Contract invariants

- Every record has `schema_version: "1.0"` where the record is persisted.
- `WikiScope` is `{browser_id, session_id, tab_id, document_id, origin}`. A
  read or write must match all five dimensions; origin is an origin, not a
  full URL.
- `PageInstance` identity is document identity plus `navigation_epoch`, never
  a URL. A new document, origin, uncertain tab reuse, session stop, browser
  disconnect, ownership release, or store corruption invalidates it.
- Revisions are unsigned, per-PageInstance, monotonic, and contiguous only
  for accepted events. `to_revision < from_revision` is invalid. A gap or
  failed durable write returns `full_refresh_required`.
- `WikiRef.ref_id` is the existing session-scoped stable/interaction ref. Wiki
  records can index it, but no Wiki record can authorize an action. Actions
  still pass through the Stage 1–3 interaction resolver and ownership checks.
- `Claim.trust` is a permanent plane: `ground_truth`, `derived`, or
  `agent_inference`. Agent annotations cannot be promoted by serialization or
  reconciliation alone.
- Evidence IDs are append-only references. Invalidation changes status and
  keeps the record/evidence link; it does not silently delete stale knowledge.
- Cross-scope relations require explicit provenance and are never action
  authorization inputs. Popup `opens` relations reuse opener lineage.

## Capability and version negotiation

`WikiCapabilities` is negotiated independently of the existing protocol
handshake and is optional. A peer advertises `schema_version`,
`min_compatible_schema`, and named capabilities with versions, for example:

```json
{"schema_version":"1.0","min_compatible_schema":"1.0",
 "capabilities":[{"name":"wiki.read","version":"1.0"},
                  {"name":"wiki.delta","version":"1.0"}]}
```

An absent capability means `unsupported`; an unknown newer schema is
`unsupported`, never guessed. Same-major compatible minor versions may be
read-only negotiated by the daemon, but writes require a capability match.
Old clients keep the existing observe path. No Wiki method bypasses leases,
session ownership, popup lineage, sandbox policy, or the interaction resolver.

## Retention and redaction defaults

The first implementation must be local-only and bounded:

- retain active PageInstances, current claims, live refs, and their evidence
  for the owning session;
- retain ended-session records for 30 days, then prune; make the limit
  configurable but never silently unlimited;
- cap event payloads at 64 KiB and per-PageInstance event history at 10,000
  events; overflow marks the page `full_refresh_required`;
- redact input values, credentials, cookies, page screenshots, file contents,
  and script bodies by default. URLs retain origin and may retain path only
  when local policy permits;
- embeddings, if later enabled, are local and region/chunk scoped; no page
  content leaves the local boundary without explicit privacy approval.

These are storage defaults, not a promise that existing audit settings retain
page content. Existing privacy and audit policy remains stricter when it is.

## Migration compatibility

1. Unknown Wiki records are unavailable, not converted into ground truth.
2. A migrated record must preserve its original evidence IDs, scope, trust
   plane, and status; missing fields fail closed.
3. Stage 3 refs are imported as `WikiRef` records only after a fresh
   observation confirms document identity. Session restart never restores
   action authorization.
4. A failed migration leaves the old store readable and emits an explicit
   `degraded`/`full_refresh_required` result; it does not partially commit a
   revision.

The conformance fixtures under `crates/bsk-protocol/fixtures/wiki/` pin the
normal page, inference, capability, and overflow/fallback cases. The single
contract schema under `crates/bsk-protocol/schema/wiki_contract.json` is the
review-readable boundary; generated per-record schemas are emitted by the
existing `dump-schema` binary once the protocol crate is available in the
build environment.
