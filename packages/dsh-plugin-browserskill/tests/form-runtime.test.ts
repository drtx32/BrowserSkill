import { describe, expect, it, vi } from "vitest";
import { runFormRuntime } from "../src/form-runtime";

const field = (target: string) => ({ action: "fill" as const, target, value: target });

describe("batch form runtime", () => {
  it("materializes once and never observes per field", async () => {
    const materialize = vi.fn(async () => ({ revision: 4 }));
    const mutate = vi.fn(async (input: { value?: string }) => ({
      tabId: 7,
      trigger: undefined,
      valueLength: input.value?.length ?? 0,
    }));
    const rePerceive = vi.fn();
    const result = await runFormRuntime([field("@e1"), field("@e2")], {
      materialize,
      mutate,
      rePerceive,
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(rePerceive).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      succeeded: ["@e1", "@e2"],
      skipped: [],
      ambiguous: [],
      revision: 4,
    });
  });

  it("re-perceives only for the frozen trigger set", async () => {
    const materialize = vi.fn(async () => ({ revision: 1 }));
    const rePerceive = vi.fn(async () => ({ revision: 2, fields: [{ target: "@e3" }] }));
    const result = await runFormRuntime([field("@e1")], {
      materialize,
      mutate: async () => ({ tabId: 7, trigger: "binding_stale", revision: 2 }),
      rePerceive,
    });
    expect(rePerceive).toHaveBeenCalledWith("binding_stale", 2);
    expect(result.receipt).toMatchObject({
      trigger: "binding_stale",
      new_required_fields: ["@e3"],
    });
  });

  it("fails closed during atomic preflight for protected or ambiguous targets", async () => {
    const mutate = vi.fn();
    const result = await runFormRuntime([field("@secret"), field("@maybe")], {
      materialize: async () => ({
        fields: [
          { target: "@secret", protected: true },
          { target: "@maybe", ambiguous: true },
        ],
      }),
      mutate,
      rePerceive: vi.fn(),
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(result.receipt.ambiguous).toEqual(["@secret", "@maybe"]);
    expect(result.receipt.fallback_reason).toBe("fail_closed_protected_or_ambiguous");
  });
});
