import { describe, expect, it } from "vitest";
import {
  analyzeVirtualizedLists,
  collectVirtualizedSegments,
  stableItemFingerprint,
} from "../virtualized";
import type { VomNode } from "../types";

function node(id: number, parentId: number | null, extra: Partial<VomNode> = {}): VomNode {
  return { id, parentId, tag: "div", rect: { x: 0, y: 0, w: 100, h: 20 }, paintOrder: 0, position: "static", pointerEvents: "auto", ...extra };
}

describe("virtualized list awareness", () => {
  it("marks an aria-sized viewport slice as partial", () => {
    const result = analyzeVirtualizedLists([
      node(1, null, { role: "list", attrs: { "aria-setsize": "100" } }),
      node(2, 1, { role: "listitem", name: "Item 41", attrs: { "aria-posinset": "41", "data-id": "41" } }),
      node(3, 1, { role: "listitem", name: "Item 42", attrs: { "aria-posinset": "42", "data-id": "42" } }),
    ]);
    expect(result[0]).toMatchObject({ completeness: "partial", visibleCount: 2, totalCount: 100 });
  });

  it("keeps fingerprints stable across recycled windows", () => {
    expect(stableItemFingerprint(node(2, 1, { role: "listitem", attrs: { "data-id": "42" } }))).toBe("data-id:42");
    expect(stableItemFingerprint(node(9, 1, { role: "listitem", attrs: { "data-id": "42" } }))).toBe("data-id:42");
  });

  it("deduplicates overlapping windows and terminates at a bound", async () => {
    const windows = [["a", "b"], ["b", "c"], ["c", "d"]];
    const result = await collectVirtualizedSegments({
      read: async (segment) => ({ items: windows[segment] ?? [], complete: segment === 2 }),
      advance: async () => true,
      fingerprint: (item) => item,
    });
    expect(result).toMatchObject({ items: ["a", "b", "c", "d"], segments: 3, complete: true });
  });

  it("stops when scrolling makes no progress", async () => {
    const result = await collectVirtualizedSegments({
      read: async () => ({ items: ["a"], complete: false }),
      advance: async () => true,
      fingerprint: (item) => item,
      maxStalledSegments: 2,
    });
    expect(result).toMatchObject({ items: ["a"], complete: false, termination: "stalled", segments: 3 });
  });
});
