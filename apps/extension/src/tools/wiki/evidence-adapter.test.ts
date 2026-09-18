import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, ShadowEvidenceAdapter } from "./evidence-adapter";

describe("ShadowEvidenceAdapter", () => {
  it("redacts secrets and keeps existing event identity fields", () => {
    const adapter = new ShadowEvidenceAdapter({ id: () => "event-1" });
    const event = adapter.capture({
      page_instance_id: "page-1",
      kind: "observation",
      source: "vom",
      payload: { url: "https://example.test/private?q=secret", password: "pw", ref: "@e1" },
    });
    expect(event.event_id).toBe("event-1");
    expect(event.payload).toEqual({ url: "https://example.test", password: "[redacted]", ref: "@e1" });
    expect(event.revision).toBe(1);
  });

  it("marks oversized evidence for a full refresh instead of retaining page content", () => {
    const adapter = new ShadowEvidenceAdapter({ id: () => "event-1" });
    const event = adapter.capture({
      page_instance_id: "page-1",
      kind: "mutation",
      source: "dom",
      payload: { text: "x".repeat(MAX_EVENT_BYTES) },
    });
    expect(event.completeness).toBe("full_refresh_required");
    expect(event.payload).toEqual({ redacted: true, reason: "payload_limit" });
    expect(adapter.events("page-1")).toHaveLength(1);
  });
});
