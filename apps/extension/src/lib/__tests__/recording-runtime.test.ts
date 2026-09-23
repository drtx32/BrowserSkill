import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";

const captureRecordingObservation = vi.hoisted(() => vi.fn());
const waitForDocumentSettled = vi.hoisted(() => vi.fn(async () => "quiet" as const));

vi.mock("../recording/observation-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/observation-capture")>();
  return { ...actual, captureRecordingObservation };
});

vi.mock("../recording/document-settle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/document-settle")>();
  return { ...actual, waitForDocumentSettled };
});

import type { WikiScope } from "@/tools/wiki/guarded-maintenance";
import {
  defaultCanonicalRecordingTargetProvider,
  recordingCanonicalPerception,
} from "../recording/default-canonical-perception";
import { ObservationNodeIndex } from "../recording/observation-capture";
import { RecordingObservationSession } from "../recording/observation-session";
import { RecordingObservationRuntime } from "../recording/recording-runtime";
import type { RecordingDraftStep } from "../recording/types";

function observation(url = "https://example.com/") {
  return {
    rootFrameId: "root",
    index: new ObservationNodeIndex({ rootFrameId: "root", matchNodes: [], refs: [] }),
    url,
    title: "Example",
    vomText: '@vom 1\nRootWebArea "Example"',
    truncated: false,
  };
}

function runtime(): RecordingObservationRuntime {
  return new RecordingObservationRuntime({
    cdp: { send: vi.fn() as unknown as CdpRunner["send"] },
    tabsApi: { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi,
  });
}

describe("RecordingObservationRuntime", () => {
  afterEach(() => {
    captureRecordingObservation.mockReset();
    waitForDocumentSettled.mockClear();
  });

  it("shares one initial capture and includes it in flush", async () => {
    let release!: (value: ReturnType<typeof observation>) => void;
    captureRecordingObservation.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const recording = runtime();

    const first = recording.captureInitial(7);
    const second = recording.captureInitial(7);
    const flushed = recording.flush();
    let flushCompleted = false;
    void flushed.then(() => {
      flushCompleted = true;
    });

    await Promise.resolve();
    expect(captureRecordingObservation).toHaveBeenCalledTimes(1);
    expect(flushCompleted).toBe(false);

    release(observation());
    await Promise.all([first, second, flushed]);
    expect(flushCompleted).toBe(true);
  });

  it("records canonical targets through the real capture session", async () => {
    captureRecordingObservation.mockResolvedValueOnce(observation("https://example.com/wiki"));
    const cdp = { send: vi.fn() as unknown as CdpRunner["send"] };
    const tabsApi = { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi;
    const session = new RecordingObservationSession({
      semanticTargetProvider: (captured) => ({
        targets: [
          {
            target_id: "wiki:save",
            address: {
              origin: "https://example.com",
              document: captured.documentId ?? "doc-1",
              role: "button",
              name: "Save",
            },
          },
        ],
        bindings: [{ target_id: "wiki:save", stable_ref: "@e9", revision: 7, live: true }],
      }),
    });

    const captured = await session.capture(cdp, tabsApi, 7);
    expect(captured.semanticTargets?.[0]?.target_id).toBe("wiki:save");
    expect(captured.semanticBindings?.[0]).toMatchObject({
      target_id: "wiki:save",
      stable_ref: "@e9",
    });
  });

  it("uses the shared default canonical projection across live-ref renumbering", async () => {
    const scope: WikiScope = {
      browser_id: "browser-extension",
      session_id: "recording",
      tab_id: 7,
      document_id: "doc-1",
      origin: "https://example.com",
    };
    recordingCanonicalPerception.applyFullObservation(scope, { ownership_id: "recording-test" }, [
      {
        target_id: "wiki:save",
        stable_ref: "@e9",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "button",
          name: "Save",
        },
      },
    ]);
    captureRecordingObservation
      .mockResolvedValueOnce({ ...observation("https://example.com/wiki"), documentId: "doc-1" })
      .mockResolvedValueOnce({ ...observation("https://example.com/wiki"), documentId: "doc-1" });
    const session = new RecordingObservationSession({
      semanticTargetProvider: defaultCanonicalRecordingTargetProvider,
      recordingScope: scope,
    });
    const first = await session.capture(
      { send: vi.fn() as unknown as CdpRunner["send"] },
      { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi,
      7,
    );
    const second = await session.capture(
      { send: vi.fn() as unknown as CdpRunner["send"] },
      { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi,
      7,
    );
    expect(first.semanticTargets?.[0]?.target_id).toBe("wiki:save");
    expect(second.semanticTargets?.[0]?.target_id).toBe("wiki:save");
    expect(second.semanticBindings?.[0]?.stable_ref).toBe("@e9");
  });

  it("cancels an in-flight initial capture", async () => {
    captureRecordingObservation.mockImplementationOnce(
      (input: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("observation aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const recording = runtime();

    const pending = recording.captureInitial(7);
    recording.cancel();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a failed initial capture when the recording settles at stop", async () => {
    captureRecordingObservation
      .mockRejectedValueOnce(new Error("document swapped"))
      .mockResolvedValueOnce(observation());
    const recording = runtime();

    await expect(recording.captureInitial(7)).rejects.toThrow("document swapped");
    await recording.settleTrailing(7, []);
    const trace = recording.buildTrace({
      drafts: [],
      startedAt: "2026-08-19T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "0.1.6",
    });

    expect(captureRecordingObservation).toHaveBeenCalledTimes(2);
    expect(trace.states).toHaveLength(1);
  });

  it("keeps runtime matching data out of the serialized trace", async () => {
    const captured = observation();
    captured.index = new ObservationNodeIndex({
      rootFrameId: "root",
      matchNodes: [
        {
          frameId: "root",
          backendNodeId: 42,
          tag: "button",
          rect: { x: 10, y: 20, w: 100, h: 30 },
          localRect: { x: 10, y: 20, w: 100, h: 30 },
        },
      ],
      refs: [{ ref: "e1", backendNodeId: 42, role: "button", name: "Submit", line: 1 }],
    });
    captureRecordingObservation.mockResolvedValueOnce(captured);
    const recording = runtime();

    await recording.captureInitial(7);
    const dumped = JSON.stringify(
      recording.buildTrace({
        drafts: [],
        startedAt: "2026-08-19T00:00:00.000Z",
        stoppedBy: "user_finish",
        bskVersion: "0.1.6",
      }),
    );

    expect(dumped).toContain("RootWebArea");
    expect(dumped).not.toContain("matchNodes");
    expect(dumped).not.toContain("localRect");
    expect(dumped).not.toContain("backendNodeId");
    expect(dumped).not.toContain("ObservationNodeIndex");
  });

  it("captures a tab transition without sharing observation cursors", async () => {
    captureRecordingObservation
      .mockResolvedValueOnce(observation("https://example.com/first"))
      .mockResolvedValueOnce(observation("https://example.com/second"));
    const recording = runtime();

    await recording.captureInitial(4);
    const transition = await recording.captureTabTransition(4, 5);
    await recording.captureInitial(4);
    await recording.captureInitial(5);

    expect(transition).toEqual({
      preStateId: "s1",
      postStateId: "s2",
      targetUrl: "https://example.com/second",
    });
    expect(captureRecordingObservation.mock.calls.map(([input]) => input.tabId)).toEqual([4, 5]);
  });

  it("binds an iframe draft to its marked CDP Document scope", async () => {
    captureRecordingObservation.mockResolvedValueOnce({
      ...observation(),
      index: new ObservationNodeIndex({
        rootFrameId: "root",
        frames: [
          {
            frameId: "child",
            target: { tabId: 7, sessionId: "oopif-session" },
            recordingDocumentId: "producer-1",
          },
        ],
        matchNodes: [
          {
            backendNodeId: 42,
            frameId: "child",
            tag: "button",
            rect: { x: 410, y: 20, w: 100, h: 30 },
            localRect: { x: 10, y: 20, w: 100, h: 30 },
          },
        ],
        refs: [{ ref: "e1", backendNodeId: 42, frameId: "child", line: 1 }],
      }),
    });
    const recording = runtime();
    const drafts: RecordingDraftStep[] = [
      {
        op: "click" as const,
        captureTarget: { tag: "button", role: "button", name: "Save" },
        targetHint: {
          geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" },
        },
      },
    ];

    await recording.captureInitial(7);
    await recording.processDraft(7, drafts, 0, "producer-1");
    recording.cancel();

    const draft = drafts[0];
    expect(draft?.op).toBe("click");
    if (!draft || draft.op !== "click") throw new Error("expected click draft");
    expect(draft.targetHint).toMatchObject({
      frameId: "child",
      geometrySpace: "local",
    });
    expect(draft.matchedTarget?.ref).toBe("e1");
  });

  it("refreshes a late iframe before matching its first action", async () => {
    const iframeObservation = {
      ...observation(),
      index: new ObservationNodeIndex({
        rootFrameId: "root",
        frames: [
          {
            frameId: "child",
            target: { tabId: 7, sessionId: "oopif-session" },
            recordingDocumentId: "producer-1",
          },
        ],
        matchNodes: [
          {
            backendNodeId: 42,
            frameId: "child",
            tag: "button",
            rect: { x: 410, y: 20, w: 100, h: 30 },
            localRect: { x: 10, y: 20, w: 100, h: 30 },
          },
        ],
        refs: [
          {
            ref: "e1",
            backendNodeId: 42,
            frameId: "child",
            role: "button",
            name: "表格视图",
            line: 1,
          },
        ],
      }),
    };
    captureRecordingObservation
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(iframeObservation)
      .mockResolvedValueOnce(iframeObservation);
    const recording = runtime();

    await recording.captureInitial(7);
    await recording.refreshDocument(7, "producer-1");
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "表格视图" },
        targetHint: {
          geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" },
        },
      },
    ];
    await recording.processDraft(7, drafts, 0, "producer-1");
    recording.cancel();

    expect(captureRecordingObservation).toHaveBeenCalledTimes(3);
    expect(waitForDocumentSettled).toHaveBeenCalledWith(
      expect.anything(),
      { frameId: "child", target: { tabId: 7, sessionId: "oopif-session" } },
      { signal: expect.any(AbortSignal) },
    );
    const draft = drafts[0];
    expect(draft?.op).toBe("click");
    if (!draft || draft.op !== "click") throw new Error("expected click draft");
    expect(draft.matchedTarget).toMatchObject({ ref: "e1", name: "表格视图" });
  });

  it("does not poison final flush when a frame readiness refresh fails", async () => {
    captureRecordingObservation
      .mockResolvedValueOnce(observation())
      .mockRejectedValueOnce(new Error("child Document replaced"));
    const recording = runtime();

    await recording.captureInitial(7);
    await expect(recording.refreshDocument(7, "producer-1")).rejects.toThrow(
      "child Document replaced",
    );
    await expect(recording.flush()).resolves.toBeUndefined();
  });
});
