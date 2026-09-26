import type { ToolDefinition, ToolResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ToolDeps } from "./tools";

export type ToolRegistrar = (definition: ToolDefinition) => void;

type TerminalPresentation = { card: "terminal"; output: string; exitCode: number } | undefined;

/** Existing tool runtime seams reused by the phase-one capability modules. */
export interface PhaseOneRuntime {
  run(
    exec: ToolRunContext,
    args: string[],
    label: string,
    observeSession?: string,
    runnerTimeoutMs?: number,
  ): Promise<unknown>;
  commandLine(args: string[]): string;
  presentTerminalResult: (_args: never, result: ToolResult) => TerminalPresentation;
}

export function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}

export function requirePositive(value: number | undefined, name: string): void {
  if (value !== undefined && value <= 0) throw new Error(`${name} must be greater than zero`);
}

/** CLI positional target detection is shared by hover/select/request-help. */
export function isSnapshotRef(target: string): boolean {
  return /^@?e\d+$/.test(target);
}

/**
 * Give the child enough time to honour a command-level timeout plus IPC
 * settlement slack, without shortening the plugin's configured default.
 */
export function runnerTimeout(deps: ToolDeps, commandTimeoutMs: number | undefined): number {
  if (commandTimeoutMs === undefined) return deps.config.defaultTimeoutMs;
  return Math.max(deps.config.defaultTimeoutMs, commandTimeoutMs + 15_000);
}

export function appendTarget(args: string[], target: string): void {
  args.push(target);
}

export const CANONICAL_TARGET_PARAMS = {
  target_id: {
    type: "string" as const,
    description: "Canonical target identity; resolved to the current live binding.",
  },
  semantic_address: {
    type: "json" as const,
    description: "Canonical SemanticAddress; resolved fail-closed to the current binding.",
  },
} as const;

export interface CanonicalField {
  target?: string;
  target_id?: string;
  binding?: string;
  address?: string;
  ambiguous?: boolean;
}

function canonicalAddress(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const address = value as Record<string, unknown>;
  const normalize = (part: unknown) =>
    typeof part === "string"
      ? part.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ")
      : undefined;
  const normalized: Record<string, string> = {};
  for (const key of [
    "origin",
    "document",
    "parentRegion",
    "role",
    "name",
    "namespace",
    "structuralRelation",
  ]) {
    const part = normalize(address[key]);
    if (part !== undefined && part.length > 0) normalized[key] = part;
  }
  if (!normalized.origin || !normalized.document) return undefined;
  return JSON.stringify(normalized);
}

export function resolveCanonicalField(
  fields: readonly CanonicalField[],
  input: { target_id?: string; semantic_address?: unknown },
): string {
  const address = canonicalAddress(input.semantic_address);
  const candidates = fields.filter((field) =>
    input.target_id !== undefined ? field.target_id === input.target_id : field.address === address,
  );
  if (candidates.length !== 1 || candidates[0]?.ambiguous || !candidates[0]?.binding)
    throw new Error(
      `canonical target unresolved or ambiguous: ${input.target_id ?? "semantic address"}`,
    );
  return candidates[0].binding;
}

/** Resolve canonical identity through the daemon's ELI-304 snapshot projection. */
export async function resolveCanonicalTarget(
  runtime: Pick<PhaseOneRuntime, "run">,
  exec: ToolRunContext,
  input: { target?: string; target_id?: string; semantic_address?: unknown },
  session: string,
  tabId: number | undefined,
  timeoutMs: number | undefined,
): Promise<string> {
  if (input.target_id === undefined && input.semantic_address === undefined) {
    if (!input.target || input.target.trim().length === 0)
      throw new Error("target must be a non-empty string");
    return input.target;
  }
  const snapshotArgs = ["snapshot", "--session", session, "--materialize-canonical"];
  appendTabId(snapshotArgs, tabId);
  const snapshot = (await runtime.run(
    exec,
    snapshotArgs,
    "resolve canonical target",
    session,
    timeoutMs,
  )) as { fields?: CanonicalField[] };
  return resolveCanonicalField(snapshot.fields ?? [], input);
}

export function appendTabId(args: string[], tabId: number | undefined): void {
  if (tabId !== undefined) args.push("--tab-id", String(tabId));
}

export function appendWaitOptions(
  args: string[],
  waitUntil: string | undefined,
  timeoutMs: number | undefined,
): void {
  if (waitUntil !== undefined) args.push("--wait-until", waitUntil);
  if (timeoutMs !== undefined) args.push("--timeout", `${timeoutMs}ms`);
}
