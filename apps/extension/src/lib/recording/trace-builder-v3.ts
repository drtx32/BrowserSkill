import {
  type StepV3,
  type StopReason,
  TRACE_VERSION_V3,
  type TraceStateV3,
  type TraceV3,
  VOM_FORMAT_VERSION,
} from "@/transport/types";
import { resolveDraftStartUrl } from "./draft-policy";
import type { RecordedStateEntry, RecordingStateRegistry } from "./state-registry";
import { reduceTraceStepsV3 } from "./trace-reducer-v3";
import { formatTraceStateBody } from "./trace-state-body";
import type { RecordingDraftStep, StepAnnotation } from "./types";

function publishedEntries(registry: RecordingStateRegistry, steps: StepV3[]): RecordedStateEntry[] {
  const entries = registry.values();
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set(steps.flatMap((step) => [step.state, step.result.state]));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (!referenced.has(entry.id)) continue;
    let base = entry.baseStateId;
    while (base && !referenced.has(base)) {
      referenced.add(base);
      base = byId.get(base)?.baseStateId;
    }
  }
  return entries.filter((entry) => referenced.has(entry.id));
}

function remapDraftIds(draftIds: number[], stepIdByDraftId: Map<number, number>): number[] {
  return [
    ...new Set(
      draftIds.flatMap((id) => {
        const stepId = stepIdByDraftId.get(id);
        return stepId === undefined ? [] : [stepId];
      }),
    ),
  ].sort((a, b) => a - b);
}

export function buildTraceV3(input: {
  registry: RecordingStateRegistry;
  drafts: RecordingDraftStep[];
  annotations?: StepAnnotation[];
  startedAt: string;
  purpose?: string;
  startUrl?: string;
  stoppedBy: StopReason;
  bskVersion: string;
  redactValues?: boolean;
  includeTabSwitches?: boolean;
}): TraceV3 {
  const reduced = reduceTraceStepsV3(input.drafts, {
    includeTabSwitches: input.includeTabSwitches,
    redactValues: input.redactValues,
  });
  const entries = publishedEntries(input.registry, reduced.steps);
  const publishedId = new Map(entries.map((entry, index) => [entry.id, `s${index + 1}`]));
  const annotationsByState = new Map<string, StepAnnotation[]>();
  for (const annotation of input.annotations ?? []) {
    const bucket = annotationsByState.get(annotation.stateId) ?? [];
    bucket.push(annotation);
    annotationsByState.set(annotation.stateId, bucket);
  }
  const steps = reduced.steps.map((step) => ({
    ...step,
    state: publishedId.get(step.state) ?? step.state,
    result: { state: publishedId.get(step.result.state) ?? step.result.state },
  }));
  const states: TraceStateV3[] = entries.map((entry) => {
    const id = publishedId.get(entry.id) ?? entry.id;
    const baseState = entry.baseStateId
      ? (publishedId.get(entry.baseStateId) ?? entry.baseStateId)
      : undefined;
    const deltaBody = entry.delta
      ? [
          `@delta base=${baseState ?? "unknown"}`,
          ...entry.delta.added.map((line) => `+ ${line}`),
          ...entry.delta.removed.map((line) => `- ${line}`),
        ].join("\n")
      : undefined;
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body:
        deltaBody ??
        formatTraceStateBody({
          stateId: id,
          url: entry.url,
          title: entry.title,
          stepIds: remapDraftIds(entry.stepsHere, reduced.stepIdByDraftId),
          vomText: entry.vomText,
          annotations: annotationsByState.get(entry.id) ?? [],
          stepIdByDraftId: reduced.stepIdByDraftId,
        }),
      ...(entry.truncated ? { truncated: true } : {}),
      ...(entry.documentId ? { document_id: entry.documentId } : {}),
      revision: entry.revision,
      ...(baseState ? { base_state: baseState } : {}),
      ...(entry.delta ? { delta: entry.delta } : {}),
    };
  });

  return {
    version: TRACE_VERSION_V3,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    stopped_by: input.stoppedBy,
    entry: { start_url: resolveDraftStartUrl(input.drafts, input.startUrl, states[0]?.url) },
    recorder: { bsk: input.bskVersion, vom: VOM_FORMAT_VERSION },
    metrics: {
      state_count: states.length,
      full_state_count: states.filter((state) => !state.delta).length,
      delta_state_count: states.filter((state) => state.delta !== undefined).length,
      full_observe_equivalents: states.filter((state) => !state.delta).length,
    },
    states,
    steps,
  };
}
