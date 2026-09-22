import { describe, expect, it, vi } from "vitest";
import { createDisconnectCleanup } from "../disconnect-cleanup";
import { SessionManager } from "../manager";

describe("disconnect session cleanup", () => {
  it("preserves every local session and Agent Window on transport loss", async () => {
    const remove = vi.fn(async () => {});
    let nextWindowId = 100;
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: nextWindowId++, initialTabIds: [] })),
        ensureActiveTab: vi.fn(async () => 1),
        remove,
      },
    });
    await manager.start("aa11");
    await manager.start("bb22");
    const onSessionsChanged = vi.fn();
    const cleanup = createDisconnectCleanup({
      manager,
      onSessionsChanged,
    });

    const report = await cleanup();

    expect(report).toEqual({ preservedSessionIds: ["aa11", "bb22"], failures: [] });
    expect(manager.list().map((ctx) => ctx.sessionId)).toEqual(["aa11", "bb22"]);
    expect(remove).not.toHaveBeenCalled();
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping disconnect notifications", async () => {
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
        ensureActiveTab: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
      },
    });
    await manager.start("aa11");
    const cleanup = createDisconnectCleanup({ manager });

    const first = cleanup();
    const second = cleanup();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ preservedSessionIds: ["aa11"], failures: [] });
  });
});
