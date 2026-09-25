import type { RenderedRef } from "@browser-skill/vom";
import { canonicalPerception } from "./canonical-runtime";
import { canonicalSemanticAddress, resolveSemanticTarget, type SemanticAddress } from "./semantic-address";

const REFRESH_TRIGGERS = new Set([
  "nav_rollover", "binding_stale", "binding_ambiguous", "invalidation_meaningful",
  "full_refresh_required", "dynamic_region_unresolved",
]);

export interface CanonicalSnapshotField {
  target: string;
  target_id?: string;
  binding?: string;
  address?: string;
  ambiguous?: boolean;
  revision?: string;
}

/** Project the already-authoritative canonical index; reads never mint identity. */
export function readCanonicalSnapshot(input: {
  browserId: string; sessionId: string; tabId: number; origin: string;
  documentId?: string; revision: number; trigger?: string; fromRevision?: number;
  refs: readonly RenderedRef[];
}): { revision: string; fields: CanonicalSnapshotField[] } | undefined {
  if (!input.documentId) return undefined;
  const scope = {
    browser_id: input.browserId, session_id: input.sessionId, tab_id: input.tabId,
    document_id: input.documentId, origin: input.origin,
  };
  let targets = canonicalPerception.currentTargets(scope);
  const addressFor = (ref: RenderedRef): SemanticAddress | undefined => {
    if (!ref.role && !ref.name) return undefined;
    return {
      origin: input.origin, document: input.documentId!,
      ...(ref.ctx ? { parentRegion: ref.ctx } : {}), ...(ref.role ? { role: ref.role } : {}),
      ...(ref.name ? { name: ref.name } : {}),
      ...(ref.identity?.path ? { structuralRelation: ref.identity.path } : {}),
    };
  };
  const resolved = input.refs.flatMap((ref) => {
    const address = addressFor(ref);
    return address ? [{ ref, address, result: resolveSemanticTarget({ address }, targets) }] : [];
  });
  if (input.trigger && REFRESH_TRIGGERS.has(input.trigger) && resolved.every((item) => item.result.target)) {
    const receipt = canonicalPerception.materializeRecordingObservation(
      scope, { ownership_id: `recording:${input.sessionId}` },
      resolved.map((item) => ({
        target_id: item.result.target!.target_id, address: item.address,
        stable_ref: `@${item.ref.ref.replace(/^@/, "")}`, region_id: item.ref.ctx ?? null,
      })), Math.max(0, input.fromRevision ?? input.revision - 1),
    );
    if (receipt.outcome !== "unresolved") targets = canonicalPerception.currentTargets(scope);
  }
  const revision = String(input.revision);
  const fields = input.refs.flatMap((ref) => {
    const address = addressFor(ref);
    if (!address) return [];
    const result = resolveSemanticTarget({ address }, targets);
    const binding = `@${ref.ref.replace(/^@/, "")}`;
    return [result.target
      ? { target: binding, target_id: result.target.target_id, binding,
          address: canonicalSemanticAddress(result.target.address), revision }
      : { target: binding, ...(result.reason === "ambiguous" ? { ambiguous: true } : {}), revision }];
  });
  return { revision, fields };
}
