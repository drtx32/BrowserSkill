import type { SessionManager } from "./manager";

export interface DisconnectCleanupFailure {
  sessionId: string;
  message: string;
}

export interface DisconnectCleanupReport {
  preservedSessionIds: string[];
  failures: DisconnectCleanupFailure[];
}

export interface DisconnectCleanupOptions {
  manager: SessionManager;
  onSessionsChanged?: () => void;
}

/**
 * Build a coalesced cleanup operation for transport loss.
 *
 * Transport loss is a controller/lease event, not a user stop. Preserve the
 * local sessions and their Agent Windows so reconnect can rebind them.
 */
export function createDisconnectCleanup(options: DisconnectCleanupOptions) {
  let inFlight: Promise<DisconnectCleanupReport> | null = null;

  return (): Promise<DisconnectCleanupReport> => {
    if (inFlight) return inFlight;
    inFlight = cleanupSessions(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

async function cleanupSessions(
  options: DisconnectCleanupOptions,
): Promise<DisconnectCleanupReport> {
  const preservedSessionIds = options.manager.list().map((ctx) => ctx.sessionId);

  options.onSessionsChanged?.();
  return { preservedSessionIds, failures: [] };
}
