/**
 * Page-scoped semantic identity and resolution.
 *
 * This module is deliberately a projection over the existing WikiRef/stable
 * reference evidence. It does not retain an identity index and `stable_ref`
 * (`@eN`) is never used as a target identity.
 */

export interface SemanticAddress {
  origin: string;
  document: string;
  parentRegion?: string;
  role?: string;
  name?: string;
  namespace?: string;
  structuralRelation?: string;
}

export interface SemanticTarget {
  target_id: string;
  address: SemanticAddress;
  aliases?: readonly string[];
  stableAttributes?: Readonly<Record<string, string | number | boolean>>;
  structuralRelation?: string;
  value?: unknown;
}

export interface SemanticQuery {
  target_id?: string;
  address?: Partial<SemanticAddress>;
  alias?: string;
  stableAttributes?: Readonly<Record<string, string | number | boolean>>;
  structuralRelation?: string;
}

export interface FuzzyPolicy {
  /** Minimum normalized similarity required for fuzzy resolution. */
  threshold: number;
  /** Required lead over the second-best candidate. */
  margin: number;
  /** Maximum candidates considered after scope filtering. */
  maxCandidates: number;
}

export interface FuzzyCalibrationFixture {
  kind: "positive" | "near-miss" | "ambiguous";
  query: string;
  candidates: readonly string[];
}

/** Small, deterministic evidence set for the token scorer used below. */
export const FUZZY_CALIBRATION_FIXTURES: readonly FuzzyCalibrationFixture[] = [
  { kind: "positive", query: "save profile settings", candidates: ["save profile settings"] },
  { kind: "positive", query: "submit order review", candidates: ["submit order review"] },
  { kind: "near-miss", query: "save profile settings", candidates: ["save profile archive"] },
  { kind: "near-miss", query: "submit order review", candidates: ["submit order history"] },
  {
    kind: "ambiguous",
    query: "save profile",
    candidates: ["save profile draft", "save profile copy"],
  },
];

export const MAX_FUZZY_CANDIDATES = 64;

export type ResolutionTier =
  | "exact-canonical"
  | "aliases-stable-attributes"
  | "contextual"
  | "structural"
  | "fuzzy-semantic"
  | "unresolved";

export interface ResolutionResult {
  target: SemanticTarget | null;
  target_id: string | null;
  tier: ResolutionTier;
  reason:
    | "resolved"
    | "missing"
    | "ambiguous"
    | "cross-document"
    | "cross-origin"
    | "invalid-policy";
  candidates: readonly string[];
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function validPolicy(policy: FuzzyPolicy): boolean {
  return (
    Number.isFinite(policy.threshold) &&
    policy.threshold >= 0 &&
    policy.threshold <= 1 &&
    Number.isFinite(policy.margin) &&
    policy.margin >= 0 &&
    policy.margin <= 1 &&
    Number.isInteger(policy.maxCandidates) &&
    policy.maxCandidates > 0 &&
    policy.maxCandidates <= MAX_FUZZY_CANDIDATES
  );
}

function attributeKey(
  attributes: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  if (!attributes) return "";
  return Object.keys(attributes)
    .sort()
    .map((key) => `${normalize(key)}=${normalize(String(attributes[key]))}`)
    .join("\u0000");
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(
    normalize(left)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const b = new Set(
    normalize(right)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

/**
 * Selects policy values from the local scorer evidence. The midpoint between
 * the weakest positive and strongest near-miss is the threshold; the same
 * observed separation is the required winner margin. The candidate bound is
 * deliberately capped even if this fixture set grows.
 */
export function calibrateFuzzyPolicy(
  fixtures: readonly FuzzyCalibrationFixture[] = FUZZY_CALIBRATION_FIXTURES,
): Readonly<FuzzyPolicy> {
  const positives = fixtures
    .filter((fixture) => fixture.kind === "positive")
    .flatMap((fixture) =>
      fixture.candidates.map((candidate) => tokenSimilarity(fixture.query, candidate)),
    );
  const nearMisses = fixtures
    .filter((fixture) => fixture.kind === "near-miss")
    .flatMap((fixture) =>
      fixture.candidates.map((candidate) => tokenSimilarity(fixture.query, candidate)),
    );
  if (!positives.length || !nearMisses.length)
    throw new Error("fuzzy calibration needs positive and near-miss fixtures");
  const weakestPositive = Math.min(...positives);
  const strongestNearMiss = Math.max(...nearMisses);
  const separation = weakestPositive - strongestNearMiss;
  const threshold = Number(((weakestPositive + strongestNearMiss) / 2).toFixed(2));
  return Object.freeze({
    threshold,
    margin: Number(separation.toFixed(2)),
    maxCandidates: Math.min(MAX_FUZZY_CANDIDATES, Math.max(8, fixtures.length * 4)),
  });
}

/** Derived from FUZZY_CALIBRATION_FIXTURES; consumers may supply stricter evidence-backed policy. */
export const DEFAULT_FUZZY_POLICY: Readonly<FuzzyPolicy> = calibrateFuzzyPolicy();

function result(
  target: SemanticTarget | null,
  tier: ResolutionTier,
  reason: ResolutionResult["reason"],
  candidates: readonly string[] = [],
): ResolutionResult {
  return { target, target_id: target?.target_id ?? null, tier, reason, candidates };
}

/** Resolve a query in the frozen, fail-closed tier order. */
export function resolveSemanticTarget(
  query: SemanticQuery,
  targets: readonly SemanticTarget[],
  policy: FuzzyPolicy = DEFAULT_FUZZY_POLICY,
): ResolutionResult {
  if (!validPolicy(policy)) return result(null, "unresolved", "invalid-policy");
  if (!targets.length) return result(null, "unresolved", "missing");

  // Scope is a safety boundary, not a ranking feature. A query that identifies
  // another origin/document is rejected before any candidate is scored.
  const queryAddress = query.address;
  if (queryAddress?.origin !== undefined) {
    const origin = normalize(queryAddress.origin);
    if (!targets.some((target) => normalize(target.address.origin) === origin))
      return result(null, "unresolved", "cross-origin");
  }
  if (queryAddress?.document !== undefined) {
    const document = normalize(queryAddress.document);
    if (!targets.some((target) => normalize(target.address.document) === document))
      return result(null, "unresolved", "cross-document");
  }

  const scoped = targets.filter((target) => {
    if (
      queryAddress?.origin !== undefined &&
      normalize(target.address.origin) !== normalize(queryAddress.origin)
    )
      return false;
    if (
      queryAddress?.document !== undefined &&
      normalize(target.address.document) !== normalize(queryAddress.document)
    )
      return false;
    return true;
  });
  if (!scoped.length) return result(null, "unresolved", "missing");

  // A partial scope cannot safely rank across pages. Require a complete page
  // scope whenever the candidate set contains more than one origin/document.
  const pageScopes = new Set(
    scoped.map(
      (target) => `${normalize(target.address.origin)}\u0000${normalize(target.address.document)}`,
    ),
  );
  if ((!queryAddress?.origin || !queryAddress?.document) && pageScopes.size > 1)
    return result(
      null,
      "unresolved",
      "ambiguous",
      scoped.map((target) => target.target_id),
    );

  if (query.target_id) {
    const exact = scoped.filter((target) => target.target_id === query.target_id);
    if (exact.length === 1) return result(exact[0], "exact-canonical", "resolved");
    if (exact.length > 1)
      return result(
        null,
        "unresolved",
        "ambiguous",
        exact.map((t) => t.target_id),
      );
  }

  // Tier 1b is exact only when both page-scope fields are supplied.
  const canonicalAddress =
    queryAddress?.origin !== undefined && queryAddress.document !== undefined
      ? canonicalSemanticAddress(queryAddress as SemanticAddress)
      : undefined;
  if (canonicalAddress) {
    const exactAddress = scoped.filter(
      (target) => canonicalSemanticAddress(target.address) === canonicalAddress,
    );
    if (exactAddress.length === 1) return result(exactAddress[0], "exact-canonical", "resolved");
    if (exactAddress.length > 1)
      return result(
        null,
        "unresolved",
        "ambiguous",
        exactAddress.map((t) => t.target_id),
      );
  }

  const alias = normalize(query.alias);
  const stableKey = attributeKey(query.stableAttributes);
  const stableMatches = scoped.filter((target) => {
    const aliases = (target.aliases ?? []).map(normalize);
    const aliasMatch = Boolean(alias && aliases.includes(alias));
    const stableMatch = Boolean(stableKey && attributeKey(target.stableAttributes) === stableKey);
    return aliasMatch || stableMatch;
  });
  if (stableMatches.length === 1)
    return result(stableMatches[0], "aliases-stable-attributes", "resolved");
  if (stableMatches.length > 1)
    return result(
      null,
      "unresolved",
      "ambiguous",
      stableMatches.map((t) => t.target_id),
    );

  const address = query.address ?? {};
  const hasContext = [address.parentRegion, address.role, address.name, address.namespace].some(
    Boolean,
  );
  const contextual = hasContext
    ? scoped.filter((target) => {
        const candidate = target.address;
        return (
          (!address.parentRegion ||
            normalize(address.parentRegion) === normalize(candidate.parentRegion)) &&
          (!address.role || normalize(address.role) === normalize(candidate.role)) &&
          (!address.name || normalize(address.name) === normalize(candidate.name)) &&
          (!address.namespace || normalize(address.namespace) === normalize(candidate.namespace))
        );
      })
    : [];
  if (contextual.length === 1) return result(contextual[0], "contextual", "resolved");
  if (contextual.length > 1)
    return result(
      null,
      "unresolved",
      "ambiguous",
      contextual.map((t) => t.target_id),
    );

  if (query.structuralRelation) {
    const structural = scoped.filter(
      (target) =>
        normalize(target.structuralRelation ?? target.address.structuralRelation) ===
        normalize(query.structuralRelation),
    );
    if (structural.length === 1) return result(structural[0], "structural", "resolved");
    if (structural.length > 1)
      return result(
        null,
        "unresolved",
        "ambiguous",
        structural.map((t) => t.target_id),
      );
  }

  const fuzzyText = [
    query.alias,
    query.address?.name,
    query.address?.role,
    query.address?.namespace,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (fuzzyText) {
    const scored = scoped
      .map((target) => ({
        target,
        score: tokenSimilarity(
          fuzzyText,
          [target.address.name, target.address.role, target.address.namespace]
            .filter(Boolean)
            .join(" "),
        ),
      }))
      .filter((candidate) => candidate.score >= policy.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, policy.maxCandidates);
    if (
      scored.length === 1 ||
      (scored.length > 1 && scored[0].score - scored[1].score >= policy.margin)
    )
      return result(scored[0].target, "fuzzy-semantic", "resolved");
    if (scored.length > 1)
      return result(
        null,
        "unresolved",
        "ambiguous",
        scored.map((c) => c.target.target_id),
      );
  }
  return result(null, "unresolved", "missing");
}

/** Stable canonical serialization for page-scoped addresses. */
export function canonicalSemanticAddress(address: SemanticAddress): string {
  return JSON.stringify({
    origin: normalize(address.origin),
    document: normalize(address.document),
    ...(address.parentRegion ? { parentRegion: normalize(address.parentRegion) } : {}),
    ...(address.role ? { role: normalize(address.role) } : {}),
    ...(address.name ? { name: normalize(address.name) } : {}),
    ...(address.namespace ? { namespace: normalize(address.namespace) } : {}),
    ...(address.structuralRelation
      ? { structuralRelation: normalize(address.structuralRelation) }
      : {}),
  });
}
