import type { InteractionLayer } from "@browser-skill/vom";
import type { VisualCandidate } from "@/tools/vom/visual-discovery";

/** Session-local refs describe the latest observation. Reusing eN does not identify
 * which observation a caller read; generation is internal bookkeeping only. */
export type BackendNodeId = number;

export interface DomRefEntry {
  readonly kind: "dom";
  name?: string;
  backendNodeId: BackendNodeId;
  tabId: number | null;
  frameId?: string;
  cdpSessionId?: string;
  generation: number;
  identity?: RefIdentity;
}

export interface RefIdentity {
  role?: string;
  name?: string;
  text?: string;
  context?: string;
  frameId?: string;
  layer?: InteractionLayer;
  stableId?: string;
  path?: string;
}

export interface VisualRefInput {
  readonly kind: "visual-region";
  readonly candidate: VisualCandidate;
}

export type RefEntry = DomRefEntry | (VisualRefInput & { readonly generation: number });

export type RefInput =
  | VisualRefInput
  | BackendNodeId
  | {
      name?: string;
      backendNodeId: BackendNodeId;
      tabId: number;
      frameId?: string;
      cdpSessionId?: string;
      identity?: RefIdentity;
    };

export class RefStore {
  private map = new Map<string, RefEntry>();
  private readonly logical = new Map<string, { ref: string; entry: RefEntry; used: number }>();
  private generation = 0;
  private readonly documents = new Map<number, number>();
  private readonly maxLogicalEntries: number;
  private clock = 0;

  constructor(options: { maxLogicalEntries?: number } = {}) {
    this.maxLogicalEntries = Math.max(32, options.maxLogicalEntries ?? 512);
  }

  get revision(): number {
    return this.generation;
  }

  size(): number {
    return this.map.size;
  }

  /** Number of retained semantic identities (bounded by construction). */
  logicalSizeForTest(): number {
    return this.logical.size;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }

  resolve(ref: string, opts: { tabId?: number } = {}): BackendNodeId | null {
    const entry = this.map.get(normaliseRef(ref));
    if (!entry || entry.kind !== "dom") return null;
    if (opts.tabId !== undefined && entry.tabId !== opts.tabId) return null;
    return entry.backendNodeId;
  }

  resolveEntry(ref: string): RefEntry | null {
    return this.map.get(normaliseRef(ref)) ?? null;
  }

  /** The last semantic entry retained for a logical ref, even after its node is stale. */
  logicalEntryForRef(ref: string): DomRefEntry | null {
    const key = normaliseRef(ref);
    let latest: { entry: DomRefEntry; used: number } | null = null;
    for (const value of this.logical.values()) {
      if (value.ref === key && value.entry.kind === "dom" && (!latest || value.used > latest.used))
        latest = { entry: value.entry, used: value.used };
    }
    return latest?.entry ?? null;
  }

  /** Rebind a stale ref only when its stored identity has one active match. */
  rebindUnique(ref: string, tabId: number): DomRefEntry | null {
    const prior = this.logicalEntryForRef(ref);
    if (!prior || prior.tabId !== tabId || !prior.identity) return null;
    const matches = [...this.map.entries()].filter(([, entry]) => {
      if (entry.kind !== "dom" || entry.tabId !== tabId || entry.identity?.layer !== "active")
        return false;
      if (!sameScope(prior, entry)) return false;
      return identityKey(entry.identity, entry.tabId) === identityKey(prior.identity, prior.tabId);
    });
    if (matches.length !== 1 || matches[0][1].kind !== "dom") return null;
    this.map.set(normaliseRef(ref), matches[0][1]);
    return matches[0][1];
  }

  /**
   * Replace the entire store with a new ref → CDP node identity mapping.
   * Used after every fresh `tool.snapshot`.
   */
  replace(entries: Iterable<readonly [string, RefInput]>): void {
    this.replaceStable(entries);
  }

  replaceStable(entries: Iterable<readonly [string, RefInput]>): Map<string, string> {
    const generation = this.generation + 1;
    const next = new Map<string, RefEntry>();
    const mapping = new Map<string, string>();
    const used = new Set<string>();
    const seenKeys = new Set<string>();
    for (const [rawRef, input] of entries) {
      const candidate = this.entry(input, generation);
      const generatedRef = normaliseRef(rawRef);
      const key =
        candidate.kind === "dom" ? identityKey(candidate.identity, candidate.tabId) : undefined;
      const duplicate = key !== undefined && seenKeys.has(key);
      if (key) seenKeys.add(key);
      const prior = key && !duplicate ? this.logical.get(key) : undefined;
      let logicalRef =
        prior && sameScope(prior.entry, candidate) && !used.has(prior.ref)
          ? prior.ref
          : generatedRef;
      while (used.has(logicalRef)) logicalRef = this.allocateRef(used);
      used.add(logicalRef);
      mapping.set(generatedRef, logicalRef);
      next.set(logicalRef, candidate);
      if (key && !duplicate)
        this.logical.set(key, { ref: logicalRef, entry: candidate, used: ++this.clock });
    }
    this.map = next;
    this.generation = generation;
    this.gc(used);
    return mapping;
  }

  set(
    ref: string,
    id: BackendNodeId,
    opts: {
      tabId?: number;
      frameId?: string;
      cdpSessionId?: string;
    } = {},
  ): void {
    this.map.set(normaliseRef(ref), {
      kind: "dom",
      backendNodeId: id,
      tabId: opts.tabId ?? null,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.cdpSessionId ? { cdpSessionId: opts.cdpSessionId } : {}),
      generation: this.generation,
    });
  }

  documentRevision(tabId: number): number {
    return this.documents.get(tabId) ?? 0;
  }

  /** A CDP node id may be reused by a new document in the same tab. */
  invalidateTab(tabId: number): void {
    this.documents.set(tabId, this.documentRevision(tabId) + 1);
    let changed = false;
    for (const [ref, entry] of this.map) {
      const owner = entry.kind === "dom" ? entry.tabId : entry.candidate.document.target.tabId;
      if (owner === tabId) {
        this.map.delete(ref);
        changed = true;
      }
    }
    for (const [key, value] of this.logical) {
      const owner =
        value.entry.kind === "dom"
          ? value.entry.tabId
          : value.entry.candidate.document.target.tabId;
      if (owner === tabId) this.logical.delete(key);
    }
    if (changed) this.generation++;
  }

  clear(): void {
    this.generation++;
    this.map.clear();
    this.logical.clear();
  }

  entries(): IterableIterator<[string, RefEntry]> {
    return this.map.entries();
  }

  private entry(input: RefInput, generation: number): RefEntry {
    if (typeof input !== "number" && "kind" in input) {
      const { document } = input.candidate;
      if (
        !document?.attachmentId ||
        !document.frameId ||
        !Number.isSafeInteger(document.target?.tabId) ||
        !Number.isSafeInteger(document.documentElementBackendNodeId) ||
        document.documentElementBackendNodeId <= 0 ||
        !Number.isSafeInteger(input.candidate.backendNodeId) ||
        input.candidate.backendNodeId <= 0
      )
        throw new TypeError("visual ref requires a verified DOM identity and anchor");
      // Preserve the read-only evidence and shared clipping chain; do not clone ancestors per ref.
      return { kind: "visual-region", candidate: input.candidate, generation };
    }
    if (typeof input === "number") {
      return {
        kind: "dom",
        backendNodeId: input,
        tabId: null,
        generation,
      };
    }
    return {
      kind: "dom",
      ...(input.name ? { name: input.name } : {}),
      backendNodeId: input.backendNodeId,
      tabId: input.tabId,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.cdpSessionId ? { cdpSessionId: input.cdpSessionId } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
      generation,
    };
  }

  private allocateRef(used: Set<string>): string {
    let n = 1;
    while (used.has(`e${n}`) || this.map.has(`e${n}`)) n++;
    return `e${n}`;
  }

  private gc(current: Set<string>): void {
    for (const value of this.logical.values())
      if (current.has(value.ref)) value.used = ++this.clock;
    while (this.logical.size > this.maxLogicalEntries) {
      let oldest: string | undefined;
      let age = Infinity;
      for (const [key, value] of this.logical)
        if (value.used < age) {
          age = value.used;
          oldest = key;
        }
      if (!oldest) break;
      this.logical.delete(oldest);
    }
  }
}

function sameScope(a: RefEntry, b: RefEntry): boolean {
  if (a.kind !== "dom" || b.kind !== "dom") return false;
  if (a.tabId !== b.tabId || a.cdpSessionId !== b.cdpSessionId) return false;
  if (a.frameId === b.frameId) return true;
  // A same-session soft frame refresh may allocate a new frame id. Preserve
  // only when an application-stable identifier agrees; otherwise frame
  // changes remain an intentional scope boundary.
  return Boolean(
    a.identity?.stableId && b.identity?.stableId && a.identity.stableId === b.identity.stableId,
  );
}

function identityKey(identity: RefIdentity | undefined, tabId: number | null): string | undefined {
  if (!identity || (identity.layer !== undefined && identity.layer !== "active")) return undefined;
  const values = [
    identity.stableId,
    identity.path,
    identity.role,
    identity.name,
    identity.text,
    identity.context,
  ];
  if (values.every((value) => !value)) return undefined;
  return `${tabId ?? "?"}|${values.map((value) => value ?? "").join("\u0001")}`;
}

/** Canonical RefStore key: `@e3` and `e3` both become `e3`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}
