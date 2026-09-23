import type { RenderedRef } from "@browser-skill/vom";
import type { TargetDescriptorV3 } from "@/transport/types";
import type { CaptureTargetDescriptor } from "../describe-target";
import type { IndexedObservationNode, RegisteredObservation } from "./observation-capture";
import { resolveRecordedSemanticTarget } from "./semantic-target";
import type { TargetGeometry, TargetMatchHint } from "./types";

const MATCH_TOLERANCE_PX = 2;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= MATCH_TOLERANCE_PX;
}

function rectMatches(a: TargetGeometry["rect"], b: TargetGeometry["rect"]): boolean {
  return close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h);
}

function candidateMatches(
  candidate: IndexedObservationNode,
  geometry: TargetGeometry,
  geometrySpace: "top" | "local",
): boolean {
  const rect = geometrySpace === "local" ? candidate.geometry.localRect : candidate.geometry.rect;
  return rect != null && rectMatches(geometry.rect, rect);
}

export function unmatchedTarget(
  fallback?: CaptureTargetDescriptor,
  reason: TargetDescriptorV3["unmatched_reason"] = "no_unique_match",
): TargetDescriptorV3 {
  return {
    ...(fallback?.role ? { role: fallback.role } : {}),
    ...(fallback?.name ? { name: fallback.name } : {}),
    unmatched: true,
    unmatched_reason: reason,
  };
}

function normalized(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function matchesSemantics(ref: RenderedRef, fallback?: CaptureTargetDescriptor): boolean {
  const role = normalized(fallback?.role);
  const name = normalized(fallback?.name);
  if (!role && !name) return false;
  if (role && normalized(ref.role) !== role) return false;
  if (name && normalized(ref.name) !== name) return false;
  return true;
}

function descriptor(
  observation: RegisteredObservation,
  ref: RenderedRef,
  fallback?: CaptureTargetDescriptor,
): TargetDescriptorV3 {
  const semantic = resolveRecordedSemanticTarget(observation, ref, fallback);
  const currentBinding = semantic.target
    ? observation.semanticBindings?.find(
        (binding) => binding.target_id === semantic.target?.target_id,
      )
    : undefined;
  return {
    ref: ref.ref,
    ...(ref.role ? { role: ref.role } : {}),
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.ctx ? { ctx: ref.ctx } : {}),
    ...(semantic.query
      ? { semantic_query: semantic.query, semantic_address: semantic.query.address }
      : {}),
    ...(semantic.target
      ? {
          semantic: semantic.target,
          ...(currentBinding?.live
            ? {
                binding: {
                  ...(currentBinding.stable_ref ? { stable_ref: currentBinding.stable_ref } : {}),
                  revision: currentBinding.revision,
                },
              }
            : {}),
        }
      : {}),
  };
}

export function matchObservationTarget(input: {
  observation: RegisteredObservation;
  hint?: TargetMatchHint;
  fallback?: CaptureTargetDescriptor;
}): TargetDescriptorV3 {
  if (input.hint?.frameId === null) return unmatchedTarget(input.fallback, "document_unavailable");
  const frameId = input.hint?.frameId ?? input.observation.rootFrameId;
  const geometry = input.hint?.geometry;
  if (geometry) {
    const matches = input.observation.index
      .candidates(frameId, geometry.tag)
      .filter(
        (candidate) =>
          candidate.ref &&
          candidateMatches(candidate, geometry, input.hint?.geometrySpace ?? "top"),
      );
    if (matches.length === 1)
      return descriptor(input.observation, matches[0]!.ref!, input.fallback);
    const semanticMatches = matches.filter(
      (candidate) => candidate.ref && matchesSemantics(candidate.ref, input.fallback),
    );
    if (semanticMatches.length === 1)
      return descriptor(input.observation, semanticMatches[0]!.ref!, input.fallback);
    return unmatchedTarget(input.fallback);
  }

  const semanticMatches = input.observation.index
    .refs(frameId)
    .filter((ref) => matchesSemantics(ref, input.fallback));
  return semanticMatches.length === 1
    ? descriptor(input.observation, semanticMatches[0]!, input.fallback)
    : unmatchedTarget(input.fallback);
}
