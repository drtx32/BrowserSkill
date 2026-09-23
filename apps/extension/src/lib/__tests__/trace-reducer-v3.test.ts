import { describe, expect, it } from "vitest";
import { TRACE_VERSION_V3, VOM_FORMAT_VERSION } from "@/transport/types";
import { RecordingStateRegistry } from "../recording/state-registry";
import { buildTraceV3 } from "../recording/trace-builder-v3";
import { reduceTraceStepsV3 } from "../recording/trace-reducer-v3";
import type { RecordingDraftStep } from "../recording/types";

describe("trace reducer v3", () => {
  it("removes form literals when value redaction is requested", () => {
    const reduced = reduceTraceStepsV3(
      [
        {
          op: "fill",
          value: "private@example.com",
          preStateId: "s1",
          postStateId: "s1",
        },
        {
          op: "select",
          values: ["private-account-id"],
          labels: ["Private account"],
          preStateId: "s1",
          postStateId: "s1",
        },
      ],
      { redactValues: true },
    );

    expect(reduced.steps[0]).toMatchObject({ op: "fill", value: "***", redacted: true });
    expect(reduced.steps[1]).toMatchObject({ op: "select" });
    expect(reduced.steps[1]).not.toHaveProperty("selection");
    expect(JSON.stringify(reduced.steps)).not.toContain("private@example.com");
    expect(JSON.stringify(reduced.steps)).not.toContain("private-account-id");
  });

  it("emits tab transitions only for callers that advertised support", () => {
    const drafts: RecordingDraftStep[] = [
      {
        op: "switch_tab",
        preStateId: "s1",
        postStateId: "s2",
      },
    ];

    expect(reduceTraceStepsV3(drafts).steps).toEqual([]);
    expect(reduceTraceStepsV3(drafts, { includeTabSwitches: true }).steps).toEqual([
      { op: "switch_tab", id: 1, state: "s1", result: { state: "s2" } },
    ]);
  });

  it("keeps hover steps before menu clicks", () => {
    const drafts: RecordingDraftStep[] = [
      {
        op: "hover",
        captureTarget: { tag: "span", role: "button", name: "Account" },
        preStateId: "s1",
        postStateId: "s1",
      },
      {
        op: "click",
        captureTarget: { tag: "a", role: "link", name: "Profile" },
        preStateId: "s1",
        postStateId: "s1",
      },
    ];

    expect(reduceTraceStepsV3(drafts).steps.map((s) => s.op)).toEqual(["hover", "click"]);
  });

  it("does not export a tab transition without both observation endpoints", () => {
    const sourceOnly: RecordingDraftStep = { op: "switch_tab", preStateId: "s1" };
    const targetOnly: RecordingDraftStep = { op: "switch_tab", postStateId: "s2" };

    expect(
      reduceTraceStepsV3([sourceOnly, targetOnly], { includeTabSwitches: true }).steps,
    ).toEqual([]);
  });

  it("collapses redirect hops while retaining draft-to-step identity", () => {
    const drafts: RecordingDraftStep[] = [
      { op: "navigate", url: "https://example.com/start", preStateId: "s1", postStateId: "s2" },
      {
        op: "navigate",
        url: "https://example.com/final",
        transitionQualifiers: ["server_redirect"],
        preStateId: "s2",
        postStateId: "s3",
      },
    ];
    const before = structuredClone(drafts);
    const reduced = reduceTraceStepsV3(drafts);

    expect(drafts).toEqual(before);
    expect(reduced.steps).toEqual([
      expect.objectContaining({
        id: 1,
        op: "navigate",
        state: "s1",
        to: "https://example.com/final",
        result: { state: "s3" },
      }),
    ]);
    expect(reduced.stepIdByDraftId.get(1)).toBe(1);
    expect(reduced.stepIdByDraftId.get(2)).toBe(1);
  });

  it("builds the wire model from protocol constants", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({ url: "https://example.com", vomText: "@vom 1" });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "click",
          captureTarget: { tag: "button", role: "button", name: "Save" },
          preStateId: state.id,
          postStateId: state.id,
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.version).toBe(TRACE_VERSION_V3);
    expect(trace.recorder.vom).toBe(VOM_FORMAT_VERSION);
    expect(trace.steps[0]).toMatchObject({
      op: "click",
      target: { role: "button", name: "Save", unmatched: true },
    });
  });

  it("exports same-document updates as base-plus-delta state with observe metrics", () => {
    const registry = new RecordingStateRegistry();
    const first = registry.register({
      url: "https://example.com",
      documentId: "doc-1",
      vomText: "button Save",
    });
    const second = registry.register({
      url: "https://example.com#saved",
      documentId: "doc-1",
      vomText: "button Save\nstatus Saved",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "click",
          captureTarget: { tag: "button", name: "Save" },
          preStateId: first.id,
          postStateId: second.id,
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.states).toHaveLength(2);
    expect(trace.states[1]).toMatchObject({
      document_id: "doc-1",
      revision: 2,
      base_state: "s1",
      delta: { added: ["status Saved"], removed: [] },
    });
    expect(trace.states[1]?.body).toContain("@delta base=s1");
    expect(trace.metrics).toMatchObject({
      full_state_count: 1,
      delta_state_count: 1,
      full_observe_equivalents: 1,
    });
  });
});
