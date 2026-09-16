import { describe, expect, it } from "vitest";
import { RefStore } from "../ref-store";

describe("RefStore", () => {
  it("stores and resolves ref → backendNodeId", () => {
    const s = new RefStore();
    s.set("e1", 42, { tabId: 7 });
    expect(s.resolve("@e1")).toBe(42);
    expect(s.resolve("e1")).toBe(42);
    expect(s.resolve("@e1", { tabId: 7 })).toBe(42);
    expect(s.resolve("@e1", { tabId: 8 })).toBeNull();
    expect(s.resolveEntry("@e1")).toMatchObject({
      backendNodeId: 42,
      tabId: 7,
      generation: 0,
    });
    expect(s.size()).toBe(1);
    expect(s.isEmpty()).toBe(false);
  });

  it("replace() clears prior entries", () => {
    const s = new RefStore();
    s.set("@e1", 1);
    s.set("@e2", 2);
    s.replace([
      ["e10", { backendNodeId: 10, tabId: 1, name: "Save" }],
      ["@e11", { backendNodeId: 11, tabId: 1 }],
    ]);
    expect(s.resolve("@e1")).toBeNull();
    expect(s.resolve("@e10")).toBe(10);
    expect(s.resolveEntry("e10")).toMatchObject({ kind: "dom", name: "Save" });
    expect(s.resolve("@e10", { tabId: 1 })).toBe(10);
    expect(s.resolve("@e10", { tabId: 2 })).toBeNull();
    expect(s.resolve("@e11")).toBe(11);
    expect(s.size()).toBe(2);
  });

  it("preserves the child CDP session as part of ref identity", () => {
    const s = new RefStore();
    s.set("e1", 42, {
      tabId: 7,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
    expect(s.resolveEntry("e1")).toMatchObject({
      backendNodeId: 42,
      tabId: 7,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
  });

  it("reuses a logical ref when a DOM node is replaced", () => {
    const s = new RefStore();
    const identity = {
      role: "button",
      name: "Save",
      path: "main/form/Save",
      layer: "active" as const,
    };
    const first = s.replaceStable([["e1", { backendNodeId: 10, tabId: 7, identity }]]);
    const second = s.replaceStable([["e1", { backendNodeId: 99, tabId: 7, identity }]]);
    expect(first.get("e1")).toBe("e1");
    expect(second.get("e1")).toBe("e1");
    expect(s.resolve("@e1", { tabId: 7 })).toBe(99);
  });

  it("does not rebind across tabs or blocked layers", () => {
    const s = new RefStore();
    const identity = { role: "button", name: "Save", path: "form/Save", layer: "active" as const };
    s.replaceStable([["e1", { backendNodeId: 10, tabId: 7, identity }]]);
    const otherTab = s.replaceStable([["e1", { backendNodeId: 20, tabId: 8, identity }]]);
    expect(otherTab.get("e1")).toBe("e1");
    const blocked = s.replaceStable([
      ["e1", { backendNodeId: 30, tabId: 8, identity: { ...identity, layer: "covered" } }],
    ]);
    expect(blocked.get("e1")).toBe("e1");
  });

  it("uses the layer guard itself for same-tab covered refs", () => {
    const s = new RefStore();
    const active = { role: "button", name: "Save", path: "form/Save", layer: "active" as const };
    s.replaceStable([["e9", { backendNodeId: 10, tabId: 7, identity: active }]]);
    const blocked = s.replaceStable([
      ["e1", { backendNodeId: 11, tabId: 7, identity: { ...active, layer: "covered" } }],
    ]);
    expect(blocked.get("e1")).toBe("e1");
    expect(s.resolve("e1", { tabId: 7 })).toBe(11);
  });

  it("allows a same-session soft frame refresh only with a stable id", () => {
    const s = new RefStore();
    const first = {
      role: "button",
      name: "Save",
      path: "form/Save",
      frameId: "frame-a",
      stableId: "id=save",
      layer: "active" as const,
    };
    s.replaceStable([
      [
        "e1",
        { backendNodeId: 10, tabId: 7, frameId: "frame-a", cdpSessionId: "cdp", identity: first },
      ],
    ]);
    const stable = s.replaceStable([
      [
        "e1",
        {
          backendNodeId: 11,
          tabId: 7,
          frameId: "frame-b",
          cdpSessionId: "cdp",
          identity: { ...first, frameId: "frame-b" },
        },
      ],
    ]);
    expect(stable.get("e1")).toBe("e1");
    const unsafe = s.replaceStable([
      [
        "e9",
        {
          backendNodeId: 12,
          tabId: 7,
          frameId: "frame-c",
          cdpSessionId: "cdp",
          identity: { ...first, frameId: "frame-c", stableId: undefined },
        },
      ],
    ]);
    expect(unsafe.get("e9")).toBe("e9");
  });

  it("keeps duplicate semantic controls from sharing a registry identity", () => {
    const s = new RefStore();
    const identity = {
      role: "button",
      name: "Delete",
      path: "toolbar/Delete",
      layer: "active" as const,
    };
    s.replaceStable([
      ["e1", { backendNodeId: 1, tabId: 7, identity }],
      ["e2", { backendNodeId: 2, tabId: 7, identity }],
    ]);
    const next = s.replaceStable([
      ["e1", { backendNodeId: 3, tabId: 7, identity }],
      ["e2", { backendNodeId: 4, tabId: 7, identity }],
    ]);
    expect(next.get("e1")).toBe("e1");
    expect(next.get("e2")).toBe("e2");
  });

  it("bounds retained logical identities", () => {
    const s = new RefStore({ maxLogicalEntries: 32 });
    for (let i = 0; i < 80; i++)
      s.replaceStable([
        [
          `e${i + 1}`,
          {
            backendNodeId: i + 1,
            tabId: 7,
            identity: { role: "button", name: `B${i}`, layer: "active" },
          },
        ],
      ]);
    expect(s.logicalSizeForTest()).toBeLessThanOrEqual(32);
  });
});

describe("document invalidation", () => {
  it("rejects old refs without disturbing another tab's refs", () => {
    const refs = new RefStore();
    refs.set("e1", 10, { tabId: 7 });
    refs.set("e2", 10, { tabId: 8 });
    refs.invalidateTab(7);
    expect(refs.resolve("e1")).toBeNull();
    expect(refs.resolve("e2")).toBe(10);
    expect(refs.documentRevision(7)).toBe(1);
    expect(refs.documentRevision(8)).toBe(0);
    refs.set("e3", 10, { tabId: 7 });
    expect(refs.resolve("e1")).toBeNull();
    expect(refs.resolve("e3")).toBe(10);
  });

  it("records navigation during an in-flight first observation", () => {
    const refs = new RefStore();
    const revision = refs.documentRevision(7);
    refs.invalidateTab(7);
    expect(refs.documentRevision(7)).not.toBe(revision);
    expect(refs.isEmpty()).toBe(true);
  });
});
