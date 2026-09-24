import { describe, expect, it } from "vitest";
import { canonicalPerception } from "./canonical-runtime";
import { readCanonicalSnapshot } from "./canonical-snapshot";

const scope = {
  browser_id: "window:7",
  session_id: "form-session",
  tab_id: 9,
  document_id: "document-1",
  origin: "https://example.test",
};

function ref(ref: string, name: string, path?: string) {
  return {
    ref,
    backendNodeId: Number(ref.slice(1)) + 1,
    line: 0,
    role: "textbox",
    name,
    ...(path ? { identity: { path } } : {}),
  };
}

function seed(targets: Parameters<typeof canonicalPerception.applyFullObservation>[2]) {
  canonicalPerception.applyFullObservation(
    scope,
    { ownership_id: "recording:form-session" },
    targets,
  );
}

describe("canonical snapshot materialization", () => {
  it("keeps the canonical target index keyed by the live Wikipedia scope", () => {
    const wikipediaScope = {
      browser_id: "window:7",
      session_id: "form-session",
      tab_id: 886465835,
      origin: "https://en.wikipedia.org",
      document_id: "D4539EE64605C4FF93FD82D8F84036A6",
    };
    canonicalPerception.applyFullObservation(
      wikipediaScope,
      { ownership_id: "recording:form-session" },
      [
        {
          target_id: "field:wikipedia-search",
          address: {
            origin: wikipediaScope.origin,
            document: wikipediaScope.document_id,
            role: "textbox",
            name: "Search Wikipedia",
          },
          stable_ref: "@e1",
        },
      ],
    );
    expect(canonicalPerception.currentTargets(wikipediaScope)).toHaveLength(1);
    canonicalPerception.releaseSession(wikipediaScope.session_id);
  });

  it("returns an existing canonical id and live binding without minting identity", () => {
    seed([
      {
        target_id: "field:email",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "textbox",
          name: "Email",
          structuralRelation: "form.email",
        },
        stable_ref: "@e1",
      },
    ]);
    const result = readCanonicalSnapshot({
      browserId: scope.browser_id,
      sessionId: scope.session_id,
      tabId: scope.tab_id,
      origin: scope.origin,
      documentId: scope.document_id,
      revision: 4,
      refs: [ref("e1", "Email", "form.email")],
    });
    expect(result?.fields).toEqual([
      expect.objectContaining({ target_id: "field:email", binding: "@e1" }),
    ]);
    const missing = readCanonicalSnapshot({
      browserId: scope.browser_id,
      sessionId: scope.session_id,
      tabId: scope.tab_id,
      origin: scope.origin,
      documentId: scope.document_id,
      revision: 4,
      refs: [ref("e2", "Other")],
    });
    expect(missing?.fields[0].target_id).toBeUndefined();
    canonicalPerception.releaseSession(scope.session_id);
  });

  it("keeps the canonical id when a same-document binding is renumbered", () => {
    seed([
      {
        target_id: "field:name",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "textbox",
          name: "Name",
          structuralRelation: "form.name",
        },
        stable_ref: "@e1",
      },
    ]);
    const result = readCanonicalSnapshot({
      browserId: scope.browser_id,
      sessionId: scope.session_id,
      tabId: scope.tab_id,
      origin: scope.origin,
      documentId: scope.document_id,
      revision: 2,
      refs: [ref("e8", "Name", "form.name")],
    });
    expect(result?.fields[0]).toMatchObject({ target_id: "field:name", binding: "@e8" });
    canonicalPerception.releaseSession(scope.session_id);
  });

  it("fails closed for same-role/name candidates queried without a disambiguator", () => {
    seed([
      {
        target_id: "field:a",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "textbox",
          name: "Code",
          structuralRelation: "form.a",
        },
        stable_ref: "@e1",
      },
      {
        target_id: "field:b",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "textbox",
          name: "Code",
          structuralRelation: "form.b",
        },
        stable_ref: "@e2",
      },
    ]);
    const result = readCanonicalSnapshot({
      browserId: scope.browser_id,
      sessionId: scope.session_id,
      tabId: scope.tab_id,
      origin: scope.origin,
      documentId: scope.document_id,
      revision: 3,
      refs: [ref("e9", "Code")],
    });
    expect(result?.fields[0]).toMatchObject({ ambiguous: true });
    expect(result?.fields[0].target_id).toBeUndefined();
    canonicalPerception.releaseSession(scope.session_id);
  });

  it("uses the existing targeted materialization path for a frozen dynamic trigger", () => {
    seed([
      {
        target_id: "field:dynamic",
        address: {
          origin: scope.origin,
          document: scope.document_id,
          role: "textbox",
          name: "Dynamic",
          structuralRelation: "form.dynamic",
        },
        stable_ref: "@e1",
      },
    ]);
    const result = readCanonicalSnapshot({
      browserId: scope.browser_id,
      sessionId: scope.session_id,
      tabId: scope.tab_id,
      origin: scope.origin,
      documentId: scope.document_id,
      revision: 2,
      fromRevision: 1,
      trigger: "dynamic_region_unresolved",
      refs: [ref("e3", "Dynamic", "form.dynamic")],
    });
    expect(result?.fields[0]).toMatchObject({ target_id: "field:dynamic", binding: "@e3" });
    canonicalPerception.releaseSession(scope.session_id);
  });
});
