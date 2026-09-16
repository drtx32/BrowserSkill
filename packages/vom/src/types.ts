/** Viewport-relative layout box, CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type LayerKind = "page" | "modal" | "mask";

/**
 * CDP-free data slice consumed by packages/vom.
 * The extension joins AX semantics and DOMSnapshot geometry by backendNodeId
 * before constructing these nodes.
 */
export interface VomNode {
  /** Internal render-only visual entry; never a DOM action target. */
  visualKey?: number;
  id: number;
  parentId: number | null;
  backendNodeId?: number;
  frameId?: string;
  contextScopeId?: string;
  /** False for semantic-only nodes that cannot be addressed through CDP. */
  referenceable?: boolean;

  role?: string;
  name?: string;
  value?: string;
  /** Checked state is separate from the control's submitted value. */
  checked?: boolean | "mixed";
  placeholder?: string;
  inputState?: "empty" | "filled" | "default" | "unknown";
  href?: string; // hostname of external link target; omitted for same-origin links
  text?: string;
  nearbyText?: string;

  tag: string;
  rect: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;
  cursor?: string;
  attrs?: Record<string, string>;
  domParentId?: number | null;
  domAncestorIds?: number[];

  modal?: boolean;
  sensitive?: boolean;
  disabled?: boolean;
  inert?: boolean;
  hasNativeDescendant?: boolean;
  insideNative?: boolean;
  /** Derived effective interaction state; never a raw CSS z-index. */
  interactionLayer?: InteractionLayer;
}

export interface VisualEntry {
  /** Existing capture geometry/order used only by observation scope filtering. */
  rect?: Rect;
  paintOrder?: number;
  /** Exact retained Canvas node, distinct from the next sibling insertion point. */
  sourceId?: number;
  fallbackContext?: string;
  key: number;
  parentId: number | null;
  beforeId?: number;
  label?: string;
  frameId: string;
}

export interface VomScene {
  visuals?: VisualEntry[];
  viewport: Viewport;
  nodes: VomNode[];
  /** Root document whose paint order defines page-level blocking layers. */
  rootFrameId?: string;
  surfaces?: CondSurface[];
  activeScopeBlocks?: ActiveScopeBlock[];
  /** Completeness of list-like content represented by this observation. */
  completeness?: VomCompleteness;
  virtualizedLists?: VomVirtualizedListEvidence[];
}

export type VomCompleteness = "complete" | "partial" | "unknown";

export interface VomVirtualizedListEvidence {
  containerIdentity: string;
  completeness: Exclude<VomCompleteness, "complete">;
  reason: string;
  visibleCount: number;
  totalCount?: number;
}

export interface VomOptions {
  /** Select the agent-facing renderer; legacy remains the compatibility default. */
  format?: "legacy" | "compact";
  maxDepth?: number;
  maxTokens?: number;
  /**
   * When true, form values are rendered as masks instead of literal values.
   */
  redactValues?: boolean;
  /**
   * Experimental: filter refs that are geometrically blocked by foreground
   * fixed/absolute/sticky regions. Disabled by default and does not alter the
   * public layer header format.
   */
  activeRegionPolicy?: boolean;
}

export interface VomRelation {
  kind: "popup" | "controls" | "describedby" | "owns" | "labelledby";
  target: string;
}

/** Stable, queryable projection shared by compact rendering and future matchers. */
export interface VomProjectionNode {
  id: string;
  backendNodeId?: number;
  depth: number;
  ref?: string;
  role?: string;
  name?: string;
  value?: string;
  inputState?: VomNode["inputState"];
  href?: string;
  title?: string;
  rect?: Rect;
  frameId?: string;
  contextScopeId?: string;
  parentId?: string;
  region?: string;
  states: string[];
  relations: VomRelation[];
  referenceable: boolean;
  sensitive: boolean;
  layer: InteractionLayer;
}

export type InteractionLayer = "active" | "covered" | "background";

export interface VomProjection {
  nodes: VomProjectionNode[];
}

export interface CondSurface {
  triggerId: number;
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
}

export interface ActiveScopeBlock {
  triggerId: number;
  label: string;
  lines: string[];
}

export interface VomRef {
  ref: string;
  backendNodeId: number;
  frameId?: string;
}

export interface RenderedRef extends VomRef {
  visualKey?: number;
  role?: string;
  name?: string;
  ctx?: string;
  /** Zero-based line index in `VomResult.text`. */
  line: number;
}

export interface VomResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
}

export interface BlockingLayer {
  rootId: number;
  kind: Exclude<LayerKind, "page">;
  coverage: number;
  members: Set<number>;
}
