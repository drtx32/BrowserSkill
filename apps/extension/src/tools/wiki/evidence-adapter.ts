/**
 * Read-only shadow evidence adapter.
 *
 * The adapter is intentionally transport-neutral: callers can feed it the
 * evidence already produced by observe/action/navigation code and decide how
 * to persist it locally. It never sends page content anywhere and it never
 * creates or resolves an interaction ref.
 */

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_EVENTS_PER_PAGE = 10_000;

export type WikiEvidenceKind =
  | "observation"
  | "mutation"
  | "navigation"
  | "action"
  | "popup"
  | "ownership"
  | "error";

export type WikiEvidenceSource = "dom" | "ax" | "cdp" | "vom" | "daemon" | "cli" | "agent";

export type EvidenceCompleteness =
  | "complete"
  | "partial"
  | "stale"
  | "unknown"
  | "overflow"
  | "ambiguous"
  | "full_refresh_required";

export interface WikiEvidenceEvent {
  schema_version: "1.0";
  event_id: string;
  page_instance_id: string;
  revision: number;
  kind: WikiEvidenceKind;
  source: WikiEvidenceSource;
  payload: Record<string, unknown>;
  predecessor_event_id: string | null;
  completeness: EvidenceCompleteness;
}

export interface WikiEvidenceInput {
  page_instance_id: string;
  kind: WikiEvidenceKind;
  source: WikiEvidenceSource;
  payload: unknown;
  completeness?: EvidenceCompleteness;
  event_id?: string;
}

export interface EvidenceAdapterOptions {
  /** Keep URL paths in local evidence. Origins are always safe to retain. */
  retainUrlPath?: boolean;
  /** Inject an ID source for deterministic tests. */
  id?: () => string;
  /** Maximum number of distinct dirty regions retained before a refresh is required. */
  maxDirtyRegions?: number;
}

export interface SemanticRecord {
  id: string;
  /** Page-scoped canonical identity; stable_ref remains a binding/projection. */
  target_id?: string;
  region_id?: string | null;
  stable_ref?: string | null;
  [key: string]: unknown;
}

export interface SemanticChangedRecord {
  before: SemanticRecord;
  after: SemanticRecord;
  evidence: string[];
}

export interface SemanticDelta {
  page_instance_id: string;
  from_revision: number;
  to_revision: number;
  added: SemanticRecord[];
  changed: SemanticChangedRecord[];
  removed: string[];
  dirty_regions: string[];
  completeness: EvidenceCompleteness;
  fallback_reason: string | null;
}

const SECRET_KEYS = /^(?:password|passcode|token|secret|cookie|authorization|credential|file_contents?|script(?:_body)?|screenshot|image)$/i;
const URL_KEYS = /^(?:url|href|src|document_url)$/i;

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `wiki-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function originOnly(value: string, retainPath: boolean): string {
  try {
    const url = new URL(value);
    return retainPath ? `${url.origin}${url.pathname}` : url.origin;
  } catch {
    return "[redacted-url]";
  }
}

function redact(value: unknown, retainPath: boolean, key?: string): unknown {
  if (key && SECRET_KEYS.test(key)) return "[redacted]";
  if (key && URL_KEYS.test(key) && typeof value === "string") return originOnly(value, retainPath);
  if (Array.isArray(value)) return value.map((item) => redact(item, retainPath));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, retainPath, childKey),
      ]),
    );
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function boundedPayload(value: unknown, retainPath: boolean): { payload: Record<string, unknown>; truncated: boolean } {
  const safe = redact(value, retainPath);
  const candidate = safe && typeof safe === "object" && !Array.isArray(safe) ? safe : { value: safe };
  const encoded = new TextEncoder().encode(JSON.stringify(candidate));
  if (encoded.byteLength <= MAX_EVENT_BYTES) return { payload: candidate as Record<string, unknown>, truncated: false };
  return {
    payload: { redacted: true, reason: "payload_limit" },
    truncated: true,
  };
}

export class ShadowEvidenceAdapter {
  private readonly eventsByPage = new Map<string, WikiEvidenceEvent[]>();
  private readonly retainUrlPath: boolean;
  private readonly id: () => string;
  private lastEventId = new Map<string, string>();
  private readonly maxDirtyRegions: number;
  private readonly snapshots = new Map<string, Map<string, SemanticRecord>>();
  private readonly revisions = new Map<string, number>();
  private readonly dirtyRegions = new Map<string, Set<string>>();
  private readonly dirtyReasons = new Map<string, Set<string>>();
  private readonly incomplete = new Map<string, string>();

  constructor(options: EvidenceAdapterOptions = {}) {
    this.retainUrlPath = options.retainUrlPath ?? false;
    this.id = options.id ?? defaultId;
    this.maxDirtyRegions = options.maxDirtyRegions ?? 256;
  }

  capture(input: WikiEvidenceInput): WikiEvidenceEvent {
    const events = this.eventsByPage.get(input.page_instance_id) ?? [];
    const bounded = boundedPayload(input.payload, this.retainUrlPath);
    const overflow = events.length >= MAX_EVENTS_PER_PAGE;
    const event: WikiEvidenceEvent = {
      schema_version: "1.0",
      event_id: input.event_id ?? this.id(),
      page_instance_id: input.page_instance_id,
      revision: events.length + 1,
      kind: input.kind,
      source: input.source,
      payload: bounded.payload,
      predecessor_event_id: this.lastEventId.get(input.page_instance_id) ?? null,
      completeness: overflow || bounded.truncated ? "full_refresh_required" : input.completeness ?? "complete",
    };
    if (!overflow) {
      events.push(event);
      this.eventsByPage.set(input.page_instance_id, events);
      this.lastEventId.set(input.page_instance_id, event.event_id);
      const regionId = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>).region_id
        : null;
      if (input.kind === "mutation") this.markDirty(input.page_instance_id, typeof regionId === "string" ? regionId : null);
    }
    return event;
  }

  events(pageInstanceId: string): readonly WikiEvidenceEvent[] {
    return this.eventsByPage.get(pageInstanceId) ?? [];
  }

  /**
   * Record a mutation without pretending that the mutation itself is a
   * semantic snapshot. Multiple mutations for one region are coalesced until
   * the next snapshot. Overflow and ambiguous identity are sticky until a
   * caller supplies a fresh full snapshot.
   */
  markDirty(pageInstanceId: string, regionId: string | null, reason = "structure"): void {
    if (!regionId) {
      this.incomplete.set(pageInstanceId, "ambiguous_region_identity");
      return;
    }
    const regions = this.dirtyRegions.get(pageInstanceId) ?? new Set<string>();
    regions.add(regionId);
    if (regions.size > this.maxDirtyRegions) {
      this.incomplete.set(pageInstanceId, "mutation_queue_overflow");
    }
    this.dirtyRegions.set(pageInstanceId, regions);
    const reasons = this.dirtyReasons.get(pageInstanceId) ?? new Set<string>();
    reasons.add(reason);
    this.dirtyReasons.set(pageInstanceId, reasons);
  }

  /** Apply a bounded semantic snapshot and emit a conservative delta. */
  applySnapshot(pageInstanceId: string, records: readonly SemanticRecord[], fromRevision = 0): SemanticDelta {
    const previous = this.snapshots.get(pageInstanceId) ?? new Map<string, SemanticRecord>();
    const next = new Map<string, SemanticRecord>();
    let reason = this.incomplete.get(pageInstanceId) ?? null;
    const refs = new Map<string, string>();
    for (const record of records) {
      if (!record.id || next.has(record.id)) reason ??= "ambiguous_record_identity";
      if (record.target_id) {
        const owner = refs.get(`target_id:${record.target_id}`);
        if (owner && owner !== record.id) reason ??= "conflicting_target_id";
        refs.set(`target_id:${record.target_id}`, record.id);
      }
      if (record.stable_ref) {
        const owner = refs.get(record.stable_ref);
        if (owner && owner !== record.id) reason ??= "conflicting_stable_ref";
        refs.set(record.stable_ref, record.id);
      }
      if (record.id) next.set(record.id, record);
    }
    const added: SemanticRecord[] = [];
    const changed: SemanticChangedRecord[] = [];
    const removed: string[] = [];
    if (!reason) {
      for (const [id, record] of next) {
        const before = previous.get(id);
        if (!before) added.push(record);
        else if (JSON.stringify(before) !== JSON.stringify(record)) changed.push({ before, after: record, evidence: [] });
      }
      for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
      this.snapshots.set(pageInstanceId, next);
    }
    const dirty = [...(this.dirtyRegions.get(pageInstanceId) ?? [])];
    const nextRevision = Math.max(fromRevision, this.revisions.get(pageInstanceId) ?? fromRevision) + 1;
    this.revisions.set(pageInstanceId, nextRevision);
    const delta: SemanticDelta = {
      page_instance_id: pageInstanceId,
      from_revision: fromRevision,
      to_revision: nextRevision,
      added: reason ? [] : added,
      changed: reason ? [] : changed,
      removed: reason ? [] : removed,
      dirty_regions: dirty,
      completeness: reason ? "full_refresh_required" : "complete",
      fallback_reason: reason,
    };
    this.dirtyRegions.delete(pageInstanceId);
    this.dirtyReasons.delete(pageInstanceId);
    this.incomplete.delete(pageInstanceId);
    return delta;
  }

  /**
   * Return the last accepted semantic projection. This is deliberately a
   * passive read; callers must not use it to trigger reconciliation.
   */
  snapshotRecords(pageInstanceId: string): readonly SemanticRecord[] {
    return [...(this.snapshots.get(pageInstanceId)?.values() ?? [])].map((record) => ({ ...record }));
  }

  /** Apply only one dirty region while retaining the rest of the accepted projection. */
  applyTargetedSnapshot(
    pageInstanceId: string,
    regionId: string,
    records: readonly SemanticRecord[],
    fromRevision = 0,
  ): SemanticDelta {
    const retained = this.snapshotRecords(pageInstanceId).filter((record) => record.region_id !== regionId);
    return this.applySnapshot(pageInstanceId, [...retained, ...records], fromRevision);
  }

  /** Navigation creates a new identity; old snapshots must not be reused. */
  invalidate(pageInstanceId: string, reason = "navigation"): void {
    this.snapshots.delete(pageInstanceId);
    this.dirtyRegions.delete(pageInstanceId);
    this.dirtyReasons.delete(pageInstanceId);
    this.incomplete.set(pageInstanceId, reason);
  }
}
