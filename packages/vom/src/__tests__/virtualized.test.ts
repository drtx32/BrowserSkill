import { describe, expect, it } from "vitest";
import type { VomNode } from "../types";
import {
  analyzeVirtualizedLists,
  collectVirtualizedSegments,
  createListFrontier,
  recordListFrontierWindow,
  restoreListFrontier,
  serializeListFrontier,
  stableItemFingerprint,
} from "../virtualized";

function node(id: number, parentId: number | null, extra: Partial<VomNode> = {}): VomNode {
  return {
    id,
    parentId,
    tag: "div",
    rect: { x: 0, y: 0, w: 100, h: 20 },
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
    ...extra,
  };
}

describe("virtualized list awareness", () => {
  it("marks an aria-sized viewport slice as partial", () => {
    const result = analyzeVirtualizedLists([
      node(1, null, { role: "list", attrs: { "aria-setsize": "100" } }),
      node(2, 1, {
        role: "listitem",
        name: "Item 41",
        attrs: { "aria-posinset": "41", "data-id": "41" },
      }),
      node(3, 1, {
        role: "listitem",
        name: "Item 42",
        attrs: { "aria-posinset": "42", "data-id": "42" },
      }),
    ]);
    expect(result[0]).toMatchObject({ completeness: "partial", visibleCount: 2, totalCount: 100 });
  });

  it("keeps fingerprints stable across recycled windows", () => {
    expect(
      stableItemFingerprint(node(2, 1, { role: "listitem", attrs: { "data-id": "42" } })),
    ).toBe("data-id:42");
    expect(
      stableItemFingerprint(node(9, 1, { role: "listitem", attrs: { "data-id": "42" } })),
    ).toBe("data-id:42");
    expect(stableItemFingerprint(node(2, 1, { role: "listitem", backendNodeId: 7 }))).toContain(
      "unstable-backend:7",
    );
    expect(stableItemFingerprint(node(9, 1, { role: "listitem", backendNodeId: 7 }))).not.toBe(
      stableItemFingerprint(node(2, 1, { role: "listitem", backendNodeId: 7 })),
    );
  });

  it("keeps mixed geometry windows unknown instead of complete", () => {
    const result = analyzeVirtualizedLists([
      node(1, null, { role: "list" }),
      node(2, 1, { role: "listitem", name: "Visible" }),
      node(3, 1, { role: "listitem", name: "Pending", rect: null }),
    ]);
    expect(result[0]).toMatchObject({ completeness: "unknown", reason: "incomplete-geometry" });
  });

  it("deduplicates overlapping windows and terminates at a bound", async () => {
    const windows = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ];
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
    expect(result).toMatchObject({
      items: ["a"],
      complete: false,
      termination: "stalled",
      segments: 3,
    });
  });

  it("distinguishes a legitimate end sentinel from an advance failure", async () => {
    const end = await collectVirtualizedSegments({
      read: async () => ({ items: ["a"], complete: false }),
      advance: async () => "end-of-list" as const,
      fingerprint: (item) => item,
    });
    const failed = await collectVirtualizedSegments({
      read: async () => ({ items: ["a"], complete: false }),
      advance: async () => "failed" as const,
      fingerprint: (item) => item,
    });
    expect(end.termination).toBe("end-of-list");
    expect(end.complete).toBe(true);
    expect(failed.termination).toBe("advance-failed");
  });

  it("persists a per-region frontier across recycled windows", () => {
    const context = { documentIdentity: "doc-1", origin: "https://example.test", sessionId: "s1" };
    const frontier = createListFrontier<{ id: string }>("results", context);
    recordListFrontierWindow(
      frontier,
      { items: [{ id: "a" }, { id: "b" }], nextProbe: 1 },
      (item) => `id:${item.id}`,
    );
    const update = recordListFrontierWindow(
      frontier,
      { items: [{ id: "b" }, { id: "c" }], nextProbe: 2 },
      (item) => `id:${item.id}`,
    );
    expect(update.addedItems.map((item) => item.id)).toEqual(["c"]);
    expect(frontier.fingerprints).toEqual(["id:a", "id:b", "id:c"]);
    expect(frontier.nextProbe).toBe(2);
    expect(frontier.completeness).toBe("partial");
  });

  it("keeps exhaustion unknown until an explicit end is proven", () => {
    const frontier = createListFrontier("results", {
      documentIdentity: "doc",
      origin: "https://example.test",
    });
    recordListFrontierWindow(frontier, { items: [], nextProbe: 4 }, () => "id:x");
    expect(frontier.exhaustion).toBe("unknown");
    expect(frontier.completeness).toBe("unknown");
    recordListFrontierWindow(
      frontier,
      { items: [], nextProbe: 5, exhaustion: "proven" },
      () => "id:x",
    );
    expect(frontier.exhaustion).toBe("proven");
    expect(frontier.completeness).toBe("complete");
  });

  it("fails closed when persisted ownership no longer matches", () => {
    const context = {
      documentIdentity: "doc-1",
      origin: "https://example.test",
      sessionId: "s1",
      ownerIdentity: "owner-1",
    };
    const frontier = createListFrontier("results", context);
    recordListFrontierWindow(
      frontier,
      { items: [{ id: "a" }], nextProbe: 1 },
      (item) => `id:${item.id}`,
    );
    const restored = restoreListFrontier<{ id: string }>(serializeListFrontier(frontier), {
      regionIdentity: "results",
      context: { ...context, documentIdentity: "doc-2" },
    });
    expect(restored.invalidated).toBe(true);
    expect(restored.needsFullRefresh).toBe(true);
    expect(restored.items).toEqual([]);
    expect(restored.actionAuthority).toBe("none");
  });

  it("requires a full refresh for ambiguous recycled identities", () => {
    const frontier = createListFrontier("results", {
      documentIdentity: "doc",
      origin: "https://example.test",
    });
    recordListFrontierWindow(
      frontier,
      { items: [{ id: "a" }], nextProbe: 1 },
      () => "unstable-backend:4",
    );
    expect(frontier.needsFullRefresh).toBe(true);
    expect(frontier.completeness).toBe("unknown");
    expect(frontier.exhaustion).toBe("unknown");
  });
});
