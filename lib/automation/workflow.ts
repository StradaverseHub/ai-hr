/**
 * The shared workflow definition, its save-time checks, Live/Paused, frozen run copies and the dry run
 * (ADR 2026-11-15-probation-shared-automation, build step 1; handoff A1).
 *
 * The envelope is module-neutral. What a trigger, condition field, step type or recipient means belongs to the module's
 * catalogue (`./catalogue`); step-specific settings (`params`) are checked by the module that executes them. Pure and
 * dependency-free: storage, authorization and execution stay with their owners.
 */
import {automationConditionProblems,evaluateAutomationConditions,type AutomationCondition,type AutomationConditionResult,type AutomationFactValue} from './conditions';
import {conditionFieldsForTrigger,mergeFieldsForTrigger,type AutomationModule,type AutomationModuleCatalogue} from './catalogue';

export type AutomationRecipient =
  | { kind: 'role'; role: string }
  | { kind: 'routing'; routingId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'person'; userId: string }
  | { kind: 'pending' };
export type AutomationStep = { id: string; type: string; conditions: AutomationCondition[]; to: AutomationRecipient[]; cc: AutomationRecipient[]; params: Record<string, unknown> };
export type AutomationTrigger = { event: string; days: number; workdays: boolean; repeat: boolean };
export type AutomationWorkflowStatus = 'live' | 'paused' | 'retired';
export type AutomationWorkflow = {
  id: string; module: AutomationModule; name: string; description: string;
  status: AutomationWorkflowStatus; required: boolean;
  trigger: AutomationTrigger; skipWhen: string;
  conditions: AutomationCondition[]; steps: AutomationStep[];
};
/** What the editor can check against: existing routings, groups and people. */
export type AutomationReferences = { routingExists: (id: string) => boolean; groupExists: (id: string) => boolean; personExists: (id: string) => boolean };

export const MAX_WORKFLOW_STEPS = 40;
export const MAX_WORKFLOW_CONDITIONS = 20;
export const MAX_STEP_RECIPIENTS = 20;
export const MAX_TRIGGER_DAYS = 3660;
const MERGE_TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

function recipientProblems(where: string, list: readonly AutomationRecipient[], catalogue: AutomationModuleCatalogue, refs: AutomationReferences): string[] {
  const problems: string[] = [];
  const kinds = new Set(catalogue.recipients.map(r => r.kind)), roles = new Set(catalogue.recipients.filter(r => r.kind === 'role').map(r => r.id));
  if (list.length > MAX_STEP_RECIPIENTS) problems.push(`${where}: choose at most ${MAX_STEP_RECIPIENTS} recipients.`);
  for (const r of list) {
    if (!kinds.has(r.kind)) { problems.push(`${where}: this module cannot send to ${r.kind === 'role' ? r.role : 'that kind of recipient'}.`); continue; }
    if (r.kind === 'role' && !roles.has(r.role)) problems.push(`${where}: unknown recipient ${r.role}.`);
    if (r.kind === 'routing' && !refs.routingExists(r.routingId)) problems.push(`${where}: a chosen routing no longer exists.`);
    if (r.kind === 'group' && !refs.groupExists(r.groupId)) problems.push(`${where}: a chosen assignment group no longer exists.`);
    if (r.kind === 'person' && !refs.personExists(r.userId)) problems.push(`${where}: a chosen person can no longer be found.`);
  }
  return problems;
}
function conditionListProblems(where: string, list: readonly AutomationCondition[], trigger: string, catalogue: AutomationModuleCatalogue): string[] {
  const problems: string[] = [];
  const available = new Map(conditionFieldsForTrigger(catalogue, trigger).map(f => [f.id, f]));
  const known = new Set(catalogue.conditionFields.map(f => f.id));
  if (list.length > MAX_WORKFLOW_CONDITIONS) problems.push(`${where}: use at most ${MAX_WORKFLOW_CONDITIONS} conditions.`);
  list.forEach((condition, i) => {
    const at = `${where} ${i + 1}: `;
    for (const p of automationConditionProblems(condition)) problems.push(at + p);
    const field = available.get(condition.field);
    if (!field) { if (condition.field.trim()) problems.push(at + (known.has(condition.field) ? 'this field is not available for the chosen trigger.' : 'unknown field.')); return; }
    if (!field.ops.includes(condition.op)) problems.push(at + 'this comparison is not available for this field.');
    if (field.values && (condition.op === 'is' || condition.op === 'isNot')) for (const v of condition.values) if (!field.values.includes(v)) problems.push(at + `“${v}” is not one of the choices.`);
  });
  return problems;
}

/** Blocking problems. "Make it live" is refused while any exist (handoff A1). */
export function automationWorkflowProblems(workflow: AutomationWorkflow, catalogue: AutomationModuleCatalogue, refs: AutomationReferences): string[] {
  const problems: string[] = [];
  if (workflow.module !== catalogue.module) problems.push('This workflow belongs to another module.');
  if (!workflow.name.trim()) problems.push('Name this workflow.');
  if (workflow.name.length > 200) problems.push('Use a name of at most 200 characters.');
  const trigger = catalogue.triggers.find(t => t.id === workflow.trigger.event);
  if (!trigger) problems.push('Choose what starts this workflow.');
  else if (trigger.dated) { if (!Number.isInteger(workflow.trigger.days) || workflow.trigger.days < 0 || workflow.trigger.days > MAX_TRIGGER_DAYS) problems.push(`Enter between 0 and ${MAX_TRIGGER_DAYS} days.`); }
  else if (workflow.trigger.days !== 0 || workflow.trigger.workdays || workflow.trigger.repeat) problems.push('Days, working days and repeat apply only to date-based triggers.');
  if (!catalogue.skipWhen.some(s => s.id === workflow.skipWhen)) problems.push('Choose when to skip.');
  problems.push(...conditionListProblems('Condition', workflow.conditions, workflow.trigger.event, catalogue));
  if (!workflow.steps.length) problems.push('Add at least one step.');
  if (workflow.steps.length > MAX_WORKFLOW_STEPS) problems.push(`Use at most ${MAX_WORKFLOW_STEPS} steps.`);
  const ids = new Set<string>();
  workflow.steps.forEach((step, i) => {
    const at = `Step ${i + 1}`;
    if (!step.id || ids.has(step.id)) problems.push(`${at}: each step needs its own id.`); ids.add(step.id);
    if (!catalogue.stepTypes.some(s => s.id === step.type)) problems.push(`${at}: this module has no ${step.type || 'such'} step.`);
    problems.push(...conditionListProblems(`${at} condition`, step.conditions, workflow.trigger.event, catalogue));
    problems.push(...recipientProblems(`${at} To`, step.to, catalogue, refs), ...recipientProblems(`${at} CC`, step.cc, catalogue, refs));
  });
  return problems;
}

/** Non-blocking: merge fields typed by hand that the trigger cannot supply. They are left as typed (handoff A1). */
export function automationMergeWarnings(workflow: AutomationWorkflow, catalogue: AutomationModuleCatalogue): string[] {
  const supplied = new Set(mergeFieldsForTrigger(catalogue, workflow.trigger.event).map(m => m.key)), warnings: string[] = [];
  workflow.steps.forEach((step, i) => {
    for (const value of Object.values(step.params)) if (typeof value === 'string') for (const match of value.matchAll(MERGE_TOKEN)) if (!supplied.has(match[1])) warnings.push(`Step ${i + 1}: {{${match[1]}}} cannot be filled for this trigger.`);
  });
  return [...new Set(warnings)];
}

/** Live/Paused is the primary action. Making a workflow live is refused while it has problems; pausing is always allowed. */
export function setAutomationWorkflowStatus(workflow: AutomationWorkflow, status: 'live' | 'paused', problems: readonly string[]): { ok: true; workflow: AutomationWorkflow } | { ok: false; reason: string } {
  if (workflow.status === 'retired') return { ok: false, reason: 'A retired workflow cannot run again.' };
  if (status === 'live' && problems.length) return { ok: false, reason: `Fix ${problems.length === 1 ? 'the problem' : `the ${problems.length} problems`} before making it live.` };
  return { ok: true, workflow: { ...workflow, status } };
}

/** The definition a run keeps. Editing or pausing the workflow afterwards never changes a run already started. */
export function freezeAutomationWorkflow(workflow: AutomationWorkflow): AutomationWorkflow {
  return structuredClone(workflow);
}

/** Adds days to an ISO date; with `workdays`, counts Monday to Friday only. Same arithmetic as V9 `addDays`. */
export function addAutomationDays(date: string, days: number, workdays: boolean): string {
  let time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  // A calendar date must round-trip: some engines roll "2026-02-30" over to 2 March instead of refusing it.
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date || !Number.isInteger(days) || Math.abs(days) > MAX_TRIGGER_DAYS) throw new RangeError('A valid date and day offset are required.');
  const DAY = 86_400_000;
  if (!workdays) time += days * DAY;
  else { let left = Math.abs(days); while (left) { time += Math.sign(days) * DAY; const weekday = new Date(time).getUTCDay(); if (weekday !== 0 && weekday !== 6) left--; } }
  return new Date(time).toISOString().slice(0, 10);
}

export type AutomationDryRunStep = { index: number; id: string; type: string; runs: boolean; conditions: AutomationConditionResult[]; to: string[]; cc: string[]; missing: string[] };
export type AutomationDryRun = {
  wouldRun: boolean; reason: string;
  /** For date-based triggers: the first day it runs, and whether it repeats every morning after that. */
  runDate: string | null; repeats: boolean;
  conditions: AutomationConditionResult[];
  steps: AutomationDryRunStep[];
  sends: false;
};
export type AutomationDryRunContext = {
  /** Case facts for the test case, already narrowed to what the viewer may see. */
  read: (field: string) => AutomationFactValue;
  /** The anchor date a dated trigger counts from (start date, review due date…), or null when the case has none. */
  anchor: (anchor: string) => string | null;
  /** The skip-when option that applies to this case right now, or null when none applies. */
  skipReason: (skipWhen: string) => string | null;
  /** Names a recipient for this case; `missing` when it resolves to nobody (the fallback group then applies). */
  resolve: (recipient: AutomationRecipient) => { names: string[]; missing: string | null };
};

/** What would happen for one test case. Nothing is sent or saved (handoff A1 "Dry run"). */
export function dryRunAutomationWorkflow(workflow: AutomationWorkflow, catalogue: AutomationModuleCatalogue, context: AutomationDryRunContext): AutomationDryRun {
  const trigger = catalogue.triggers.find(t => t.id === workflow.trigger.event);
  let runDate: string | null = null;
  const repeats = !!trigger?.dated && workflow.trigger.repeat;
  if (trigger?.dated) {
    const anchor = context.anchor(trigger.dated.anchor);
    if (anchor) runDate = addAutomationDays(anchor, trigger.dated.direction === 'after' ? workflow.trigger.days : -workflow.trigger.days, workflow.trigger.workdays);
  }
  const top = evaluateAutomationConditions(workflow.conditions, context.read);
  const skip = context.skipReason(workflow.skipWhen);
  const reason = !trigger ? 'No trigger is chosen.' : trigger.dated && !runDate ? 'This case has no date to count from.' : skip ? `Skipped: ${skip}` : !top.ok ? 'The conditions do not match this case.' : workflow.status !== 'live' ? 'It would match, but the workflow is not live.' : 'It would run for this case.';
  const wouldRun = !!trigger && !(trigger.dated && !runDate) && !skip && top.ok && workflow.status === 'live';
  const names = (list: readonly AutomationRecipient[]) => { const out: string[] = [], missing: string[] = []; for (const r of list) { const x = context.resolve(r); out.push(...x.names); if (x.missing) missing.push(x.missing); } return { out: [...new Set(out)], missing }; };
  const steps = workflow.steps.map((step, index) => {
    const own = evaluateAutomationConditions(step.conditions, context.read), to = names(step.to), cc = names(step.cc);
    return { index: index + 1, id: step.id, type: step.type, runs: own.ok, conditions: own.results, to: to.out, cc: cc.out, missing: [...to.missing, ...cc.missing] };
  });
  return { wouldRun, reason, runDate, repeats, conditions: top.results, steps, sends: false };
}
