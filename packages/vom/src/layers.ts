import type { BlockingLayer, InteractionLayer, Rect, Viewport, VomNode } from "./types";

/** CSS pixels of layout rounding allowed at each viewport edge. */
const VIEWPORT_EDGE_TOLERANCE = 1;

const POSITIONED = new Set(["fixed", "absolute", "sticky"]);
const FORM_TAGS = new Set(["input", "textarea", "select"]);
const FLOATING_ROLES = new Set(["menu", "menubar", "listbox", "tooltip", "tree"]);

function normalizedRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
}

function normalizedTag(node: VomNode): string {
  return node.tag.toLowerCase();
}

function visible(node: VomNode): boolean {
  return node.pointerEvents !== "none" && node.rect !== null && node.rect.w > 0 && node.rect.h > 0;
}

function isFloatingSurface(node: VomNode): boolean {
  const attrs = node.attrs ?? {};
  const semantic =
    node.modal === true ||
    attrs["aria-modal"] === "true" ||
    attrs.popover !== undefined ||
    attrs["popover-open"] === "true" ||
    attrs["data-top-layer"] === "true" ||
    normalizedRole(node) === "dialog" ||
    normalizedRole(node) === "alertdialog" ||
    (POSITIONED.has(node.position) && FLOATING_ROLES.has(normalizedRole(node)));
  return (
    visible(node) &&
    (semantic ||
      (POSITIONED.has(node.position) &&
        (normalizedRole(node) === "menu" || normalizedRole(node) === "listbox")))
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  );
}

function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function effectiveOrder(node: VomNode): number {
  // Paint order is primary. z-index is only a bounded tie-breaker because it is
  // local to stacking contexts and cannot establish global hit order.
  const z = Number.parseInt(node.attrs?.["z-index"] ?? "", 10);
  return (
    node.paintOrder * 1_000_000 +
    (Number.isFinite(z) ? Math.max(-999_999, Math.min(999_999, z)) : 0)
  );
}

/** Derive actionable surface state from semantic/top-layer signals, paint order,
 * visibility and geometry without exposing raw CSS z-index. */
export function deriveInteractionLayers(
  nodes: readonly VomNode[],
  rootFrameId?: string,
): Map<number, InteractionLayer> {
  const result = new Map<number, InteractionLayer>();
  const surfaces = nodes.filter(
    (node) =>
      (rootFrameId === undefined || node.frameId === rootFrameId) && isFloatingSurface(node),
  );
  if (surfaces.length === 0) {
    for (const node of nodes) result.set(node.id, visible(node) ? "active" : "background");
    return result;
  }
  const top = surfaces.slice().sort((a, b) => effectiveOrder(b) - effectiveOrder(a))[0];
  const topOrder = top ? effectiveOrder(top) : -Infinity;
  for (const node of nodes) {
    if (!visible(node)) {
      result.set(node.id, "background");
      continue;
    }
    const insideTop =
      top &&
      (node.id === top.id || node.domAncestorIds?.includes(top.id) || node.parentId === top.id);
    if (insideTop && effectiveOrder(node) >= topOrder) {
      result.set(node.id, "active");
      continue;
    }
    const rect = node.rect;
    if (!rect) {
      result.set(node.id, "background");
      continue;
    }
    const centerX = rect.x + rect.w / 2,
      centerY = rect.y + rect.h / 2;
    const covered = surfaces.some(
      (surface) =>
        effectiveOrder(surface) > effectiveOrder(node) &&
        surface.rect &&
        overlaps(surface.rect, rect) &&
        containsPoint(surface.rect, centerX, centerY),
    );
    result.set(node.id, covered ? "covered" : "background");
  }
  return result;
}

export function coverage(rect: Rect | null, vp: Viewport): number {
  if (!rect || vp.width <= 0 || vp.height <= 0) return 0;
  const ix = Math.max(0, Math.min(rect.x + rect.w, vp.width) - Math.max(rect.x, 0));
  const iy = Math.max(0, Math.min(rect.y + rect.h, vp.height) - Math.max(rect.y, 0));
  const overlap = ix * iy;
  if (overlap <= 0) return 0;
  return Math.min(1, overlap / (vp.width * vp.height));
}

export function spansViewport(rect: Rect | null, vp: Viewport): boolean {
  if (!rect || vp.width <= 0 || vp.height <= 0) return false;
  const t = VIEWPORT_EDGE_TOLERANCE;
  return (
    rect.x <= t &&
    rect.y <= t &&
    rect.x + rect.w >= vp.width - t &&
    rect.y + rect.h >= vp.height - t
  );
}

function isBlockingCandidate(node: VomNode): boolean {
  if (node.pointerEvents === "none") return false;
  return POSITIONED.has(node.position);
}

/** Naming only: dialog roles/tags do not determine whether a layer blocks. */
function looksLikeDialog(node: VomNode): boolean {
  const role = normalizedRole(node);
  const tag = normalizedTag(node);
  return node.modal === true || tag === "dialog" || role === "dialog" || role === "alertdialog";
}

function classifyLayer(nodes: VomNode[], members: Set<number>): BlockingLayer["kind"] {
  for (const node of nodes) {
    if (!members.has(node.id)) continue;
    if (looksLikeDialog(node)) return "modal";
    const tag = normalizedTag(node);
    if (FORM_TAGS.has(tag) || tag === "iframe") return "modal";
  }
  return "mask";
}

export function detectBlockingLayer(
  nodes: VomNode[],
  vp: Viewport,
  rootFrameId?: string,
): BlockingLayer | null {
  let blocker: { node: VomNode; coverage: number } | null = null;

  for (const node of nodes) {
    // A document's paint order is local to its iframe stacking context. Only
    // the root document can establish a page-level blocking layer; child
    // documents are constrained by their iframe owner in the parent document.
    if (rootFrameId !== undefined && node.frameId !== rootFrameId) continue;
    if (!isBlockingCandidate(node)) continue;
    const cov = coverage(node.rect, vp);
    // A large sidebar can leave usable page content beside it. Only actual
    // modality or a cover spanning the whole viewport can fold the base page.
    const qualifies = spansViewport(node.rect, vp) || (node.modal === true && cov > 0);
    if (!qualifies) continue;
    if (
      blocker === null ||
      cov > blocker.coverage ||
      (cov === blocker.coverage && node.paintOrder > blocker.node.paintOrder)
    ) {
      blocker = { node, coverage: cov };
    }
  }

  if (!blocker) return null;

  const threshold = blocker.node.paintOrder;
  const members = new Set<number>();
  for (const node of nodes) {
    if (node.frameId === blocker.node.frameId && node.paintOrder >= threshold) {
      members.add(node.id);
    }
  }

  return {
    rootId: blocker.node.id,
    kind: classifyLayer(nodes, members),
    coverage: blocker.coverage,
    members,
  };
}
