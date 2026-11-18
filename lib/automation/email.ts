/**
 * Shared email templates and the Probation step settings the shared builder edits
 * (ADR 2026-11-15-probation-shared-automation, build step 3; handoff A1/A2; migration 5743).
 *
 * An email template holds the words (subject, body with `{{merge.field}}` tokens) and extra CC recipients; a workflow
 * decides when it is sent. Templates are reusable by every workflow of their module, so a merge token is checked
 * against everything the module can supply, not one trigger; the workflow editor warns per trigger.
 *
 * Turning a template off (`active: false`) is not deleting it: a Send email step that names an inactive template is
 * skipped and the skip is noted on the case; nothing else in the run changes (runtime: the Probation execution slice).
 * Retiring is final and the template can no longer be chosen.
 *
 * Step settings (`params`) belong to the module that executes them (lib/automation/workflow.ts). These checks are the
 * Probation builder's: they never relax the shared envelope's problems and only add to them. Pure, dependency-free.
 */
import type {AutomationModule,AutomationModuleCatalogue} from './catalogue';
import type {AutomationRecipient,AutomationReferences,AutomationWorkflow} from './workflow';

export type AutomationEmailTemplate = {
  id: string; module: AutomationModule; name: string; active: boolean;
  subject: string; body: string;
  /** Always copied, in addition to the step's own CC list. */
  cc: AutomationRecipient[];
  /** Additive rich editor content; the canonical template and revision remain unchanged. */
  definition?: import('./probation-email-definition').ProbationEmailDefinition;
};
export const MAX_EMAIL_NAME = 200;
export const MAX_EMAIL_SUBJECT = 500;
export const MAX_EMAIL_BODY = 20000;
export const MAX_EMAIL_CC = 20;
const MERGE_TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Merge field keys used in a text, in order of first use. */
export function automationMergeTokens(text: string): string[] {
  return [...new Set([...text.matchAll(MERGE_TOKEN)].map(match => match[1]))];
}

function recipientListProblems(where: string, list: readonly AutomationRecipient[], catalogue: AutomationModuleCatalogue, refs: AutomationReferences): string[] {
  const problems: string[] = [];
  const kinds = new Set(catalogue.recipients.map(r => r.kind)), roles = new Set(catalogue.recipients.filter(r => r.kind === 'role').map(r => r.id));
  if (list.length > MAX_EMAIL_CC) problems.push(`${where}: choose at most ${MAX_EMAIL_CC} recipients.`);
  for (const r of list) {
    if (!kinds.has(r.kind)) { problems.push(`${where}: this module cannot send to that kind of recipient.`); continue; }
    if (r.kind === 'role' && !roles.has(r.role)) problems.push(`${where}: unknown recipient ${r.role}.`);
    if (r.kind === 'routing' && !refs.routingExists(r.routingId)) problems.push(`${where}: a chosen routing no longer exists.`);
    if (r.kind === 'group' && !refs.groupExists(r.groupId)) problems.push(`${where}: a chosen assignment group no longer exists.`);
    if (r.kind === 'person' && !refs.personExists(r.userId)) problems.push(`${where}: a chosen person can no longer be found.`);
  }
  return problems;
}

/** Blocking problems for saving a template. Empty means valid. */
export function automationEmailTemplateProblems(template: AutomationEmailTemplate, catalogue: AutomationModuleCatalogue, refs: AutomationReferences): string[] {
  const problems: string[] = [];
  if (template.module !== catalogue.module) problems.push('This template belongs to another module.');
  if (!template.name.trim()) problems.push('Name this email template.');
  if (template.name.length > MAX_EMAIL_NAME) problems.push(`Use a name of at most ${MAX_EMAIL_NAME} characters.`);
  if (!template.subject.trim()) problems.push('Write a subject.');
  if (template.subject.length > MAX_EMAIL_SUBJECT) problems.push(`Use a subject of at most ${MAX_EMAIL_SUBJECT} characters.`);
  if (template.body.length > MAX_EMAIL_BODY) problems.push(`Use a message of at most ${MAX_EMAIL_BODY} characters.`);
  problems.push(...recipientListProblems('CC', template.cc, catalogue, refs));
  return problems;
}

/** Non-blocking: merge fields the module never supplies. They are left as typed when the email is sent. */
export function automationEmailMergeWarnings(template: Pick<AutomationEmailTemplate, 'subject' | 'body'>, catalogue: AutomationModuleCatalogue): string[] {
  const known = new Set(catalogue.mergeFields.map(field => field.key));
  return automationMergeTokens(template.subject + '\n' + template.body).filter(key => !known.has(key)).map(key => `{{${key}}} is not a merge field of this module and will stay as typed.`);
}

/** Fills merge tokens for a preview. Unknown or empty values stay visible as the token. */
export function fillAutomationMergeFields(text: string, values: Readonly<Record<string, string | null | undefined>>): string {
  return text.replace(MERGE_TOKEN, (token, key: string) => { const value = values[key]; return value ? value : token; });
}

/** Personnel Management event types a Probation "Create posting" step can log (handoff A4, decision 4). */
export const PROBATION_POSTING_EVENTS = ['Confirmation', 'Probation Extension'] as const;
export type ProbationPostingEvent = typeof PROBATION_POSTING_EVENTS[number];

/** What the Probation step settings can be checked against. `letterTemplateIds: null` means the list was not read. */
export type ProbationStepReferences = {
  emailTemplates: readonly { id: string; name: string; active: boolean; retired: boolean }[];
  letterTemplateIds: readonly string[] | null;
};

const text = (value: unknown) => typeof value === 'string' ? value : '';

/** Blocking problems in Probation step settings. "Make it live" is refused while any exist. */
export function probationStepParamProblems(workflow: AutomationWorkflow, refs: ProbationStepReferences): string[] {
  const problems: string[] = [];
  if (workflow.module !== 'probation') return problems;
  const emails = new Map(refs.emailTemplates.map(t => [t.id, t]));
  workflow.steps.forEach((step, i) => {
    const at = `Step ${i + 1}: `;
    if (step.type === 'sendEmail') {
      const id = text(step.params.emailTemplateId), template = emails.get(id);
      if (!id) problems.push(at + 'choose an email template.');
      else if (!template || template.retired) problems.push(at + 'the chosen email template no longer exists.');
      if (!step.to.length) problems.push(at + 'choose who receives the email.');
    }
    if (step.type === 'generateDocument') {
      const id = text(step.params.letterTemplateId);
      if (!id) problems.push(at + 'choose a letter template.');
      else if (refs.letterTemplateIds && !refs.letterTemplateIds.includes(id)) problems.push(at + 'the chosen letter template no longer exists.');
    }
    if (step.type === 'createPosting' && !(PROBATION_POSTING_EVENTS as readonly string[]).includes(text(step.params.eventType))) problems.push(at + 'choose the event type for the posting.');
    if (step.type === 'notify') {
      if (!text(step.params.subject).trim()) problems.push(at + 'write a subject.');
      if (!step.to.length) problems.push(at + 'choose who is notified.');
    }
  });
  return problems;
}

/** Non-blocking notes about Probation step settings. */
export function probationStepParamWarnings(workflow: AutomationWorkflow, refs: ProbationStepReferences): string[] {
  const warnings: string[] = [];
  if (workflow.module !== 'probation') return warnings;
  const emails = new Map(refs.emailTemplates.map(t => [t.id, t]));
  workflow.steps.forEach((step, i) => {
    const template = step.type === 'sendEmail' ? emails.get(text(step.params.emailTemplateId)) : undefined;
    if (template && !template.retired && !template.active) warnings.push(`Step ${i + 1}: the email template “${template.name}” is turned off, so this step is skipped and noted on the case.`);
  });
  return warnings;
}
