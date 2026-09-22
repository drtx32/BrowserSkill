import { describe, expect, it } from "vitest";
import { canonicalSemanticAddress, resolveSemanticTarget, type SemanticTarget } from "./semantic-address";

const targets: SemanticTarget[] = [
  {
    target_id: "page:save",
    address: { origin: "https://example.test", document: "settings", parentRegion: "profile", role: "button", name: "Save", namespace: "profile" },
    aliases: ["save changes"],
    stableAttributes: { id: "save" },
  },
  {
    target_id: "page:cancel",
    address: { origin: "https://example.test", document: "settings", parentRegion: "profile", role: "button", name: "Cancel", namespace: "profile" },
    aliases: ["discard"],
    stableAttributes: { id: "cancel" },
  },
];

describe("semantic address resolver", () => {
  it("uses canonical target_id before aliases and never uses @eN as identity", () => {
    expect(resolveSemanticTarget({ target_id: "page:save", alias: "discard" }, targets).target_id).toBe("page:save");
    expect(resolveSemanticTarget({ alias: "@e1" }, targets).reason).toBe("missing");
  });

  it("rejects a foreign origin before ranking", () => {
    const result = resolveSemanticTarget({ address: { origin: "https://evil.test" }, alias: "Save" }, targets);
    expect(result).toMatchObject({ target: null, reason: "cross-origin", tier: "unresolved" });
  });

  it("fails closed for ambiguous aliases and low-confidence fuzzy matches", () => {
    const ambiguous = resolveSemanticTarget(
      { alias: "action" },
      targets.map((target) => ({ ...target, aliases: ["action"] })),
    );
    expect(ambiguous.reason).toBe("ambiguous");
    expect(resolveSemanticTarget({ alias: "unrelated" }, targets).target).toBeNull();
  });

  it("serializes normalized page scope deterministically", () => {
    expect(canonicalSemanticAddress({ origin: " HTTPS://EXAMPLE.TEST ", document: " Settings " })).toBe(
      '{"origin":"https://example.test","document":"settings"}',
    );
  });
});
