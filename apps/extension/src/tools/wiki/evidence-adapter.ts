/**
 * Read-only shadow evidence adapter.
 *
 * The adapter is intentionally transport-neutral: callers can feed it the
 * evidence already produced by observe/action/navigation code and decide how
 * to persist it locally. It never sends page content anywhere and it never
 * creates or resolves an interaction ref.
 */

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_EVENTS_PER_PAGE = 10_000;

export type WikiEvidenceKind =
  | "observation"
  | "mutation"
  | "navigation"
  | "action"
  | "popup"
  | "ownership"
  | "error";

export type WikiEvidenceSource = "dom" | "ax" | "cdp" | "vom" | "daemon" | "cli" | "agent";

export type EvidenceCompleteness =
  | "complete"
  | "partial"
  | "stale"
  | "unknown"
  | "overflow"
  | "ambiguous"
  | "full_refresh_required";

export interface WikiEvidenceEvent {
  schema_version: "1.0";
  event_id: string;
  page_instance_id: string;
  revision: number;
  kind: WikiEvidenceKind;
  source: WikiEvidenceSource;
  payload: Record<string, unknown>;
  predecessor_event_id: string | null;
  completeness: EvidenceCompleteness;
}

export interface WikiEvidenceInput {
  page_instance_id: string;
  kind: WikiEvidenceKind;
  source: WikiEvidenceSource;
  payload: unknown;
  completeness?: EvidenceCompleteness;
  event_id?: string;
}

export interface EvidenceAdapterOptions {
  /** Keep URL paths in local evidence. Origins are always safe to retain. */
  retainUrlPath?: boolean;
  /** Inject an ID source for deterministic tests. */
  id?: () => string;
}

const SECRET_KEYS = /^(?:password|passcode|token|secret|cookie|authorization|credential|file_contents?|script(?:_body)?|screenshot|image)$/i;
const URL_KEYS = /^(?:url|href|src|document_url)$/i;

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `wiki-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function originOnly(value: string, retainPath: boolean): string {
  try {
    const url = new URL(value);
    return retainPath ? `${url.origin}${url.pathname}` : url.origin;
  } catch {
    return "[redacted-url]";
  }
}

function redact(value: unknown, retainPath: boolean, key?: string): unknown {
  if (key && SECRET_KEYS.test(key)) return "[redacted]";
  if (key && URL_KEYS.test(key) && typeof value === "string") return originOnly(value, retainPath);
  if (Array.isArray(value)) return value.map((item) => redact(item, retainPath));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, retainPath, childKey),
      ]),
    );
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function boundedPayload(value: unknown, retainPath: boolean): { payload: Record<string, unknown>; truncated: boolean } {
  const safe = redact(value, retainPath);
  const candidate = safe && typeof safe === "object" && !Array.isArray(safe) ? safe : { value: safe };
  const encoded = new TextEncoder().encode(JSON.stringify(candidate));
  if (encoded.byteLength <= MAX_EVENT_BYTES) return { payload: candidate as Record<string, unknown>, truncated: false };
  return {
    payload: { redacted: true, reason: "payload_limit" },
    truncated: true,
  };
}

export class ShadowEvidenceAdapter {
  private readonly eventsByPage = new Map<string, WikiEvidenceEvent[]>();
  private readonly retainUrlPath: boolean;
  private readonly id: () => string;
  private lastEventId = new Map<string, string>();

  constructor(options: EvidenceAdapterOptions = {}) {
    this.retainUrlPath = options.retainUrlPath ?? false;
    this.id = options.id ?? defaultId;
  }

  capture(input: WikiEvidenceInput): WikiEvidenceEvent {
    const events = this.eventsByPage.get(input.page_instance_id) ?? [];
    const bounded = boundedPayload(input.payload, this.retainUrlPath);
    const overflow = events.length >= MAX_EVENTS_PER_PAGE;
    const event: WikiEvidenceEvent = {
      schema_version: "1.0",
      event_id: input.event_id ?? this.id(),
      page_instance_id: input.page_instance_id,
      revision: events.length + 1,
      kind: input.kind,
      source: input.source,
      payload: bounded.payload,
      predecessor_event_id: this.lastEventId.get(input.page_instance_id) ?? null,
      completeness: overflow || bounded.truncated ? "full_refresh_required" : input.completeness ?? "complete",
    };
    if (!overflow) {
      events.push(event);
      this.eventsByPage.set(input.page_instance_id, events);
      this.lastEventId.set(input.page_instance_id, event.event_id);
    }
    return event;
  }

  events(pageInstanceId: string): readonly WikiEvidenceEvent[] {
    return this.eventsByPage.get(pageInstanceId) ?? [];
  }
}
