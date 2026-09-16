import type { VomNode } from "./types";

export type VirtualizedCompleteness = "complete" | "partial" | "unknown";

export interface VirtualizedListAnalysis {
  containerId: number;
  completeness: VirtualizedCompleteness;
  visibleCount: number;
  totalCount?: number;
  fingerprints: string[];
  reason: "declared-size" | "position-gap" | "viewport-only" | "no-evidence";
}

export interface VirtualizedAnalysisOptions {
  minimumItems?: number;
}

const LIST_ROLES = new Set(["list", "listbox", "grid", "tree", "table"]);
const ITEM_ROLES = new Set(["listitem", "option", "row", "treeitem"]);
const STABLE_ATTRIBUTES = ["data-id", "data-key", "data-item-id", "data-testid", "id", "href"];

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

/** Identity that survives a recycled virtualized window. */
export function stableItemFingerprint(
  node: Pick<VomNode, "backendNodeId" | "id" | "role" | "name" | "text" | "href" | "attrs">,
): string {
  const attrs = node.attrs ?? {};
  for (const key of STABLE_ATTRIBUTES) {
    const value = attrs[key]?.trim();
    if (value) return `${key}:${value}`;
  }
  const semantic = [node.role, node.name, node.text, node.href]
    .map((value) => value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "")
    .join("|");
  if (semantic.replace(/\|/g, "")) return `semantic:${semantic}`;
  if (node.backendNodeId !== undefined) return `backend:${node.backendNodeId}`;
  return `vom:${node.id}`;
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
      const hasGap = positions.length > 1 && positions.some((value, index) => value !== positions[0] + index);
      const viewportOnly = items.length >= minimumItems && items.every((item) => item.rect !== null);
      const partial = (totalCount !== undefined && totalCount > items.length) || hasGap;
      return {
        containerId: container.id,
        completeness: partial ? "partial" : viewportOnly && totalCount === undefined ? "unknown" : "complete",
        visibleCount: items.length,
        ...(totalCount !== undefined ? { totalCount } : {}),
        fingerprints: items.map(stableItemFingerprint),
        reason: partial ? (totalCount !== undefined ? "declared-size" : "position-gap") : viewportOnly ? "viewport-only" : "no-evidence",
      };
    });
}

export interface VirtualizedSegment<T> {
  items: readonly T[];
  complete: boolean;
}

export interface CollectVirtualizedOptions<T> {
  read: (segment: number) => Promise<VirtualizedSegment<T>>;
  advance: (segment: number) => Promise<boolean>;
  fingerprint: (item: T) => string;
  maxSegments?: number;
  maxStalledSegments?: number;
  signal?: AbortSignal;
}

export interface CollectVirtualizedResult<T> {
  items: T[];
  segments: number;
  complete: boolean;
  termination: "complete" | "max-segments" | "stalled" | "aborted";
}

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
    if (options.signal?.aborted) return { items, segments: segment, complete: false, termination: "aborted" };
    const current = await options.read(segment);
    let added = 0;
    for (const item of current.items) {
      const key = options.fingerprint(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      added += 1;
    }
    if (current.complete) return { items, segments: segment + 1, complete: true, termination: "complete" };
    stalled = added === 0 ? stalled + 1 : 0;
    if (stalled >= maxStalledSegments) return { items, segments: segment + 1, complete: false, termination: "stalled" };
    if (!(await options.advance(segment))) return { items, segments: segment + 1, complete: false, termination: "stalled" };
  }
  return { items, segments: maxSegments, complete: false, termination: "max-segments" };
}
