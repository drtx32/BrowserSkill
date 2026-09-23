import { type SemanticDelta, type SemanticRecord, ShadowEvidenceAdapter } from "./evidence-adapter";
import type { OwnershipGuard, WikiScope } from "./guarded-maintenance";
import {
  canonicalSemanticAddress,
  resolveSemanticTarget,
  type SemanticAddress,
  type SemanticQuery,
  type SemanticTarget,
} from "./semantic-address";

export interface CanonicalTargetInput {
  target_id: string;
  address: SemanticAddress;
  stable_ref?: string | null;
  region_id?: string | null;
  aliases?: readonly string[];
  stableAttributes?: Readonly<Record<string, string | number | boolean>>;
  structuralRelation?: string;
  evidence_event_ids?: readonly string[];
}

export interface CurrentBinding {
  stable_ref: string | null;
  revision: number;
  live: boolean;
}

export interface TargetRecord extends SemanticTarget {
  scope: WikiScope;
  region_id: string | null;
  current_binding: CurrentBinding;
  provenance: readonly string[];
  status: "current" | "removed" | "invalidated";
}

export type PerceptionOutcome = "accepted" | "unresolved" | "full_refresh_required";

export interface PerceptionReceipt {
  outcome: PerceptionOutcome;
  delta: SemanticDelta;
  revision: number;
  fallback_reason: string | null;
  changed_target_ids: readonly string[];
  live_binding: boolean;
}

export interface PerceptionRead {
  target: TargetRecord | null;
  outcome: "resolved" | "unresolved";
  reason: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameScope(left: WikiScope, right: WikiScope): boolean {
  return (
    left.browser_id === right.browser_id &&
    left.session_id === right.session_id &&
    left.tab_id === right.tab_id &&
    left.document_id === right.document_id &&
    left.origin === right.origin
  );
}

function recordFor(input: CanonicalTargetInput): SemanticRecord {
  // The canonical id is the record key. An observation-local @eN is only a
  // replaceable projection and can never become an id here.
  return {
    id: input.target_id,
    target_id: input.target_id,
    region_id: input.region_id ?? null,
    stable_ref: input.stable_ref ?? null,
    address: input.address,
    aliases: input.aliases ?? [],
    stableAttributes: input.stableAttributes,
    structuralRelation: input.structuralRelation,
    evidence_event_ids: input.evidence_event_ids ?? [],
  };
}

function validateInputs(inputs: readonly CanonicalTargetInput[]): string | null {
  const ids = new Set<string>();
  const addresses = new Map<string, string>();
  for (const input of inputs) {
    if (!input.target_id || !input.address.origin || !input.address.document)
      return "incomplete_canonical_identity";
    if (ids.has(input.target_id)) return "conflicting_target_id";
    ids.add(input.target_id);
    const address = canonicalSemanticAddress(input.address);
    const owner = addresses.get(address);
    if (owner && owner !== input.target_id) return "conflicting_canonical_address";
    addresses.set(address, input.target_id);
  }
  return null;
}

/**
 * Canonical perception projection over the existing Page Wiki/SemanticDelta
 * adapter. It owns no evidence persistence and never reconciles on reads.
 */
export class CanonicalPerception {
  private scope: WikiScope | null = null;
  private ownership: OwnershipGuard | null = null;
  private active = false;
  private readonly current = new Map<string, TargetRecord>();
  private readonly history = new Map<string, TargetRecord[]>();

  constructor(private readonly wiki: ShadowEvidenceAdapter) {}

  applyFullObservation(
    scope: WikiScope,
    ownership: OwnershipGuard,
    inputs: readonly CanonicalTargetInput[],
    fromRevision = 0,
  ): PerceptionReceipt {
    const mismatch = validateInputs(inputs);
    if (mismatch) return this.rejected(scope, fromRevision, mismatch);
    if (this.scope && !sameScope(this.scope, scope)) this.rollover(scope, "scope_rollover");
    this.scope = clone(scope);
    this.ownership = clone(ownership);
    this.active = true;
    const delta = this.wiki.applySnapshot(scope.document_id, inputs.map(recordFor), fromRevision);
    return this.commit(scope, inputs, delta);
  }

  applyTargetedRegion(
    scope: WikiScope,
    ownership: OwnershipGuard,
    regionId: string,
    inputs: readonly CanonicalTargetInput[],
    fromRevision = 0,
  ): PerceptionReceipt {
    const mismatch = validateInputs(inputs);
    if (mismatch) return this.rejected(scope, fromRevision, mismatch);
    if (
      !this.active ||
      !this.scope ||
      !sameScope(this.scope, scope) ||
      !this.ownership ||
      this.ownership.ownership_id !== ownership.ownership_id
    )
      return this.rejected(scope, fromRevision, "binding_scope_or_ownership_mismatch");
    const delta = this.wiki.applyTargetedSnapshot(
      scope.document_id,
      regionId,
      inputs.map(recordFor),
      fromRevision,
    );
    return this.commit(scope, inputs, delta);
  }

  /** Record a bounded mutation and leave targeted re-perception to the caller. */
  markDirty(pageInstanceId: string, regionId: string | null, reason = "structure"): void {
    this.wiki.markDirty(pageInstanceId, regionId, reason);
  }

  /** Passive lookup over the current projection; no delta, observe, or backfill is started. */
  read(query: SemanticQuery, scope: WikiScope): PerceptionRead {
    if (!this.active || !this.scope || !sameScope(this.scope, scope))
      return { target: null, outcome: "unresolved", reason: "scope_mismatch" };
    const targets = [...this.current.values()].filter((target) => target.status === "current");
    const result = resolveSemanticTarget(query, targets, undefined);
    return {
      target: result.target ? clone(this.current.get(result.target.target_id) ?? null) : null,
      outcome: result.target ? "resolved" : "unresolved",
      reason: result.reason,
    };
  }

  canMutate(targetId: string, scope: WikiScope, ownership: OwnershipGuard): boolean {
    const record = this.current.get(targetId);
    return Boolean(
      this.active &&
        record?.status === "current" &&
        record.current_binding.live &&
        this.scope &&
        sameScope(this.scope, scope) &&
        this.ownership?.ownership_id === ownership.ownership_id,
    );
  }

  rollover(scope: WikiScope, reason = "document_or_origin_rollover"): void {
    const previousDocumentId = this.scope?.document_id;
    if (this.scope) {
      for (const record of this.current.values()) {
        record.status = "invalidated";
        record.current_binding.live = false;
        const entries = this.history.get(record.target_id) ?? [];
        entries.push(clone(record));
        this.history.set(record.target_id, entries);
      }
    }
    this.current.clear();
    if (previousDocumentId) this.wiki.invalidate(previousDocumentId, reason);
    this.scope = clone(scope);
    this.ownership = null;
    this.active = false;
  }

  historyFor(targetId: string): readonly TargetRecord[] {
    return clone(this.history.get(targetId) ?? []);
  }

  /** Read-only projection for record/replay; the canonical map remains the sole identity store. */
  currentTargets(scope: WikiScope): readonly TargetRecord[] {
    if (!this.active || !this.scope || !sameScope(this.scope, scope)) return [];
    return clone([...this.current.values()].filter((target) => target.status === "current"));
  }

  /** Materialize one bounded recording checkpoint through the canonical delta path. */
  materializeRecordingObservation(
    scope: WikiScope,
    ownership: OwnershipGuard,
    inputs: readonly CanonicalTargetInput[],
    fromRevision: number,
  ): PerceptionReceipt {
    if (
      this.active &&
      this.scope &&
      sameScope(this.scope, scope) &&
      this.ownership?.ownership_id === ownership.ownership_id
    ) {
      return this.applyTargetedRegion(
        scope,
        ownership,
        "recording-observation",
        inputs,
        fromRevision,
      );
    }
    return this.applyFullObservation(scope, ownership, inputs, fromRevision);
  }

  /** Drop live and historical recording authority when its session ends. */
  releaseSession(sessionId: string): void {
    if (this.scope?.session_id !== sessionId) return;
    this.current.clear();
    this.history.clear();
    this.active = false;
    this.ownership = null;
    this.scope = null;
  }

  private commit(
    scope: WikiScope,
    inputs: readonly CanonicalTargetInput[],
    delta: SemanticDelta,
  ): PerceptionReceipt {
    const changed = new Set<string>();
    for (const entry of delta.changed) {
      changed.add(entry.after.target_id ?? entry.after.id);
      const current = this.current.get(entry.after.target_id ?? entry.after.id);
      if (current) {
        current.current_binding = {
          stable_ref: String(entry.after.stable_ref ?? "") || null,
          revision: delta.to_revision,
          live: true,
        };
        current.provenance = [
          ...new Set([
            ...(current.provenance ?? []),
            ...((entry.after.evidence_event_ids as string[]) ?? []),
          ]),
        ];
      }
    }
    for (const input of inputs) {
      const id = input.target_id;
      if (
        !delta.added.some((record) => record.target_id === id) &&
        !delta.changed.some((entry) => entry.after.target_id === id)
      )
        continue;
      const previous = this.current.get(id);
      const next: TargetRecord = {
        target_id: id,
        address: clone(input.address),
        aliases: [...(input.aliases ?? [])],
        stableAttributes: input.stableAttributes,
        structuralRelation: input.structuralRelation,
        value: undefined,
        scope: clone(scope),
        region_id: input.region_id ?? null,
        current_binding: {
          stable_ref: input.stable_ref ?? null,
          revision: delta.to_revision,
          live: true,
        },
        provenance: [...(input.evidence_event_ids ?? previous?.provenance ?? [])],
        status: "current",
      };
      this.current.set(id, next);
      changed.add(id);
    }
    for (const id of delta.removed) {
      const current = this.current.get(id);
      if (current) {
        current.status = "removed";
        current.current_binding.live = false;
      }
    }
    const fallback = delta.completeness === "complete" ? null : delta.fallback_reason;
    return {
      outcome: delta.completeness === "complete" ? "accepted" : "full_refresh_required",
      delta,
      revision: delta.to_revision,
      fallback_reason: fallback,
      changed_target_ids: [...changed],
      live_binding: delta.completeness === "complete" && this.active,
    };
  }

  private rejected(scope: WikiScope, fromRevision: number, reason: string): PerceptionReceipt {
    const delta: SemanticDelta = {
      page_instance_id: scope.document_id,
      from_revision: fromRevision,
      to_revision: fromRevision,
      added: [],
      changed: [],
      removed: [],
      dirty_regions: [],
      completeness: "full_refresh_required",
      fallback_reason: reason,
    };
    return {
      outcome: "unresolved",
      delta,
      revision: fromRevision,
      fallback_reason: reason,
      changed_target_ids: [],
      live_binding: false,
    };
  }
}
