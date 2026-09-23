import type { RenderedRef } from "@browser-skill/vom";
import {
  resolveSemanticTarget,
  type SemanticAddress,
  type SemanticQuery,
  type SemanticTarget,
} from "@/tools/wiki/semantic-address";
import type { CaptureTargetDescriptor } from "../describe-target";
import type { RegisteredObservation } from "./observation-capture";

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Build the canonical contract query without treating a live ref as identity. */
export function semanticQueryForRef(
  observation: RegisteredObservation,
  ref: RenderedRef,
  fallback?: CaptureTargetDescriptor,
): SemanticQuery | undefined {
  const origin = originOf(observation.url);
  const document = observation.documentId ?? observation.rootFrameId;
  if (!origin || !document) return undefined;
  const address: SemanticAddress = {
    origin,
    document,
    ...(ref.ctx || fallback?.nearby_label
      ? { parentRegion: ref.ctx ?? fallback?.nearby_label }
      : {}),
    ...((ref.role ?? fallback?.role) ? { role: ref.role ?? fallback?.role } : {}),
    ...((ref.name ?? fallback?.name) ? { name: ref.name ?? fallback?.name } : {}),
    ...(ref.identity?.path ? { structuralRelation: ref.identity.path } : {}),
  };
  return {
    address,
    ...(fallback?.name ? { alias: fallback.name } : {}),
  };
}

export function resolveRecordedSemanticTarget(
  observation: RegisteredObservation,
  ref: RenderedRef,
  fallback: CaptureTargetDescriptor | undefined,
  targets: readonly SemanticTarget[] = observation.semanticTargets ?? [],
): { query?: SemanticQuery; target?: SemanticTarget; reason?: string } {
  const query = semanticQueryForRef(observation, ref, fallback);
  if (!query) return { reason: "document-origin-unavailable" };
  if (!targets.length) return { query };
  const resolved = resolveSemanticTarget(query, targets);
  return resolved.target
    ? { query, target: resolved.target, reason: resolved.tier }
    : { query, reason: resolved.reason };
}
