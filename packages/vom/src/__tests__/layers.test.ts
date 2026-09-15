import { describe, expect, it } from "vitest";
import { coverage, deriveInteractionLayers, detectBlockingLayer } from "../layers";
import type { Viewport, VomNode } from "../types";

const VP: Viewport = { width: 1000, height: 800 };

function node(p: Partial<VomNode> & { id: number }): VomNode {
  const { id, parentId, tag, rect, paintOrder, position, pointerEvents, ...rest } = p;

  return {
    id,
    parentId: parentId ?? null,
    tag: tag ?? "div",
    rect: rect ?? null,
    paintOrder: paintOrder ?? 0,
    position: position ?? "static",
    pointerEvents: pointerEvents ?? "auto",
    ...rest,
  };
}

describe("coverage", () => {
  it("returns the clamped viewport-overlap fraction", () => {
    expect(coverage({ x: 0, y: 0, w: 1000, h: 800 }, VP)).toBeCloseTo(1);
    expect(coverage({ x: 0, y: 0, w: 500, h: 800 }, VP)).toBeCloseTo(0.5);
    expect(coverage({ x: -100, y: 0, w: 200, h: 800 }, VP)).toBeCloseTo(0.1);
  });

  it("returns 0 for null rect, invalid viewport, or off-viewport rect", () => {
    expect(coverage(null, VP)).toBe(0);
    expect(coverage({ x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 800 })).toBe(0);
    expect(coverage({ x: 2000, y: 0, w: 100, h: 100 }, VP)).toBe(0);
  });
});

describe("detectBlockingLayer", () => {
  it("detects a CSS blocker and includes the whole top paint-order band", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 4000 }, paintOrder: 0 }),
        node({
          id: 2,
          parentId: 1,
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 30,
          position: "fixed",
        }),
        node({
          id: 3,
          parentId: 1,
          role: "dialog",
          name: "提示",
          tag: "dialog",
          rect: { x: 300, y: 250, w: 400, h: 300 },
          paintOrder: 40,
          position: "fixed",
        }),
        node({
          id: 4,
          parentId: 3,
          role: "button",
          name: "关闭",
          tag: "button",
          rect: { x: 640, y: 260, w: 40, h: 40 },
          paintOrder: 41,
        }),
      ],
      VP,
    );

    expect(layer).not.toBeNull();
    expect(layer?.rootId).toBe(2);
    expect(layer?.kind).toBe("modal");
    expect(layer?.coverage).toBeCloseTo(1);
    expect([...(layer?.members ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("classifies a near-full blocker without modal signals or controls as a mask", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 10,
          position: "fixed",
        }),
      ],
      VP,
    );

    expect(layer?.kind).toBe("mask");
  });

  it("treats explicit modal nodes as modal even below the generic coverage threshold", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          tag: "dialog",
          role: "dialog",
          modal: true,
          rect: { x: 300, y: 200, w: 400, h: 300 },
          paintOrder: 90,
          position: "fixed",
        }),
      ],
      VP,
    );

    expect(layer?.rootId).toBe(2);
    expect(layer?.kind).toBe("modal");
  });

  it("detects modal features regardless of role or tag casing", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          tag: "DIV",
          role: "Dialog",
          rect: { x: 300, y: 200, w: 400, h: 300 },
          paintOrder: 90,
          position: "fixed",
        }),
      ],
      VP,
    );

    expect(layer?.rootId).toBe(2);
    expect(layer?.kind).toBe("modal");
  });

  it("ignores small toasts and pointer-events:none covers", () => {
    expect(
      detectBlockingLayer(
        [
          node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
          node({
            id: 2,
            parentId: 1,
            rect: { x: 800, y: 720, w: 180, h: 60 },
            paintOrder: 99,
            position: "fixed",
          }),
        ],
        VP,
      ),
    ).toBeNull();

    expect(
      detectBlockingLayer(
        [
          node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
          node({
            id: 2,
            parentId: 1,
            rect: { x: 0, y: 0, w: 1000, h: 800 },
            paintOrder: 40,
            position: "fixed",
            pointerEvents: "none",
          }),
        ],
        VP,
      ),
    ).toBeNull();
  });
});

describe("deriveInteractionLayers", () => {
  it("marks a nested popover active and the modal/page duplicates covered", () => {
    const layers = deriveInteractionLayers([
      node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
      node({
        id: 2,
        parentId: 1,
        role: "button",
        name: "Confirm",
        tag: "button",
        rect: { x: 420, y: 300, w: 160, h: 40 },
        paintOrder: 1,
      }),
      node({
        id: 3,
        parentId: 1,
        role: "dialog",
        modal: true,
        rect: { x: 250, y: 150, w: 500, h: 450 },
        position: "fixed",
        paintOrder: 20,
      }),
      node({
        id: 4,
        parentId: 3,
        role: "button",
        name: "Confirm",
        tag: "button",
        rect: { x: 420, y: 300, w: 160, h: 40 },
        paintOrder: 21,
      }),
      node({
        id: 5,
        parentId: 3,
        role: "menu",
        attrs: { popover: "auto", "popover-open": "true" },
        rect: { x: 400, y: 280, w: 220, h: 120 },
        position: "absolute",
        paintOrder: 30,
      }),
      node({
        id: 6,
        parentId: 5,
        role: "button",
        name: "Confirm",
        tag: "button",
        rect: { x: 420, y: 300, w: 160, h: 40 },
        paintOrder: 31,
      }),
    ]);
    expect(layers.get(1)).toBe("covered");
    expect(layers.get(2)).toBe("covered");
    expect(layers.get(3)).toBe("covered");
    expect(layers.get(4)).toBe("covered");
    expect(layers.get(5)).toBe("active");
    expect(layers.get(6)).toBe("active");
  });

  it("uses hit geometry and pointer events, not z-index alone, for drawers and duplicates", () => {
    const base = node({
      id: 1,
      tag: "button",
      role: "button",
      name: "Save",
      rect: { x: 20, y: 20, w: 100, h: 40 },
      paintOrder: 1,
    });
    const layers = deriveInteractionLayers([
      base,
      node({
        id: 2,
        tag: "aside",
        role: "dialog",
        attrs: { "z-index": "999999" },
        rect: { x: 500, y: 0, w: 500, h: 800 },
        position: "fixed",
        paintOrder: 2,
      }),
      node({
        id: 3,
        tag: "div",
        rect: { x: 0, y: 0, w: 500, h: 800 },
        position: "fixed",
        pointerEvents: "none",
        paintOrder: 99,
      }),
    ]);
    expect(layers.get(1)).toBe("background");
    expect(layers.get(2)).toBe("active");
    expect(layers.get(3)).toBe("background");
  });

  it("returns the page to the active layer after an overlay is dismissed", () => {
    const page = node({
      id: 1,
      tag: "button",
      role: "button",
      name: "Open",
      rect: { x: 20, y: 20, w: 100, h: 40 },
    });
    expect(deriveInteractionLayers([page]).get(1)).toBe("active");
    const overlay = node({
      id: 2,
      role: "dialog",
      modal: true,
      rect: { x: 0, y: 0, w: 1000, h: 800 },
      position: "fixed",
      paintOrder: 10,
    });
    expect(deriveInteractionLayers([page, overlay]).get(1)).toBe("covered");
    expect(deriveInteractionLayers([page]).get(1)).toBe("active");
  });
});
