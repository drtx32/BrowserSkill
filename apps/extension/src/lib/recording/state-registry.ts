export interface RecordedStateEntry {
  id: string;
  url: string;
  title?: string;
  /** Rendered VOM text; capture indexes and source DOM/AX data never enter the registry. */
  vomText: string;
  truncated: boolean;
  stepsHere: number[];
  documentId?: string;
  revision: number;
  baseStateId?: string;
  delta?: { added: string[]; removed: string[] };
}

function stateIdentity(url: string, body: string): string {
  return `${url}\0${body}`;
}

function lineDelta(previous: string, next: string): { added: string[]; removed: string[] } {
  const before = new Set(previous.split("\n"));
  const after = new Set(next.split("\n"));
  return {
    added: [...after].filter((line) => !before.has(line)).slice(0, 200),
    removed: [...before].filter((line) => !after.has(line)).slice(0, 200),
  };
}

export class RecordingStateRegistry {
  readonly #entriesById = new Map<string, RecordedStateEntry>();
  readonly #idByIdentity = new Map<string, string>();
  #nextId = 1;

  register(input: {
    url: string;
    documentId?: string;
    title?: string;
    vomText: string;
    truncated?: boolean;
  }): RecordedStateEntry {
    const identity = stateIdentity(input.url, input.vomText);
    const existingId = this.#idByIdentity.get(identity);
    if (existingId) {
      const existing = this.#entriesById.get(existingId)!;
      if (!existing.title && input.title) existing.title = input.title;
      if (input.truncated) existing.truncated = true;
      return existing;
    }

    const previous = [...this.#entriesById.values()].at(-1);
    const sameDocument = Boolean(
      previous &&
        input.documentId &&
        previous.documentId &&
        input.documentId === previous.documentId &&
        !input.truncated &&
        !previous.truncated,
    );
    const entry: RecordedStateEntry = {
      id: `s${this.#nextId}`,
      url: input.url,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.title ? { title: input.title } : {}),
      vomText: input.vomText,
      truncated: input.truncated ?? false,
      stepsHere: [],
      revision: sameDocument && previous ? previous.revision + 1 : 1,
      ...(sameDocument && previous
        ? {
            baseStateId: previous.baseStateId ?? previous.id,
            delta: lineDelta(previous.vomText, input.vomText),
          }
        : {}),
    };
    this.#nextId += 1;
    this.#entriesById.set(entry.id, entry);
    this.#idByIdentity.set(identity, entry.id);
    return entry;
  }

  values(): RecordedStateEntry[] {
    return [...this.#entriesById.values()];
  }

  markStep(stateId: string, draftId: number): void {
    const entry = this.#entriesById.get(stateId);
    if (entry && !entry.stepsHere.includes(draftId)) entry.stepsHere.push(draftId);
  }
}
