import { describe, expect, it } from "vitest";
import {
  calibrateFuzzyPolicy,
  canonicalSemanticAddress,
  DEFAULT_FUZZY_POLICY,
  FUZZY_CALIBRATION_FIXTURES,
  resolveSemanticTarget,
  type SemanticTarget,
} from "./semantic-address";

const targets: SemanticTarget[] = [
  {
    target_id: "page:save",
    address: {
      origin: "https://example.test",
      document: "settings",
      parentRegion: "profile",
      role: "button",
      name: "Save",
      namespace: "profile",
    },
    aliases: ["save changes"],
    stableAttributes: { id: "save" },
  },
  {
    target_id: "page:cancel",
    address: {
      origin: "https://example.test",
      document: "settings",
      parentRegion: "profile",
      role: "button",
      name: "Cancel",
      namespace: "profile",
    },
    aliases: ["discard"],
    stableAttributes: { id: "cancel" },
  },
];

describe("semantic address resolver", () => {
  it("uses canonical target_id before aliases and never uses @eN as identity", () => {
    expect(
      resolveSemanticTarget({ target_id: "page:save", alias: "discard" }, targets).target_id,
    ).toBe("page:save");
    expect(resolveSemanticTarget({ alias: "@e1" }, targets).reason).toBe("missing");
  });

  it("rejects a foreign origin before ranking", () => {
    const result = resolveSemanticTarget(
      { address: { origin: "https://evil.test" }, alias: "Save" },
      targets,
    );
    expect(result).toMatchObject({ target: null, reason: "cross-origin", tier: "unresolved" });
  });

  it.each([
    [
      "mixed documents with the same alias",
      { alias: "save" },
      [
        {
          ...targets[0],
          aliases: ["save"],
          address: { ...targets[0].address, document: "settings" },
        },
        {
          ...targets[0],
          target_id: "page:other-save",
          aliases: ["save"],
          address: { ...targets[0].address, document: "billing" },
        },
      ],
    ],
    [
      "same alias across origins",
      { alias: "save" },
      [
        { ...targets[0], aliases: ["save"] },
        {
          ...targets[0],
          target_id: "other:save",
          aliases: ["save"],
          address: { ...targets[0].address, origin: "https://other.test" },
        },
      ],
    ],
    [
      "partial scope across pages",
      { address: { document: "settings" }, alias: "save" },
      [
        targets[0],
        {
          ...targets[0],
          target_id: "other:save",
          address: { ...targets[0].address, origin: "https://other.test" },
        },
      ],
    ],
  ])("fails closed for %s", (_name, query, candidates) => {
    expect(resolveSemanticTarget(query, candidates).reason).toBe("ambiguous");
    expect(resolveSemanticTarget(query, candidates).target).toBeNull();
  });

  it("fails closed for ambiguous stable attributes and exact-address collisions", () => {
    const sameAddress = [
      targets[0],
      {
        ...targets[0],
        target_id: "page:save-copy",
        aliases: ["other"],
        stableAttributes: { id: "save" },
      },
    ];
    expect(resolveSemanticTarget({ stableAttributes: { id: "save" } }, sameAddress).reason).toBe(
      "ambiguous",
    );
    expect(
      resolveSemanticTarget(
        {
          address: {
            origin: targets[0].address.origin,
            document: targets[0].address.document,
            role: "button",
            name: "Save",
            parentRegion: "profile",
            namespace: "profile",
          },
        },
        sameAddress,
      ).reason,
    ).toBe("ambiguous");
  });

  it("rejects invalid policy values and target-id collisions without full scope", () => {
    for (const policy of [
      { ...DEFAULT_FUZZY_POLICY, threshold: -1 },
      { ...DEFAULT_FUZZY_POLICY, margin: 2 },
      { ...DEFAULT_FUZZY_POLICY, maxCandidates: 0 },
      { ...DEFAULT_FUZZY_POLICY, maxCandidates: 65 },
    ]) {
      expect(resolveSemanticTarget({ alias: "save" }, targets, policy).reason).toBe(
        "invalid-policy",
      );
    }
    const mixedId = [
      targets[0],
      { ...targets[0], address: { ...targets[0].address, origin: "https://other.test" } },
    ];
    expect(resolveSemanticTarget({ target_id: "page:save" }, mixedId).reason).toBe("ambiguous");
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
    expect(
      canonicalSemanticAddress({ origin: " HTTPS://EXAMPLE.TEST ", document: " Settings " }),
    ).toBe('{"origin":"https://example.test","document":"settings"}');
  });

  it("derives the default fuzzy policy from separated local fixtures", () => {
    expect(FUZZY_CALIBRATION_FIXTURES.map((fixture) => fixture.kind)).toEqual([
      "positive",
      "positive",
      "near-miss",
      "near-miss",
      "ambiguous",
    ]);
    expect(DEFAULT_FUZZY_POLICY).toEqual(calibrateFuzzyPolicy());
    expect(DEFAULT_FUZZY_POLICY.maxCandidates).toBeLessThanOrEqual(64);
  });
});
