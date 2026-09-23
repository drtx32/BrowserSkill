import { describe, expect, it, vi } from "vitest";
import { CanonicalPerception, type CanonicalTargetInput } from "./canonical-perception";
import { ShadowEvidenceAdapter } from "./evidence-adapter";
import type { WikiScope } from "./guarded-maintenance";

const scope: WikiScope = {
  browser_id: "b",
  session_id: "s",
  tab_id: 1,
  document_id: "doc",
  origin: "https://example.test",
};
const owner = { ownership_id: "owner" };
const target = (ref: string, name = "Save"): CanonicalTargetInput => ({
  target_id: "page:save",
  stable_ref: ref,
  address: { origin: scope.origin, document: scope.document_id, role: "button", name },
  region_id: "form",
  evidence_event_ids: ["event-1"],
});

describe("CanonicalPerception", () => {
  it("preserves canonical identity while replacing a renumbered live ref", () => {
    const perception = new CanonicalPerception(new ShadowEvidenceAdapter());
    perception.applyFullObservation(scope, owner, [target("@e1")]);
    const receipt = perception.applyFullObservation(scope, owner, [target("@e9")], 1);
    expect(receipt.outcome).toBe("accepted");
    expect(perception.read({ target_id: "page:save" }, scope).target).toMatchObject({
      target_id: "page:save",
      current_binding: { stable_ref: "@e9", live: true },
    });
    expect(perception.read({ alias: "@e9" }, scope).outcome).toBe("unresolved");
  });

  it("uses a bounded targeted delta without rebuilding a full observation", () => {
    const adapter = new ShadowEvidenceAdapter();
    const targetedSnapshot = vi.spyOn(adapter, "applyTargetedSnapshot");
    const perception = new CanonicalPerception(adapter);
    perception.applyFullObservation(scope, owner, [
      target("@e1"),
      { ...target("@e2", "Cancel"), target_id: "page:cancel" },
    ]);
    targetedSnapshot.mockClear();
    perception.markDirty(scope.document_id, "form", "mutation");
    const receipt = perception.applyTargetedRegion(scope, owner, "form", [target("@e3")], 1);
    expect(receipt.outcome).toBe("accepted");
    expect(targetedSnapshot).toHaveBeenCalledTimes(1);
    expect(
      perception.read({ target_id: "page:save" }, scope).target?.current_binding.stable_ref,
    ).toBe("@e3");
  });

  it("drops live binding and action authority on document rollover but retains history", () => {
    const perception = new CanonicalPerception(new ShadowEvidenceAdapter());
    perception.applyFullObservation(scope, owner, [target("@e1")]);
    const nextScope = { ...scope, document_id: "doc-2" };
    perception.rollover(nextScope);
    expect(perception.canMutate("page:save", scope, owner)).toBe(false);
    expect(perception.historyFor("page:save")).toHaveLength(1);
    expect(perception.read({ target_id: "page:save" }, nextScope).outcome).toBe("unresolved");
  });

  it("fails closed for collisions without phantom targets", () => {
    const perception = new CanonicalPerception(new ShadowEvidenceAdapter());
    const result = perception.applyFullObservation(scope, owner, [
      target("@e1"),
      { ...target("@e2"), target_id: "page:other" },
    ]);
    expect(result.outcome).toBe("unresolved");
    expect(perception.read({ target_id: "page:save" }, scope).outcome).toBe("unresolved");
  });

  it("keeps reads passive", () => {
    const adapter = new ShadowEvidenceAdapter();
    const perception = new CanonicalPerception(adapter);
    perception.applyFullObservation(scope, owner, [target("@e1")]);
    const delta = vi.spyOn(adapter, "applySnapshot");
    perception.read({ target_id: "page:save" }, scope);
    expect(delta).not.toHaveBeenCalled();
  });
});
