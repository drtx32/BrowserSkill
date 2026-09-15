import { describe, expect, it } from "vitest";
import {
  discoverLocators,
  findLocators,
  matchesLocator,
  parseLocator,
  rematchLocator,
} from "../locator";

const nodes = [
  {
    id: 1,
    role: "link",
    name: "My Resume",
    href: "/resume",
    region: "header",
    rect: { x: 900, y: 20, w: 120, h: 32 },
  },
  {
    id: 2,
    role: "link",
    name: "Profile",
    href: "/profile",
    region: "header",
    rect: { x: 700, y: 20, w: 90, h: 32 },
  },
  {
    id: 3,
    role: "button",
    name: "Submit application",
    states: ["disabled"],
    rect: { x: 400, y: 500, w: 180, h: 44 },
  },
];

describe("locator DSL", () => {
  it("parses field-scoped regex and AND predicates", () => {
    expect(parseLocator("role=link href~/resume|profile/i region=header")).toEqual({
      predicates: [
        { field: "role", operator: "=", value: "link" },
        { field: "href", operator: "regex", value: "resume|profile", flags: "i" },
        { field: "region", operator: "=", value: "header" },
      ],
    });
    expect(
      findLocators(nodes, "role=link href~/resume|profile/i region=header").map((m) => m.node.id),
    ).toEqual([1, 2]);
  });

  it("supports text operators, negative matching, and normalized geometry", () => {
    expect(
      matchesLocator(nodes[0], "name~=resume xnorm>0.7 ynorm<0.15", { width: 1000, height: 1000 }),
    ).toBe(true);
    expect(matchesLocator(nodes[0], "name!~/settings/i")).toBe(true);
    expect(matchesLocator(nodes[2], "role=button state~=disabled w>=180")).toBe(true);
  });

  it("rejects malformed or unbounded regex input", () => {
    expect(() => parseLocator("name~/[a-/")).toThrow();
    expect(() => parseLocator(`name~/${"a".repeat(513)}/`)).toThrow();
  });

  it("keeps natural-language discover deterministic and bounded", () => {
    const result = discoverLocators(nodes, "my resume", 1);
    expect(result).toHaveLength(1);
    expect(result[0].node.id).toBe(1);
    expect(result[0].confidence).toBe(1);
  });

  it("only auto-recovers a stale ref when the fingerprint is unique", () => {
    expect(rematchLocator(nodes, "role=link name=My").status).toBe("not_found");
    expect(rematchLocator(nodes, "role=link href=/resume")).toMatchObject({
      status: "matched",
      match: { node: { id: 1 } },
    });
    expect(rematchLocator(nodes, "role=link region=header").status).toBe("ambiguous");
  });
});
