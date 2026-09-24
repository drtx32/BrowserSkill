import type { RenderedRef } from "@browser-skill/vom";
import { canonicalPerception } from "./canonical-runtime";
import {
  canonicalSemanticAddress,
  resolveSemanticTarget,
  type SemanticAddress,
} from "./semantic-address";

const REFRESH_TRIGGERS = new Set([
  "nav_rollover",
  "binding_stale",
  "binding_ambiguous",
  "invalidation_meaningful",
  "full_refresh_required",
  "dynamic_region_unresolved",
]);

export interface CanonicalSnapshotField {
  target: string;
  target_id?: string;
  binding?: string;
  address?: string;
  ambiguous?: boolean;
}

/** Read-only form projection. It never mints identity or mutates Page-Wiki. */
export function readCanonicalSnapshot(input: {
  browserId: string;
  sessionId: string;
  tabId: number;
  origin: string;
  documentId?: string;
  revision: number;
  trigger?: string;
  fromRevision?: number;
  refs: readonly RenderedRef[];
}): { revision: string; fields: CanonicalSnapshotField[] } | undefined {
  if (!input.documentId) return undefined;
  const scope = {
    browser_id: input.browserId,
    session_id: input.sessionId,
    tab_id: input.tabId,
    document_id: input.documentId,
    origin: input.origin,
  };
  let targets = canonicalPerception.currentTargets(scope);
  const resolved = input.refs.flatMap((ref) => {
    if (!ref.role && !ref.name) return [];
    const address: SemanticAddress = {
      origin: input.origin,
      document: input.documentId!,
      ...(ref.ctx ? { parentRegion: ref.ctx } : {}),
      ...(ref.role ? { role: ref.role } : {}),
      ...(ref.name ? { name: ref.name } : {}),
      ...(ref.identity?.path ? { structuralRelation: ref.identity.path } : {}),
    };
    return { ref, address, result: resolveSemanticTarget({ address }, targets) };
  });
  // Re-perception is the only write path here, and it can update bindings only
  // for already-authoritative target ids. Unknown/ambiguous targets abort the
  // whole refresh before Page-Wiki is touched.
  if (
    input.trigger &&
    REFRESH_TRIGGERS.has(input.trigger) &&
    resolved.every((item) => item.result.target)
  ) {
    const receipt = canonicalPerception.materializeRecordingObservation(
      scope,
      { ownership_id: `recording:${input.sessionId}` },
      resolved.map((item) => ({
        target_id: item.result.target!.target_id,
        address: item.address,
        stable_ref: `@${item.ref.ref.replace(/^@/, "")}`,
        region_id: item.ref.ctx ?? null,
      })),
      Math.max(0, input.fromRevision ?? input.revision - 1),
    );
    if (receipt.outcome !== "unresolved") targets = canonicalPerception.currentTargets(scope);
  }
  return {
    revision: String(input.revision),
    fields: input.refs.flatMap((ref) => {
      if (!ref.role && !ref.name) return [];
      const address: SemanticAddress = {
        origin: input.origin,
        document: input.documentId!,
        ...(ref.ctx ? { parentRegion: ref.ctx } : {}),
        ...(ref.role ? { role: ref.role } : {}),
        ...(ref.name ? { name: ref.name } : {}),
        ...(ref.identity?.path ? { structuralRelation: ref.identity.path } : {}),
      };
      const resolved = resolveSemanticTarget({ address }, targets);
      const binding = `@${ref.ref.replace(/^@/, "")}`;
      return [
        resolved.target
          ? {
              target: binding,
              target_id: resolved.target.target_id,
              binding,
              address: canonicalSemanticAddress(resolved.target.address),
            }
          : { target: binding, ...(resolved.reason === "ambiguous" ? { ambiguous: true } : {}) },
      ];
    }),
  };
}
