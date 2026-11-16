/**
 * Moving a notify-only Probation workflow (lib/probation-workflow.ts) onto the shared engine, exactly (lane G2; ADR
 * 2026-11-15-probation-shared-automation decision 2). Pure: the administrator action (core/probation-workflow-move.ts)
 * stores the result and stops the old definition firing (migration 5757).
 *
 * A definition converts only when the catalogue marks its event `exact` (proved by
 * test/probation-legacy-conversion-db.test.ts) and every part of it has an exact shared form:
 *  - trigger and preset conditions from the catalogue's `legacyEvents` (dated triggers with their proven `days`);
 *  - the company it was published for becomes a Company condition; a Part condition and a Grade condition carry over;
 *    business group, business unit and department conditions stay on the old engine (they compare the old organisation
 *    mapping's identities, which the shared facts do not promise to equal);
 *  - recipients: on events the old engine sent only to pending parties, each role becomes "whoever's step is pending"
 *    narrowed to that role; otherwise the case's own holder of that role, keeping only the roles the event ever reached;
 *  - {{tokens}} become the shared merge fields that carry the same words;
 *  - each step is a Notify step marked `legacy` (no fallback group; empty words blank), as the old engine sent it.
 * Anything else stays on the old engine with the reason shown to the administrator.
 */
import type {AutomationWorkflow,AutomationStep,AutomationRecipient} from './workflow';
import type {AutomationCondition} from './conditions';
import {PROBATION_AUTOMATION_CATALOGUE,PROBATION_LEGACY_MERGE_FIELDS,PROBATION_LEGACY_PENDING_RECIPIENTS,PROBATION_LEGACY_RECIPIENTS,PROBATION_PART_LABELS} from './catalogues/probation';
import type {ProbationWorkflow} from '../probation-workflow';

export type ProbationLegacyConversion = {ok: true; workflow: AutomationWorkflow} | {ok: false; reason: string};
type LegacyRole = keyof typeof PROBATION_LEGACY_RECIPIENTS;
const ROLES: readonly LegacyRole[] = ['employee', 'lm', 'hod', 'pbp', 'gbs'];

function convertText(text: string): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, key: string) => {
    const target = PROBATION_LEGACY_MERGE_FIELDS[key.trim() as keyof typeof PROBATION_LEGACY_MERGE_FIELDS];
    return target ? `{{${target}}}` : token;
  });
}

/** Converts one published notify-only definition, or says why it stays on the old engine. */
export function convertProbationLegacyWorkflow(definition: ProbationWorkflow, input: {workflowId: string; companyId: string}): ProbationLegacyConversion {
  const mapping = PROBATION_AUTOMATION_CATALOGUE.legacyEvents?.find(e => e.event === definition.trigger?.event);
  if (!mapping) return {ok: false, reason: 'Its event has no shared trigger.'};
  if (!mapping.exact) return {ok: false, reason: mapping.note ?? 'Its event has no exact shared trigger yet.'};
  const c = definition.conditions ?? {};
  if (c.businessGroupId || c.businessUnitId || c.departmentId) return {ok: false, reason: 'It is limited to a business group, business unit or department of the old organisation mapping.'};
  if (c.part !== undefined && ![1, 2, 3].includes(c.part)) return {ok: false, reason: 'Its Part condition is not one of Part 1, 2 or 3.'};
  if (!definition.steps?.length || definition.steps.some(step => step.type !== 'notify')) return {ok: false, reason: 'It has a step that is not a notification.'};
  for (const step of definition.steps) for (const value of [step.subject, step.body]) for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g))
    if (!(match[1].trim() in PROBATION_LEGACY_MERGE_FIELDS)) return {ok: false, reason: `It uses {{${match[1].trim()}}}, which the old engine never filled.`};
  const allowed = mapping.roles as readonly string[] | undefined;
  if (mapping.event === 'letter_release_pending' && definition.steps.some(step => step.to.includes('gbs')))
    return {ok: false, reason: mapping.note ?? 'GBS People Ops received it only for some outcomes.'};
  const recipients = (to: readonly string[]): AutomationRecipient[] => ROLES.filter(role => to.includes(role) && (!allowed || allowed.includes(role)))
    .map(role => ({kind: 'role' as const, role: mapping.pending ? PROBATION_LEGACY_PENDING_RECIPIENTS[role] : PROBATION_LEGACY_RECIPIENTS[role]}));
  const steps: AutomationStep[] = definition.steps.map(step => ({
    id: step.id, type: 'notify', conditions: [], to: recipients(step.to), cc: [],
    params: {subject: convertText(step.subject), body: convertText(step.body), legacy: true},
  }));
  if (steps.some(step => !step.to.length)) return {ok: false, reason: 'A step names only people this event never reached.'};
  const conditions: AutomationCondition[] = [{field: 'company', op: 'is', values: [input.companyId]}, ...(mapping.preset ?? []).map(p => ({field: p.field, op: p.op, values: [...p.values]}))];
  if (c.part) conditions.push({field: 'part', op: 'is', values: [PROBATION_PART_LABELS[c.part - 1]]});
  if (c.grade) conditions.push({field: 'jobGrade', op: 'is', values: [c.grade]});
  const field = (id: string) => PROBATION_AUTOMATION_CATALOGUE.conditionFields.find(f => f.id === id);
  // A Part condition on an event that has no part (letters) would never match: keep such a definition where it is.
  if (conditions.some(condition => field(condition.field)?.triggers && !field(condition.field)!.triggers!.includes(mapping.trigger))) return {ok: false, reason: 'Its Part condition does not apply to this event.'};
  return {ok: true, workflow: {
    id: input.workflowId, module: 'probation', name: definition.name.trim().slice(0, 200) || 'Moved Probation workflow',
    description: `Moved from the Probation workflow “${definition.name}”.${definition.description ? ' ' + definition.description : ''}`.slice(0, 2000),
    status: 'live', required: false,
    trigger: {event: mapping.trigger, days: mapping.days ?? 0, workdays: false, repeat: false}, skipWhen: 'never',
    conditions, steps,
  }};
}
