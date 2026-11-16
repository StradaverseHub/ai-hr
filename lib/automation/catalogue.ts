/**
 * Shared automation module catalogues (ADR 2026-11-15-probation-shared-automation, decision 2, build step 1).
 *
 * Each module that uses the shared builders registers one catalogue: what can start a workflow, which case facts a
 * condition may test and for which triggers, which step types and recipients it offers, and which merge fields it
 * supplies. The shared engine owns the definition envelope and evaluation; the module owns these facts and their
 * meaning. Pure, dependency-free data and checks, safe for every module graph.
 */
import type {AutomationConditionOp} from './conditions';

export const AUTOMATION_MODULES = ['onb', 'off', 'contract_staff', 'probation'] as const;
export type AutomationModule = typeof AUTOMATION_MODULES[number];

export type AutomationTriggerSpec = {
  id: string; label: string;
  /** Date-based triggers run from the nightly scheduler and take days, working days and daily repeat. */
  dated?: { anchor: string; direction: 'before' | 'after' };
};
export type AutomationConditionFieldSpec = {
  id: string; label: string; ops: readonly AutomationConditionOp[];
  /** Fixed choices offered in the builder; omitted for numbers or values the module lists at run time. */
  values?: readonly string[];
  /** Triggers that can supply this fact. Omitted means every trigger in the module. */
  triggers?: readonly string[];
};
export type AutomationStepTypeSpec = { id: string; label: string };
export type AutomationSkipSpec = { id: string; label: string };
export type AutomationMergeFieldSpec = { key: string; label: string; group: string; triggers?: readonly string[] };
/** A recipient a step can name. `routing`, `group` and `person` take an id chosen in the builder. */
export type AutomationRecipientSpec = { id: string; label: string; kind: 'role' | 'routing' | 'group' | 'person' | 'pending' };
/** How an event from the module's engine before the shared builder maps onto this catalogue. */
/**
 * How an event of a module's earlier engine maps onto the shared catalogue. `exact` is true only when tests prove that the
 * converted workflow reaches the same people with the same words; `days` is the dated trigger's offset; `roles`, when
 * set, are the only earlier-engine recipient roles that event ever reached (others were silently dropped).
 */
export type AutomationLegacyEvent = { event: string; trigger: string; preset?: { field: string; op: AutomationConditionOp; values: string[] }[]; exact: boolean; note?: string; days?: number; pending?: boolean; roles?: readonly string[] };

export type AutomationModuleCatalogue = {
  module: AutomationModule; label: string;
  triggers: readonly AutomationTriggerSpec[];
  skipWhen: readonly AutomationSkipSpec[];
  conditionFields: readonly AutomationConditionFieldSpec[];
  stepTypes: readonly AutomationStepTypeSpec[];
  recipients: readonly AutomationRecipientSpec[];
  mergeFields: readonly AutomationMergeFieldSpec[];
  legacyEvents?: readonly AutomationLegacyEvent[];
};

/** Condition fields a trigger can supply, in catalogue order. */
export function conditionFieldsForTrigger(catalogue: AutomationModuleCatalogue, trigger: string): AutomationConditionFieldSpec[] {
  return catalogue.conditionFields.filter(field => !field.triggers || field.triggers.includes(trigger));
}
/** Merge fields a trigger can supply, for the "Insert merge field" picker. */
export function mergeFieldsForTrigger(catalogue: AutomationModuleCatalogue, trigger: string): AutomationMergeFieldSpec[] {
  return catalogue.mergeFields.filter(field => !field.triggers || field.triggers.includes(trigger));
}

/** Internal consistency of a catalogue. Empty means valid; a registered catalogue must be valid. */
export function automationCatalogueProblems(catalogue: AutomationModuleCatalogue): string[] {
  const problems: string[] = [];
  const triggers = new Set(catalogue.triggers.map(t => t.id));
  const unique = (label: string, ids: string[]) => { const seen = new Set<string>(); for (const id of ids) { if (!id.trim()) problems.push(`${label}: an id is empty.`); else if (seen.has(id)) problems.push(`${label}: ${id} is listed twice.`); seen.add(id); } };
  unique('Triggers', catalogue.triggers.map(t => t.id));
  unique('Skip when', catalogue.skipWhen.map(s => s.id));
  unique('Condition fields', catalogue.conditionFields.map(f => f.id));
  unique('Step types', catalogue.stepTypes.map(s => s.id));
  unique('Recipients', catalogue.recipients.map(r => r.id));
  unique('Merge fields', catalogue.mergeFields.map(f => f.key));
  if (!catalogue.triggers.length) problems.push('Add at least one trigger.');
  if (!catalogue.stepTypes.length) problems.push('Add at least one step type.');
  for (const field of catalogue.conditionFields) {
    if (!field.ops.length) problems.push(`Condition field ${field.id}: add at least one operator.`);
    for (const trigger of field.triggers ?? []) if (!triggers.has(trigger)) problems.push(`Condition field ${field.id}: unknown trigger ${trigger}.`);
  }
  for (const field of catalogue.mergeFields) for (const trigger of field.triggers ?? []) if (!triggers.has(trigger)) problems.push(`Merge field ${field.key}: unknown trigger ${trigger}.`);
  const fields = new Map(catalogue.conditionFields.map(f => [f.id, f]));
  for (const legacy of catalogue.legacyEvents ?? []) {
    if (!triggers.has(legacy.trigger)) problems.push(`Legacy event ${legacy.event}: unknown trigger ${legacy.trigger}.`);
    for (const preset of legacy.preset ?? []) { const field = fields.get(preset.field); if (!field) problems.push(`Legacy event ${legacy.event}: unknown condition field ${preset.field}.`); else if (field.triggers && !field.triggers.includes(legacy.trigger)) problems.push(`Legacy event ${legacy.event}: ${preset.field} is not available for ${legacy.trigger}.`); }
  }
  return problems;
}
