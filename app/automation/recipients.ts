/** Client-safe helpers shared by the HR Automation screens. Pure. */
import type {AutomationModuleCatalogue,AutomationTriggerSpec} from '@/lib/automation/catalogue';
import {describeAutomationCondition} from '@/lib/automation/conditions';
import type {AutomationRecipient,AutomationWorkflow} from '@/lib/automation/workflow';

export type NamedOption = { id: string; name: string };
export type RecipientChoices = { routings: readonly (NamedOption & { retired?: boolean })[]; groups: readonly NamedOption[]; people: readonly NamedOption[] };

/** One string per recipient, for multi-select values: role:employee, routing:<id>, group:<id>, person:<id>, pending. */
export function recipientKey(recipient: AutomationRecipient): string {
  switch (recipient.kind) {
    case 'role': return 'role:' + recipient.role;
    case 'routing': return 'routing:' + recipient.routingId;
    case 'group': return 'group:' + recipient.groupId;
    case 'person': return 'person:' + recipient.userId;
    case 'pending': return 'pending';
  }
}
export function recipientFromKey(key: string): AutomationRecipient | null {
  if (key === 'pending') return { kind: 'pending' };
  const at = key.indexOf(':'), kind = key.slice(0, at), value = key.slice(at + 1);
  if (at < 1 || !value) return null;
  if (kind === 'role') return { kind: 'role', role: value };
  if (kind === 'routing') return { kind: 'routing', routingId: value };
  if (kind === 'group') return { kind: 'group', groupId: value };
  if (kind === 'person') return { kind: 'person', userId: value };
  return null;
}
export const recipientsFromKeys = (keys: readonly string[]) => keys.flatMap(key => { const r = recipientFromKey(key); return r ? [r] : []; });

/** The To/CC choices a module offers: its roles, whoever's step is pending, live routings, groups and named people. */
export function recipientOptions(catalogue: AutomationModuleCatalogue, choices: RecipientChoices, labels: { routing: (name: string) => string; group: (name: string) => string }) {
  const kinds = new Set(catalogue.recipients.map(r => r.kind));
  return [
    ...catalogue.recipients.filter(r => r.kind === 'role').map(r => ({ value: 'role:' + r.id, label: r.label })),
    ...catalogue.recipients.filter(r => r.kind === 'pending').map(r => ({ value: 'pending', label: r.label })),
    ...(kinds.has('routing') ? choices.routings.filter(r => !r.retired).map(r => ({ value: 'routing:' + r.id, label: labels.routing(r.name) })) : []),
    ...(kinds.has('group') ? choices.groups.map(g => ({ value: 'group:' + g.id, label: labels.group(g.name) })) : []),
    ...(kinds.has('person') ? choices.people.map(p => ({ value: 'person:' + p.id, label: p.name })) : []),
  ];
}

const lowerFirst = (text: string) => text ? text[0].toLowerCase() + text.slice(1) : text;
/** "When the probation outcome is decided", "7 days before a review due date, then every morning". */
export function triggerText(trigger: AutomationTriggerSpec | undefined, value: AutomationWorkflow['trigger']): string {
  if (!trigger) return 'No trigger chosen';
  if (!trigger.dated) return 'When ' + lowerFirst(trigger.label);
  const unit = value.workdays ? (value.days === 1 ? 'working day' : 'working days') : (value.days === 1 ? 'day' : 'days');
  const when = /^Days\s+/i.test(trigger.label) ? lowerFirst(trigger.label.replace(/^Days\s+/i, '')) : `${trigger.dated.direction} ${lowerFirst(trigger.label)}`;
  return `${value.days} ${unit} ${when}${value.repeat ? ', then every morning' : ''}`;
}
/** The one-line list summary: "When … · if … · Generate a document → Send an email". */
export function workflowSummary(workflow: AutomationWorkflow, catalogue: AutomationModuleCatalogue): string {
  const trigger = catalogue.triggers.find(t => t.id === workflow.trigger.event);
  const label = (field: string) => catalogue.conditionFields.find(f => f.id === field)?.label ?? field;
  const conditions = workflow.conditions.length ? ' · if ' + workflow.conditions.map(c => describeAutomationCondition(c, label)).join(' and ') : '';
  const steps = workflow.steps.length > 3 ? `${workflow.steps.length} steps` : workflow.steps.map(s => catalogue.stepTypes.find(x => x.id === s.type)?.label ?? s.type).join(' → ') || 'No steps yet';
  return triggerText(trigger, workflow.trigger) + conditions + ' · ' + steps;
}
/**
 * The prototype list row's two lines (lane M3): "When … · if … · 3 steps" (the trigger) and the step chain
 * "Generate a document → Send an email" (muted). Same facts as workflowSummary.
 */
export function workflowListLines(workflow: AutomationWorkflow, catalogue: AutomationModuleCatalogue): { trigger: string; steps: string } {
  const trigger = catalogue.triggers.find(t => t.id === workflow.trigger.event);
  const label = (field: string) => catalogue.conditionFields.find(f => f.id === field)?.label ?? field;
  const conditions = workflow.conditions.length ? ' · if ' + workflow.conditions.map(c => describeAutomationCondition(c, label)).join(' and ') : '';
  const count = workflow.steps.length === 1 ? '1 step' : `${workflow.steps.length} steps`;
  const steps = workflow.steps.map(s => catalogue.stepTypes.find(x => x.id === s.type)?.label ?? s.type).join(' → ') || 'No steps yet';
  return { trigger: triggerText(trigger, workflow.trigger) + conditions + ' · ' + count, steps };
}
