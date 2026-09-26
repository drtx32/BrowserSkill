/** Batch-first high-level form execution.  This module owns orchestration only;
 * target resolution and mutation remain in the existing BrowserSkill runner. */

export const FORM_REFRESH_TRIGGERS = [
  "nav_rollover",
  "binding_stale",
  "binding_ambiguous",
  "invalidation_meaningful",
  "full_refresh_required",
  "dynamic_region_unresolved",
] as const;

export type FormRefreshTrigger = (typeof FORM_REFRESH_TRIGGERS)[number];
export type FormFieldAction = "fill" | "select";

export interface FormField {
  target: string;
  target_id?: string;
  semantic_address?: unknown;
  /** Current observation-local binding resolved from canonical identity. */
  binding?: string;
  action: FormFieldAction;
  value?: string;
  values?: string[];
  section?: string;
  tabId?: number;
}

export interface FormMaterialization {
  revision?: string | number;
  fields?: readonly {
    target: string;
    target_id?: string;
    binding?: string;
    address?: string;
    /** Backward-compatible adapter input; production snapshot metadata omits this. */
    protected?: boolean;
    ambiguous?: boolean;
  }[];
}

export interface FormMutationResult {
  tabId: number;
  valueLength?: number;
  selectedValues?: string[];
  selectedLabels?: string[];
  trigger?: string;
  revision?: string | number;
  fallback_reason?: string;
}

export interface FormReceipt {
  trigger?: FormRefreshTrigger;
  succeeded: string[];
  skipped: string[];
  ambiguous: string[];
  new_required_fields: string[];
  revision?: string | number;
  fallback_reason?: string;
}

export interface FormRuntimeResult {
  tabId: number;
  receipt: FormReceipt;
  results: readonly FormMutationResult[];
}

export interface FormRuntimeOptions {
  independentFields?: boolean;
  materialize: () => Promise<FormMaterialization>;
  mutate: (field: FormField) => Promise<FormMutationResult>;
  rePerceive: (
    reason: FormRefreshTrigger,
    revision?: string | number,
  ) => Promise<FormMaterialization>;
}

function isRefreshTrigger(value: unknown): value is FormRefreshTrigger {
  return typeof value === "string" && (FORM_REFRESH_TRIGGERS as readonly string[]).includes(value);
}

function validateField(field: FormField): void {
  if (!field.target.trim() && field.target_id === undefined && field.semantic_address === undefined)
    throw new Error("form field target must be non-empty");
  if (field.action === "fill" && typeof field.value !== "string")
    throw new Error(`fill field ${field.target} requires value`);
  if (field.action === "select" && (!field.values || field.values.length === 0))
    throw new Error(`select field ${field.target} requires values`);
}

/** Execute a form as one materialized, preflighted batch. */
export async function runFormRuntime(
  fields: readonly FormField[],
  options: FormRuntimeOptions,
): Promise<FormRuntimeResult> {
  if (fields.length === 0) throw new Error("form fields must not be empty");
  fields.forEach(validateField);

  let materialized = await options.materialize();
  const protectedTargets = new Set(
    (materialized.fields ?? []).filter((field) => field.protected).map((field) => field.target),
  );
  const ambiguousTargets = new Set(
    (materialized.fields ?? []).filter((field) => field.ambiguous).map((field) => field.target),
  );
  const ambiguous = fields
    .filter((field) => {
      const candidates = (materialized.fields ?? []).filter(
        (candidate) =>
          candidate.target === field.target ||
          candidate.target_id === field.target ||
          candidate.binding === field.target,
      );
      return (
        protectedTargets.has(field.target) ||
        ambiguousTargets.has(field.target) ||
        candidates.some((candidate) => candidate.protected || candidate.ambiguous)
      );
    })
    .map((field) => field.target);
  if (ambiguous.length > 0)
    return {
      tabId: 0,
      receipt: {
        succeeded: [],
        skipped: [],
        ambiguous,
        new_required_fields: [],
        ...(materialized.revision === undefined ? {} : { revision: materialized.revision }),
        fallback_reason: "fail_closed_protected_or_ambiguous",
      },
      results: [],
    };

  // The default is atomic preflight. `independentFields` is deliberately an
  // opt-in escape hatch for callers that explicitly accept partial progress.
  const groups = new Map<string, FormField[]>();
  for (const [index, field] of fields.entries()) {
    const key =
      options.independentFields === true
        ? `${field.target}:${index}`
        : (field.section ?? "default");
    const group = groups.get(key) ?? [];
    group.push(field);
    groups.set(key, group);
  }
  const results: FormMutationResult[] = [];
  const succeeded: string[] = [];
  const skipped: string[] = [];
  let trigger: FormRefreshTrigger | undefined;
  let fallbackReason: string | undefined;
  for (const group of groups.values()) {
    for (const field of group) {
      const result = await options.mutate(field);
      results.push(result);
      succeeded.push(field.target);
      if (isRefreshTrigger(result.trigger)) {
        trigger = result.trigger;
        fallbackReason = result.fallback_reason;
        materialized = await options.rePerceive(
          result.trigger,
          result.revision ?? materialized.revision,
        );
      }
    }
  }
  const newlyRequired = (materialized.fields ?? [])
    .filter(
      (field) =>
        field.target &&
        !fields.some(
          (input) =>
            input.target === field.target ||
            input.target === field.target_id ||
            input.target === field.binding,
        ),
    )
    .map((field) => field.target);
  return {
    tabId: results[0]?.tabId ?? 0,
    receipt: {
      ...(trigger === undefined ? {} : { trigger }),
      succeeded,
      skipped,
      ambiguous: [],
      new_required_fields: newlyRequired,
      ...(materialized.revision === undefined ? {} : { revision: materialized.revision }),
      ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
    },
    results,
  };
}
