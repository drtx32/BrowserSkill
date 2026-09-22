import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, ShadowEvidenceAdapter } from "./evidence-adapter";

describe("ShadowEvidenceAdapter", () => {
  it("redacts secrets and keeps existing event identity fields", () => {
    const adapter = new ShadowEvidenceAdapter({ id: () => "event-1" });
    const event = adapter.capture({
      page_instance_id: "page-1",
      kind: "observation",
      source: "vom",
      payload: { url: "https://example.test/private?q=secret", password: "pw", ref: "@e1" },
    });
    expect(event.event_id).toBe("event-1");
    expect(event.payload).toEqual({ url: "https://example.test", password: "[redacted]", ref: "@e1" });
    expect(event.revision).toBe(1);
  });

  it("marks oversized evidence for a full refresh instead of retaining page content", () => {
    const adapter = new ShadowEvidenceAdapter({ id: () => "event-1" });
    const event = adapter.capture({
      page_instance_id: "page-1",
      kind: "mutation",
      source: "dom",
      payload: { text: "x".repeat(MAX_EVENT_BYTES) },
    });
    expect(event.completeness).toBe("full_refresh_required");
    expect(event.payload).toEqual({ redacted: true, reason: "payload_limit" });
    expect(adapter.events("page-1")).toHaveLength(1);
  });

  it("coalesces dirty regions and reports semantic additions, changes, and removals", () => {
    const adapter = new ShadowEvidenceAdapter({ id: () => "event-1" });
    expect(adapter.applySnapshot("page-1", [
      { id: "a", region_id: "list", label: "one" },
      { id: "b", region_id: "list", label: "two" },
    ]).added).toHaveLength(2);
    adapter.markDirty("page-1", "list", "text");
    adapter.markDirty("page-1", "list", "attributes");
    const delta = adapter.applySnapshot("page-1", [
      { id: "a", region_id: "list", label: "updated" },
      { id: "c", region_id: "list", label: "three" },
    ]);
    expect(delta.dirty_regions).toEqual(["list"]);
    expect(delta.changed.map((entry) => entry.after.id)).toEqual(["a"]);
    expect(delta.added.map((entry) => entry.id)).toEqual(["c"]);
    expect(delta.removed).toEqual(["b"]);
    expect(delta.completeness).toBe("complete");
  });

  it("falls back instead of claiming completeness for conflicting refs or overflow", () => {
    const adapter = new ShadowEvidenceAdapter({ maxDirtyRegions: 1 });
    adapter.markDirty("page-1", "r1");
    adapter.markDirty("page-1", "r2");
    const overflow = adapter.applySnapshot("page-1", [{ id: "a", stable_ref: "@e1" }]);
    expect(overflow.completeness).toBe("full_refresh_required");
    expect(overflow.fallback_reason).toBe("mutation_queue_overflow");

    const conflict = adapter.applySnapshot("page-2", [
      { id: "a", stable_ref: "@e1" },
      { id: "b", stable_ref: "@e1" },
    ]);
    expect(conflict.completeness).toBe("full_refresh_required");
    expect(conflict.fallback_reason).toBe("conflicting_stable_ref");
    expect(conflict.added).toEqual([]);
  });

  it("rejects duplicate canonical target ids while keeping stable refs as projections", () => {
    const adapter = new ShadowEvidenceAdapter();
    const delta = adapter.applySnapshot("page-1", [
      { id: "a", target_id: "page:save", stable_ref: "@e1" },
      { id: "b", target_id: "page:save", stable_ref: "@e2" },
    ]);
    expect(delta.fallback_reason).toBe("conflicting_target_id");
    expect(delta.completeness).toBe("full_refresh_required");
  });

  it("marks mutation events without a region as ambiguous", () => {
    const adapter = new ShadowEvidenceAdapter();
    adapter.capture({ page_instance_id: "page-1", kind: "mutation", source: "dom", payload: { text: "changed" } });
    const delta = adapter.applySnapshot("page-1", [{ id: "a" }]);
    expect(delta.completeness).toBe("full_refresh_required");
    expect(delta.fallback_reason).toBe("ambiguous_region_identity");
  });
});
