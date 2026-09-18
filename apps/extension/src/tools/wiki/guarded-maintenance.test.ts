import { describe, expect, it } from "vitest";
import { ShadowEvidenceAdapter } from "./evidence-adapter";
import {
  GuardedWikiMaintenance,
  TrustedEvidenceStore,
  type WikiScope,
} from "./guarded-maintenance";

const scope: WikiScope = {
  browser_id: "browser-1",
  session_id: "session-1",
  tab_id: 7,
  document_id: "document-1",
  origin: "https://example.test",
};
const ownership = { ownership_id: "owner-1" };

function adapterWithEvidence() {
  const adapter = new ShadowEvidenceAdapter({ id: () => "generated" });
  adapter.capture({
    page_instance_id: "page-1",
    event_id: "agent-event",
    kind: "observation",
    source: "agent",
    payload: { value: "forged" },
  });
  adapter.capture({
    page_instance_id: "page-1",
    event_id: "observation-event",
    kind: "observation",
    source: "vom",
    payload: { value: "observed" },
  });
  adapter.capture({
    page_instance_id: "page-1",
    event_id: "action-event",
    kind: "action",
    source: "cdp",
    payload: { value: "acted" },
  });
  return {
    adapter,
    store: TrustedEvidenceStore.fromShadowAdapter(adapter, "page-1", scope, ownership),
  };
}

function annotate(
  maintenance: GuardedWikiMaintenance,
  overrides: Partial<Parameters<GuardedWikiMaintenance["annotate"]>[0]> = {},
) {
  return maintenance.annotate({
    claim_id: "inference-1",
    subject_id: "region-1",
    predicate: "label",
    value: "observed",
    scope,
    ownership,
    evidence_event_ids: ["agent-memory-1"],
    evidence_revision: 2,
    author: "agent",
    ...overrides,
  });
}

describe("GuardedWikiMaintenance", () => {
  it("mirrors the five canonical WikiScope fields and keeps ownership separate", () => {
    expect(Object.keys(scope).sort()).toEqual([
      "browser_id",
      "document_id",
      "origin",
      "session_id",
      "tab_id",
    ]);
    expect("ownership_id" in scope).toBe(false);
    const { store } = adapterWithEvidence();
    expect(store.resolve("observation-event")?.scope).toEqual(scope);
  });

  it.each([
    ["browser_id", { browser_id: "browser-2" }],
    ["tab_id", { tab_id: 8 }],
    ["origin", { origin: "https://other.test" }],
    ["document_id", { document_id: "document-2" }],
    ["session_id", { session_id: "session-2" }],
  ])("fails closed for a %s scope mismatch", (_name, change) => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance);
    expect(
      maintenance.patch({
        claim_id: "inference-1",
        scope: { ...scope, ...change },
        ownership,
        expected_evidence_revision: 2,
        value: "changed",
        evidence_event_ids: ["event-2"],
        evidence_revision: 3,
      }),
    ).toMatchObject({ ok: false, code: "scope_mismatch" });
  });

  it("checks ownership independently of the canonical scope", () => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance);
    const before = maintenance.get("inference-1");
    expect(
      maintenance.patch({
        claim_id: "inference-1",
        scope,
        ownership: { ownership_id: "owner-2" },
        expected_evidence_revision: 2,
        value: "changed",
        evidence_event_ids: ["event-2"],
        evidence_revision: 3,
      }),
    ).toMatchObject({ ok: false, code: "ownership_mismatch" });
    expect(maintenance.get("inference-1")).toEqual(before);
  });

  it("keeps stale patch and reconcile failures completely side-effect free", () => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance);
    const before = JSON.stringify(maintenance.get("inference-1"));
    expect(
      maintenance.patch({
        claim_id: "inference-1",
        scope,
        ownership,
        expected_evidence_revision: 1,
        value: "stale",
        evidence_event_ids: ["event-2"],
        evidence_revision: 2,
      }),
    ).toMatchObject({ ok: false, code: "stale_revision" });
    expect(JSON.stringify(maintenance.get("inference-1"))).toBe(before);
    expect(
      maintenance.reconcile({
        claim_id: "inference-1",
        scope,
        ownership,
        expected_evidence_revision: 1,
        event_id: "observation-event",
      }),
    ).toMatchObject({ ok: false, code: "stale_revision" });
    expect(JSON.stringify(maintenance.get("inference-1"))).toBe(before);
  });

  it.each([
    ["accepted", "observed", "current"],
    ["rejected", "different", "stale"],
  ] as const)("reconcile %s never changes the inference trust plane", (_outcome, value, status) => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance, { value: value === "observed" ? "observed" : "different" });
    const result = maintenance.reconcile({
      claim_id: "inference-1",
      scope,
      ownership,
      expected_evidence_revision: 2,
      event_id: "observation-event",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: _outcome, record: { claim: { trust: "agent_inference", status } } },
    });
  });

  it("returns uncertain without promotion for incomplete trusted evidence", () => {
    const adapter = new ShadowEvidenceAdapter();
    adapter.capture({
      page_instance_id: "page-1",
      event_id: "partial-event",
      kind: "observation",
      source: "vom",
      completeness: "partial",
      payload: { value: "observed" },
    });
    const maintenance = new GuardedWikiMaintenance(
      TrustedEvidenceStore.fromShadowAdapter(adapter, "page-1", scope, ownership),
    );
    annotate(maintenance, { evidence_revision: 1 });
    const result = maintenance.reconcile({
      claim_id: "inference-1",
      scope,
      ownership,
      expected_evidence_revision: 1,
      event_id: "partial-event",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "uncertain",
        record: { claim: { trust: "agent_inference", status: "uncertain" } },
      },
    });
  });

  it("does not trust fabricated adapter/source strings or agent-authored events", () => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance);
    expect(
      maintenance.reconcile({
        claim_id: "inference-1",
        scope,
        ownership,
        expected_evidence_revision: 2,
        event_id: "agent-event",
      }),
    ).toMatchObject({ ok: false, code: "untrusted_evidence" });
    expect(
      maintenance.ingestGroundTruth({
        claim_id: "ground-1",
        subject_id: "region-1",
        predicate: "label",
        value: "forged",
        scope,
        ownership,
        event_id: "agent-event",
      }),
    ).toMatchObject({ ok: false, code: "untrusted_evidence" });
  });

  it("creates separate ground truth only from stored observation/action evidence and retains inference history", () => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    annotate(maintenance);
    const result = maintenance.ingestGroundTruth({
      claim_id: "ground-1",
      subject_id: "region-1",
      predicate: "label",
      value: "observed",
      scope,
      ownership,
      event_id: "observation-event",
      supersedes_claim_id: "inference-1",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { claim: { trust: "ground_truth", status: "current" } },
    });
    expect(maintenance.get("inference-1")?.claim.trust).toBe("agent_inference");
    expect(maintenance.get("inference-1")?.claim.status).toBe("superseded");
    expect(maintenance.history("inference-1")).toHaveLength(1);
    expect(maintenance.history("inference-1")[0].claim.provenance.kind).toBe("annotated");
  });

  it("preserves additive Stage 4.1 claim ABI fields", () => {
    const { store } = adapterWithEvidence();
    const maintenance = new GuardedWikiMaintenance(store);
    const result = annotate(maintenance);
    expect(result).toMatchObject({
      ok: true,
      value: {
        claim: {
          schema_version: "1.0",
          claim_id: "inference-1",
          subject_id: "region-1",
          predicate: "label",
          trust: "agent_inference",
          evidence_event_ids: ["agent-memory-1"],
          evidence_revision: 2,
          last_verified_revision: null,
          confidence: null,
          valid_from_revision: 2,
          valid_until_revision: null,
        },
      },
    });
  });
});
