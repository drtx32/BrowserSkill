import type { VomNode } from "./types";

export type VirtualizedCompleteness = "complete" | "partial" | "unknown";

export interface VirtualizedListAnalysis {
  containerId: number;
  containerIdentity: string;
  completeness: VirtualizedCompleteness;
  visibleCount: number;
  totalCount?: number;
  fingerprints: string[];
  reason:
    | "declared-size"
    | "position-gap"
    | "incomplete-geometry"
    | "viewport-only"
    | "no-evidence";
}

export interface VirtualizedAnalysisOptions {
  minimumItems?: number;
}

export type FrontierExhaustion = "unknown" | "proven";
export type FrontierIdentityStatus = "stable" | "ambiguous" | "inconsistent";

/**
 * The identity that makes persisted discovery safe to resume.  A frontier is
 * only a discovery record: it never restores a live DOM/action capability.
 */
export interface ListFrontierContext {
  documentIdentity: string;
  origin: string;
  sessionId?: string;
  ownerIdentity?: string;
}

export interface ListFrontier<T> {
  version: 1;
  regionIdentity: string;
  context: ListFrontierContext;
  items: T[];
  fingerprints: string[];
  nextProbe: number;
  segments: number;
  exhaustion: FrontierExhaustion;
  completeness: VirtualizedCompleteness;
  identityStatus: FrontierIdentityStatus;
  duplicateCount: number;
  needsFullRefresh: boolean;
  invalidated: boolean;
  /** Explicitly never restored from persistence. */
  actionAuthority: "none";
}

export interface ListFrontierWindow<T> {
  items: readonly T[];
  /** The next scroll/probe cursor supplied by the page or collector. */
  nextProbe?: number;
  /** Only "proven" can make a frontier complete. Omitted means unknown. */
  exhaustion?: FrontierExhaustion;
  identityStatus?: FrontierIdentityStatus;
}

export interface ListFrontierUpdate<T> {
  frontier: ListFrontier<T>;
  addedItems: T[];
  duplicateCount: number;
}

export interface RestoreListFrontierOptions {
  regionIdentity: string;
  context: ListFrontierContext;
}

function frontierContextMatches(a: ListFrontierContext, b: ListFrontierContext): boolean {
  return (
    a.documentIdentity === b.documentIdentity &&
    a.origin === b.origin &&
    a.sessionId === b.sessionId &&
    a.ownerIdentity === b.ownerIdentity
  );
}

/** Create an empty, resumable frontier for one semantic list region. */
export function createListFrontier<T>(
  regionIdentity: string,
  context: ListFrontierContext,
): ListFrontier<T> {
  return {
    version: 1,
    regionIdentity,
    context: { ...context },
    items: [],
    fingerprints: [],
    nextProbe: 0,
    segments: 0,
    exhaustion: "unknown",
    completeness: "unknown",
    identityStatus: "stable",
    duplicateCount: 0,
    needsFullRefresh: false,
    invalidated: false,
    actionAuthority: "none",
  };
}

/**
 * Merge one viewport window into a frontier.  Unknown exhaustion is the safe
 * default: a viewport disappearing, repeating, or recycling is not an end
 * sentinel. Unstable/ambiguous identity forces an explicit full refresh.
 */
export function recordListFrontierWindow<T>(
  frontier: ListFrontier<T>,
  window: ListFrontierWindow<T>,
  fingerprint: (item: T) => string,
): ListFrontierUpdate<T> {
  if (frontier.invalidated) return { frontier, addedItems: [], duplicateCount: 0 };

  const seen = new Set(frontier.fingerprints);
  const addedItems: T[] = [];
  let duplicateCount = 0;
  let identityStatus = window.identityStatus ?? frontier.identityStatus;
  for (const item of window.items) {
    const key = fingerprint(item);
    if (!key || key.startsWith("unstable-")) {
      identityStatus = "ambiguous";
      continue;
    }
    if (seen.has(key)) {
      duplicateCount++;
      continue;
    }
    seen.add(key);
    addedItems.push(item);
    frontier.items.push(item);
    frontier.fingerprints.push(key);
  }

  const needsFullRefresh =
    frontier.needsFullRefresh ||
    identityStatus !== "stable" ||
    window.identityStatus === "inconsistent";
  const exhaustion = window.exhaustion === "proven" && !needsFullRefresh ? "proven" : "unknown";
  const complete = exhaustion === "proven" && identityStatus === "stable";
  frontier.nextProbe = window.nextProbe ?? frontier.nextProbe + 1;
  frontier.segments++;
  frontier.duplicateCount += duplicateCount;
  frontier.identityStatus = identityStatus;
  frontier.needsFullRefresh = needsFullRefresh;
  frontier.exhaustion = exhaustion;
  frontier.completeness = complete ? "complete" : addedItems.length ? "partial" : "unknown";
  return { frontier, addedItems, duplicateCount };
}

/** Invalidate persisted discovery when its live ownership/document changed. */
export function invalidateListFrontier<T>(frontier: ListFrontier<T>): ListFrontier<T> {
  return {
    ...frontier,
    items: [],
    fingerprints: [],
    exhaustion: "unknown",
    completeness: "unknown",
    nextProbe: 0,
    invalidated: true,
    needsFullRefresh: true,
    actionAuthority: "none",
  };
}

/** Serialize only discovery state; action authority is deliberately absent. */
export function serializeListFrontier<T>(frontier: ListFrontier<T>): string {
  return JSON.stringify({ ...frontier, actionAuthority: "none" });
}

/** Restore only when the current region and document ownership still match. */
export function restoreListFrontier<T>(
  serialized: string,
  expected: RestoreListFrontierOptions,
): ListFrontier<T> {
  try {
    const parsed = JSON.parse(serialized) as ListFrontier<T>;
    if (
      parsed.version !== 1 ||
      parsed.regionIdentity !== expected.regionIdentity ||
      !frontierContextMatches(parsed.context, expected.context)
    ) {
      return invalidateListFrontier(
        createListFrontier<T>(expected.regionIdentity, expected.context),
      );
    }
    return {
      ...parsed,
      context: { ...expected.context },
      actionAuthority: "none",
      invalidated: Boolean(parsed.invalidated),
    };
  } catch {
    return invalidateListFrontier(createListFrontier<T>(expected.regionIdentity, expected.context));
  }
}

const LIST_ROLES = new Set(["list", "listbox", "grid", "tree", "table"]);
const ITEM_ROLES = new Set(["listitem", "option", "row", "treeitem"]);
const STABLE_ATTRIBUTES = [
  "data-id",
  "data-key",
  "data-item-id",
  "data-testid",
  "aria-posinset",
  "data-index",
  "id",
  "href",
];

function containerIdentity(node: VomNode): string {
  const attrs = node.attrs ?? {};
  for (const key of ["data-id", "data-key", "id"]) {
    const value = attrs[key]?.trim();
    if (value) return `${key}:${value}`;
  }
  if (node.frameId && node.backendNodeId !== undefined)
    return `frame:${node.frameId}:backend:${node.backendNodeId}`;
  if (node.backendNodeId !== undefined) return `backend:${node.backendNodeId}`;
  return `unstable-vom:${node.id}`;
}

function numberAttribute(node: VomNode, name: string): number | undefined {
  const value = node.attrs?.[name];
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function itemLike(node: VomNode): boolean {
  const role = node.role?.toLowerCase();
  return ITEM_ROLES.has(role ?? "") || node.attrs?.["aria-posinset"] !== undefined;
}

/**
 * Identity that survives a recycled virtualized window. Backend ids are an
 * unstable last resort because virtualized DOM implementations recycle them.
 */
export function stableItemFingerprint(
  node: Pick<VomNode, "backendNodeId" | "id" | "role" | "name" | "text" | "href" | "attrs">,
): string {
  const attrs = node.attrs ?? {};
  for (const key of STABLE_ATTRIBUTES) {
    const value = attrs[key]?.trim();
    if (value) return `${key}:${value}`;
  }
  const semanticParts = [node.role, node.name, node.text, node.href].map(
    (value) => value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "",
  );
  const semantic = semanticParts.join("|");
  if (semanticParts.slice(1).some(Boolean)) return `semantic:${semantic}`;
  if (node.backendNodeId !== undefined) return `unstable-backend:${node.backendNodeId}:${node.id}`;
  return `unstable-vom:${node.id}`;
}

function childrenOf(nodes: readonly VomNode[], container: VomNode): VomNode[] {
  const descendants = new Map<number, VomNode[]>();
  for (const node of nodes) {
    const children = descendants.get(node.parentId ?? -1) ?? [];
    children.push(node);
    descendants.set(node.parentId ?? -1, children);
  }
  const result: VomNode[] = [];
  const queue = [container.id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of descendants.get(queue[index]) ?? []) {
      if (itemLike(child)) result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

/** Analyze a VOM snapshot without treating a viewport slice as complete. */
export function analyzeVirtualizedLists(
  nodes: readonly VomNode[],
  options: VirtualizedAnalysisOptions = {},
): VirtualizedListAnalysis[] {
  const minimumItems = Math.max(1, options.minimumItems ?? 2);
  return nodes
    .filter((node) => LIST_ROLES.has(node.role?.toLowerCase() ?? ""))
    .map((container) => {
      const items = childrenOf(nodes, container);
      const declared = numberAttribute(container, "aria-setsize");
      const itemDeclared = items.map((item) => numberAttribute(item, "aria-setsize")).find(Boolean);
      const totalCount = declared ?? itemDeclared;
      const positions = items
        .map((item) => numberAttribute(item, "aria-posinset"))
        .filter((value): value is number => value !== undefined);
      const hasGap =
        positions.length > 1 && positions.some((value, index) => value !== positions[0] + index);
      const hasIncompleteGeometry = items.some((item) => item.rect === null);
      const viewportOnly = items.length >= minimumItems && !hasIncompleteGeometry;
      const partial = (totalCount !== undefined && totalCount > items.length) || hasGap;
      return {
        containerId: container.id,
        containerIdentity: containerIdentity(container),
        completeness:
          partial || hasIncompleteGeometry
            ? partial
              ? "partial"
              : "unknown"
            : viewportOnly && totalCount === undefined
              ? "unknown"
              : "complete",
        visibleCount: items.length,
        ...(totalCount !== undefined ? { totalCount } : {}),
        fingerprints: items.map(stableItemFingerprint),
        reason: partial
          ? totalCount !== undefined
            ? "declared-size"
            : "position-gap"
          : hasIncompleteGeometry
            ? "incomplete-geometry"
            : viewportOnly
              ? "viewport-only"
              : "no-evidence",
      };
    });
}

export interface VirtualizedSegment<T> {
  items: readonly T[];
  complete: boolean;
}

export interface CollectVirtualizedOptions<T> {
  read: (segment: number) => Promise<VirtualizedSegment<T>>;
  advance: (segment: number) => Promise<VirtualizedAdvance | boolean>;
  fingerprint: (item: T) => string;
  maxSegments?: number;
  maxStalledSegments?: number;
  signal?: AbortSignal;
}

export interface CollectVirtualizedResult<T> {
  items: T[];
  segments: number;
  complete: boolean;
  termination:
    | "complete"
    | "max-segments"
    | "stalled"
    | "end-of-list"
    | "advance-failed"
    | "aborted";
}

export type VirtualizedAdvance = "advanced" | "end-of-list" | "failed";

/** Bounded segmented collection with cross-window deduplication. */
export async function collectVirtualizedSegments<T>(
  options: CollectVirtualizedOptions<T>,
): Promise<CollectVirtualizedResult<T>> {
  const maxSegments = Math.max(1, options.maxSegments ?? 100);
  const maxStalledSegments = Math.max(1, options.maxStalledSegments ?? 2);
  const seen = new Set<string>();
  const items: T[] = [];
  let stalled = 0;
  for (let segment = 0; segment < maxSegments; segment += 1) {
    if (options.signal?.aborted)
      return { items, segments: segment, complete: false, termination: "aborted" };
    const current = await options.read(segment);
    let added = 0;
    for (const item of current.items) {
      const key = options.fingerprint(item);
      // An unstable identity is intentionally not deduplicated. Keeping a
      // possible duplicate is safer than silently dropping a recycled row.
      const unstable = key.startsWith("unstable-");
      if (!unstable && seen.has(key)) continue;
      if (!unstable) seen.add(key);
      items.push(item);
      added += 1;
    }
    if (current.complete)
      return { items, segments: segment + 1, complete: true, termination: "complete" };
    stalled = added === 0 ? stalled + 1 : 0;
    if (stalled >= maxStalledSegments)
      return { items, segments: segment + 1, complete: false, termination: "stalled" };
    const advanced = await options.advance(segment);
    if (advanced === "end-of-list")
      return { items, segments: segment + 1, complete: true, termination: "end-of-list" };
    if (advanced === "failed" || advanced === false)
      return { items, segments: segment + 1, complete: false, termination: "advance-failed" };
  }
  return { items, segments: maxSegments, complete: false, termination: "max-segments" };
}
