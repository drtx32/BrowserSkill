import type { Rect, Viewport } from "./types";

export type LocatorValue = string | number | boolean;
export type LocatorField =
  | "role"
  | "name"
  | "text"
  | "href"
  | "title"
  | "region"
  | "state"
  | "x"
  | "y"
  | "w"
  | "h"
  | "xnorm"
  | "ynorm"
  | "wnorm"
  | "hnorm";
export type LocatorOperator =
  | "="
  | "!="
  | "~"
  | "~="
  | "!~"
  | "^="
  | "$="
  | "*="
  | ">"
  | ">="
  | "<"
  | "<="
  | "regex";
export interface LocatorPredicate {
  field: LocatorField;
  operator: LocatorOperator;
  value: LocatorValue;
  flags?: string;
}
export interface LocatorQuery {
  predicates: LocatorPredicate[];
  css?: string;
}
export interface LocatorNode {
  id?: string | number;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  title?: string;
  region?: string;
  states?: readonly string[];
  rect?: Rect | null;
  attrs?: Readonly<Record<string, string>>;
  backendNodeId?: number;
}
export interface LocatorMatch<T> {
  node: T;
  score: number;
  reasons: string[];
}

const FIELDS = new Set<LocatorField>([
  "role",
  "name",
  "text",
  "href",
  "title",
  "region",
  "state",
  "x",
  "y",
  "w",
  "h",
  "xnorm",
  "ynorm",
  "wnorm",
  "hnorm",
]);
const MAX_REGEX_SOURCE = 512;

function tokens(input: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let regex = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (!regex && char === "/" && i > 0 && /[~!]/.test(input[i - 1])) regex = true;
    else if (regex && char === "/" && /^(?:[gimsuy]*)(?:\s|$)/.test(input.slice(i + 1)))
      regex = false;
    if (char === " " && !regex) {
      if (input.slice(start, i).trim()) result.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote || regex) throw new Error("unterminated quote or regex in locator");
  if (input.slice(start).trim()) result.push(input.slice(start).trim());
  return result;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
  )
    return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  return value;
}

function parseValue(raw: string): {
  value: LocatorValue;
  flags?: string;
  operator: LocatorOperator;
} {
  const value = unquote(raw);
  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const end = value.lastIndexOf("/"),
      source = value.slice(1, end),
      flags = value.slice(end + 1);
    if (source.length > MAX_REGEX_SOURCE || /[^gimsuy]/.test(flags))
      throw new Error("unsafe or invalid locator regex");
    try {
      new RegExp(source, flags);
    } catch {
      throw new Error("invalid locator regex");
    }
    return { value: source, flags, operator: "regex" };
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { value: Number(value), operator: "=" };
  if (value === "true" || value === "false") return { value: value === "true", operator: "=" };
  return { value, operator: "=" };
}

export function parseLocator(input: string): LocatorQuery {
  const predicates: LocatorPredicate[] = [];
  let css: string | undefined;
  for (const token of tokens(input.trim())) {
    if (token.startsWith("--css=")) {
      css = unquote(token.slice(6));
      continue;
    }
    if (token === "--css")
      throw new Error("--css requires a selector (quote it when it contains spaces)");
    const match = /^([a-z][a-z0-9_-]*)(>=|<=|!=|!~|~=|~|\^=|\$=|\*=|>|<|=)(.+)$/i.exec(token);
    if (!match || !FIELDS.has(match[1].toLowerCase() as LocatorField))
      throw new Error(`invalid locator predicate: ${token}`);
    const parsed = parseValue(match[3]);
    const operator =
      parsed.operator === "regex"
        ? match[2] === "!~"
          ? "!~"
          : "regex"
        : (match[2] as LocatorOperator);
    predicates.push({
      field: match[1].toLowerCase() as LocatorField,
      operator,
      value: parsed.value,
      ...(parsed.flags ? { flags: parsed.flags } : {}),
    });
  }
  if (predicates.length === 0 && !css)
    throw new Error("locator must contain a predicate or --css selector");
  return { predicates, ...(css ? { css } : {}) };
}

function fieldValue(
  node: LocatorNode,
  field: LocatorField,
  viewport?: Viewport,
): LocatorValue | undefined {
  if (["x", "y", "w", "h", "xnorm", "ynorm", "wnorm", "hnorm"].includes(field)) {
    if (!node.rect) return undefined;
    const raw =
      field[0] === "x"
        ? node.rect.x
        : field[0] === "y"
          ? node.rect.y
          : field[0] === "w"
            ? node.rect.w
            : node.rect.h;
    if (!field.endsWith("norm")) return raw;
    const size = field[0] === "x" || field[0] === "w" ? viewport?.width : viewport?.height;
    return size && size > 0 ? raw / size : undefined;
  }
  if (field === "state") return node.states?.join(" ");
  switch (field) {
    case "role":
      return node.role;
    case "name":
      return node.name;
    case "text":
      return node.text;
    case "href":
      return node.href;
    case "title":
      return node.title;
    case "region":
      return node.region;
    default:
      return undefined;
  }
}

function equal(actual: LocatorValue | undefined, expected: LocatorValue): boolean {
  return typeof actual === "string" && typeof expected === "string"
    ? actual === expected
    : actual === expected;
}

export function matchesLocator(
  node: LocatorNode,
  query: LocatorQuery | string,
  viewport?: Viewport,
): boolean {
  const parsed = typeof query === "string" ? parseLocator(query) : query;
  return parsed.predicates.every((predicate) => {
    const actual = fieldValue(node, predicate.field, viewport),
      expected = predicate.value;
    if (predicate.operator === "regex" || predicate.operator === "!~") {
      if (typeof actual !== "string") return predicate.operator === "!~";
      const result = new RegExp(String(expected), predicate.flags).test(actual);
      return predicate.operator === "!~" ? !result : result;
    }
    if (predicate.operator === "=") return equal(actual, expected);
    if (predicate.operator === "!=") return !equal(actual, expected);
    if (typeof actual === "string" && typeof expected === "string") {
      if (predicate.operator === "~=" || predicate.operator === "~")
        return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
      if (predicate.operator === "^=") return actual.startsWith(expected);
      if (predicate.operator === "$=") return actual.endsWith(expected);
      if (predicate.operator === "*=") return actual.includes(expected);
    }
    if (typeof actual === "number" && typeof expected === "number") {
      if (predicate.operator === ">") return actual > expected;
      if (predicate.operator === ">=") return actual >= expected;
      if (predicate.operator === "<") return actual < expected;
      if (predicate.operator === "<=") return actual <= expected;
    }
    return false;
  });
}

export function findLocators<T extends LocatorNode>(
  nodes: readonly T[],
  query: LocatorQuery | string,
  viewport?: Viewport,
): LocatorMatch<T>[] {
  const parsed = typeof query === "string" ? parseLocator(query) : query;
  if (parsed.css) throw new Error("CSS locators require a live DOM resolver");
  return nodes
    .filter((node) => matchesLocator(node, parsed, viewport))
    .map((node) => ({
      node,
      score: parsed.predicates.length,
      reasons: parsed.predicates.map((p) => `${p.field}${p.operator}${String(p.value)}`),
    }));
}

export type RematchResult<T> =
  | { status: "matched"; match: LocatorMatch<T> }
  | { status: "ambiguous"; matches: LocatorMatch<T>[] }
  | { status: "not_found"; matches: [] };

/** Safely recover an expired ephemeral ref from its retained locator fingerprint.
 * Only a unique match is actionable; callers must surface ambiguous candidates. */
export function rematchLocator<T extends LocatorNode>(
  nodes: readonly T[],
  fingerprint: LocatorQuery | string,
  viewport?: Viewport,
): RematchResult<T> {
  const matches = findLocators(nodes, fingerprint, viewport);
  if (matches.length === 1) return { status: "matched", match: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "not_found", matches: [] };
}

export interface DiscoverResult<T> extends LocatorMatch<T> {
  confidence: number;
}
export function discoverLocators<T extends LocatorNode>(
  nodes: readonly T[],
  goal: string,
  limit = 5,
): DiscoverResult<T>[] {
  const terms = goal
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
  return nodes
    .map((node) => {
      const haystack = [
        node.role,
        node.name,
        node.text,
        node.title,
        node.region,
        ...(node.states ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      const hits = terms.filter((term) => haystack.includes(term));
      const score = terms.length ? hits.length / terms.length : 0;
      return { node, score, confidence: score, reasons: hits.map((hit) => `text contains ${hit}`) };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}
