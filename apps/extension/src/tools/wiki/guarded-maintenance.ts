import type {
  ShadowEvidenceAdapter,
  WikiEvidenceEvent,
  WikiEvidenceSource,
} from "./evidence-adapter";

/** Wire-authoritative Stage 4 scope. Keep this parity-exact with Rust WikiScope. */
export interface WikiScope {
  browser_id: string;
  session_id: string;
  tab_id: number;
  document_id: string;
  origin: string;
}

export type ClaimTrust = "ground_truth" | "derived" | "agent_inference";
export type ClaimStatus =
  | "active"
  | "removed"
  | "current"
  | "stale"
  | "superseded"
  | "uncertain"
  | "invalidated";
export type ReconcileOutcome = "accepted" | "rejected" | "uncertain";

/** Additive TypeScript mirror of the frozen bsk-protocol Claim ABI. */
export interface WikiClaim {
  schema_version: "1.0";
  claim_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  trust: ClaimTrust;
  status: ClaimStatus;
  evidence_event_ids: string[];
  evidence_revision: number;
  last_verified_revision: number | null;
  confidence: number | null;
  provenance: {
    kind: "observed" | "reconciled" | "annotated";
    author: string;
    evidence_event_ids: string[];
  };
  valid_from_revision: number;
  valid_until_revision: number | null;
}

/** Ownership is a live control-plane guard and is intentionally not persisted in WikiScope. */
export interface OwnershipGuard {
  ownership_id: string;
}

export interface TrustedEvidence {
  event_id: string;
  page_instance_id: string;
  scope: WikiScope;
  ownership: OwnershipGuard;
  kind: "observation" | "action";
  source: Exclude<WikiEvidenceSource, "agent">;
  revision: number;
  completeness: WikiEvidenceEvent["completeness"];
  payload: Record<string, unknown>;
}

/**
 * A bounded evidence lookup populated from the existing passive adapter.
 * Ground-truth operations receive only an event id and resolve authority here;
 * callers cannot assert an adapter/source on a reconcile request.
 */
export class TrustedEvidenceStore {
  private readonly eventsById = new Map<string, TrustedEvidence>();

  static fromShadowAdapter(
    adapter: ShadowEvidenceAdapter,
    pageInstanceId: string,
    scope: WikiScope,
    ownership: OwnershipGuard,
  ): TrustedEvidenceStore {
    const store = new TrustedEvidenceStore();
    for (const event of adapter.events(pageInstanceId)) {
      if (event.kind !== "observation" && event.kind !== "action") continue;
      if (event.source === "agent") continue;
      store.eventsById.set(event.event_id, {
        event_id: event.event_id,
        page_instance_id: event.page_instance_id,
        scope: { ...scope },
        ownership: { ...ownership },
        kind: event.kind,
        source: event.source,
        revision: event.revision,
        completeness: event.completeness,
        payload: { ...event.payload },
      });
    }
    return store;
  }

  resolve(eventId: string): TrustedEvidence | undefined {
    const event = this.eventsById.get(eventId);
    return event ? clone(event) : undefined;
  }
}

export interface ClaimRecord {
  claim: WikiClaim;
  scope: WikiScope;
  ownership: OwnershipGuard;
}

export interface AnnotateInput {
  claim_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  scope: WikiScope;
  ownership: OwnershipGuard;
  evidence_event_ids: string[];
  evidence_revision: number;
  author: string;
}

export interface PatchInput {
  claim_id: string;
  scope: WikiScope;
  ownership: OwnershipGuard;
  expected_evidence_revision: number;
  value: unknown;
  evidence_event_ids: string[];
  evidence_revision: number;
}

export interface ReconcileInput {
  claim_id: string;
  scope: WikiScope;
  ownership: OwnershipGuard;
  expected_evidence_revision: number;
  event_id: string;
}

export interface GroundTruthInput {
  claim_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  scope: WikiScope;
  ownership: OwnershipGuard;
  event_id: string;
  supersedes_claim_id?: string;
}

export type MaintenanceErrorCode =
  | "scope_mismatch"
  | "ownership_mismatch"
  | "stale_revision"
  | "unknown_claim"
  | "invalid_transition"
  | "missing_provenance"
  | "untrusted_evidence";

export interface MaintenanceError {
  ok: false;
  code: MaintenanceErrorCode;
  message: string;
}
export type MaintenanceResult<T> = { ok: true; value: T } | MaintenanceError;

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  record: ClaimRecord;
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

function sameOwnership(left: OwnershipGuard, right: OwnershipGuard): boolean {
  return left.ownership_id === right.ownership_id;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failure(code: MaintenanceErrorCode, message: string): MaintenanceError {
  return { ok: false, code, message };
}

function guardScope(
  record: ClaimRecord,
  scope: WikiScope,
  ownership: OwnershipGuard,
): MaintenanceError | undefined {
  if (!sameScope(record.scope, scope))
    return failure(
      "scope_mismatch",
      "claim scope does not match browser/session/tab/document/origin",
    );
  if (!sameOwnership(record.ownership, ownership))
    return failure(
      "ownership_mismatch",
      "claim ownership does not match the live control-plane owner",
    );
  return undefined;
}

/** Guarded agent maintenance. Trust is immutable for the lifetime of a claim. */
export class GuardedWikiMaintenance {
  private readonly records = new Map<string, ClaimRecord>();
  private readonly historyByClaim = new Map<string, ClaimRecord[]>();

  constructor(private readonly trustedEvidence: TrustedEvidenceStore) {}

  annotate(input: AnnotateInput): MaintenanceResult<ClaimRecord> {
    if (this.records.has(input.claim_id))
      return failure("invalid_transition", "claim already exists");
    if (input.evidence_event_ids.length === 0)
      return failure("missing_provenance", "annotation requires evidence ids");
    const claim: WikiClaim = {
      schema_version: "1.0",
      claim_id: input.claim_id,
      subject_id: input.subject_id,
      predicate: input.predicate,
      value: clone(input.value),
      trust: "agent_inference",
      status: "uncertain",
      evidence_event_ids: [...input.evidence_event_ids],
      evidence_revision: input.evidence_revision,
      last_verified_revision: null,
      confidence: null,
      provenance: {
        kind: "annotated",
        author: input.author,
        evidence_event_ids: [...input.evidence_event_ids],
      },
      valid_from_revision: input.evidence_revision,
      valid_until_revision: null,
    };
    const record = { claim, scope: clone(input.scope), ownership: clone(input.ownership) };
    this.records.set(input.claim_id, record);
    this.historyByClaim.set(input.claim_id, []);
    return { ok: true, value: clone(record) };
  }

  patch(input: PatchInput): MaintenanceResult<ClaimRecord> {
    const current = this.records.get(input.claim_id);
    if (!current) return failure("unknown_claim", "claim does not exist");
    const guard = guardScope(current, input.scope, input.ownership);
    if (guard) return guard;
    if (current.claim.evidence_revision !== input.expected_evidence_revision)
      return failure("stale_revision", "expected evidence revision does not match");
    if (current.claim.trust !== "agent_inference" && current.claim.trust !== "derived") {
      return failure("invalid_transition", "patch cannot change a ground-truth claim");
    }
    if (input.evidence_revision < input.expected_evidence_revision)
      return failure("stale_revision", "patch evidence is older than the expected revision");
    if (input.evidence_event_ids.length === 0)
      return failure("missing_provenance", "patch requires current evidence provenance");
    this.saveHistory(current);
    current.claim.value = clone(input.value);
    current.claim.evidence_event_ids = [...input.evidence_event_ids];
    current.claim.evidence_revision = input.evidence_revision;
    current.claim.status = "current";
    return { ok: true, value: clone(current) };
  }

  reconcile(input: ReconcileInput): MaintenanceResult<ReconcileResult> {
    const current = this.records.get(input.claim_id);
    if (!current) return failure("unknown_claim", "claim does not exist");
    const guard = guardScope(current, input.scope, input.ownership);
    if (guard) return guard;
    if (current.claim.evidence_revision !== input.expected_evidence_revision)
      return failure("stale_revision", "expected evidence revision does not match");
    const evidence = this.trustedEvidence.resolve(input.event_id);
    if (!evidence)
      return failure(
        "untrusted_evidence",
        "event is not materialized by the trusted observation/action path",
      );
    if (
      !sameScope(current.scope, evidence.scope) ||
      !sameOwnership(current.ownership, evidence.ownership) ||
      evidence.revision < input.expected_evidence_revision
    ) {
      return failure("stale_revision", "resolved evidence is stale or out of scope");
    }

    const evidenceValue = evidence.payload.value;
    const incomplete = evidence.completeness !== "complete";
    const outcome: ReconcileOutcome = incomplete
      ? "uncertain"
      : sameValue(current.claim.value, evidenceValue)
        ? "accepted"
        : "rejected";
    this.saveHistory(current);
    current.claim.status =
      outcome === "accepted" ? "current" : outcome === "rejected" ? "stale" : "uncertain";
    current.claim.last_verified_revision = evidence.revision;
    current.claim.provenance = {
      kind: "reconciled",
      author: `${evidence.kind}:${evidence.source}`,
      evidence_event_ids: [evidence.event_id],
    };
    // Trust is deliberately untouched: reconciliation cannot promote inference.
    return { ok: true, value: { outcome, record: clone(current) } };
  }

  ingestGroundTruth(input: GroundTruthInput): MaintenanceResult<ClaimRecord> {
    if (this.records.has(input.claim_id))
      return failure("invalid_transition", "claim already exists");
    const evidence = this.trustedEvidence.resolve(input.event_id);
    if (
      !evidence ||
      !sameScope(input.scope, evidence.scope) ||
      !sameOwnership(input.ownership, evidence.ownership)
    )
      return failure(
        "untrusted_evidence",
        "ground truth requires in-scope stored observation/action evidence",
      );
    if (evidence.completeness !== "complete")
      return failure("untrusted_evidence", "incomplete evidence cannot create ground truth");
    const claim: WikiClaim = {
      schema_version: "1.0",
      claim_id: input.claim_id,
      subject_id: input.subject_id,
      predicate: input.predicate,
      value: clone(evidence.payload.value),
      trust: "ground_truth",
      status: "current",
      evidence_event_ids: [evidence.event_id],
      evidence_revision: evidence.revision,
      last_verified_revision: evidence.revision,
      confidence: null,
      provenance: {
        kind: "observed",
        author: `${evidence.kind}:${evidence.source}`,
        evidence_event_ids: [evidence.event_id],
      },
      valid_from_revision: evidence.revision,
      valid_until_revision: null,
    };
    if (input.supersedes_claim_id) {
      const prior = this.records.get(input.supersedes_claim_id);
      if (!prior) return failure("unknown_claim", "claim to supersede does not exist");
      const guard = guardScope(prior, input.scope, input.ownership);
      if (guard) return guard;
      this.saveHistory(prior);
      prior.claim.status = "superseded";
    }
    const record = { claim, scope: clone(input.scope), ownership: clone(input.ownership) };
    this.records.set(input.claim_id, record);
    this.historyByClaim.set(input.claim_id, []);
    return { ok: true, value: clone(record) };
  }

  supersede(
    claimId: string,
    scope: WikiScope,
    ownership: OwnershipGuard,
  ): MaintenanceResult<ClaimRecord> {
    return this.transition(claimId, scope, ownership, "superseded");
  }

  invalidate(
    claimId: string,
    scope: WikiScope,
    ownership: OwnershipGuard,
  ): MaintenanceResult<ClaimRecord> {
    return this.transition(claimId, scope, ownership, "invalidated");
  }

  get(claimId: string): ClaimRecord | undefined {
    const record = this.records.get(claimId);
    return record ? clone(record) : undefined;
  }

  history(claimId: string): readonly ClaimRecord[] {
    return clone(this.historyByClaim.get(claimId) ?? []);
  }

  private transition(
    claimId: string,
    scope: WikiScope,
    ownership: OwnershipGuard,
    status: ClaimStatus,
  ): MaintenanceResult<ClaimRecord> {
    const current = this.records.get(claimId);
    if (!current) return failure("unknown_claim", "claim does not exist");
    const guard = guardScope(current, scope, ownership);
    if (guard) return guard;
    if (current.claim.status === "invalidated")
      return failure("invalid_transition", "invalidated claim cannot transition");
    current.claim.status = status;
    return { ok: true, value: clone(current) };
  }

  private saveHistory(record: ClaimRecord): void {
    this.historyByClaim.get(record.claim.claim_id)?.push(clone(record));
  }
}
