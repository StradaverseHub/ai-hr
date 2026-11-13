/** Board 4a60b3ec: workflow email recipient roles. Pure; shared by the model, validation, picker and service. */
import { personnelField } from './personnel-field-registry';
import { v9LiteralAddress } from './lifecycle-v9-recipient';
import type { Module, Role } from './lifecycle-v9-model';

/** The Personnel Management field names, so the brackets follow PM if it renames them. */
const pmLabel = (id: string, fallback: string) => personnelField(id)?.label ?? fallback;
export const workEmailLabel = () => pmLabel('profile.contact_and_permanent_address.primaryemail', 'Work email');
export const personalEmailLabel = () => pmLabel('profile.contact_and_permanent_address.personalemail', 'Personal email');

/** Offered for new choices, in this order. TA exists only on onboarding cases. GBS People Ops is the group chosen in
 * Settings and stays a normal recipient (reporter's answer on 4a60b3ec); only PBP and Whoever started it are removed. */
export const offeredRoles = (module: Module): Role[] =>
  ['employeeWork', 'employeePersonal', 'supervisor', ...(module === 'onb' ? ['ta' as const] : []), 'peopleOps', 'taskOwners', 'hrSignatory'];
/** Saved before 4a60b3ec. They still resolve as they always did, but cannot be added again. */
export const removedRoles = ['pbp', 'starter'] as const;
export type RemovedRole = typeof removedRoles[number];
/** The former single Employee choice (the login account). Converted to work/personal email; never offered. */
export const legacyEmployeeRole = 'employee' as const;
export const MAX_RECIPIENT_CHOICES = 8;

export function isRemovedRole(role: string): role is RemovedRole { return (removedRoles as readonly string[]).includes(role); }
export function roleLabel(role: Role, names: { group?: (id: string) => string | undefined; person?: (id: string) => string | undefined } = {}): string {
  if (role.startsWith('address:')) return v9LiteralAddress(role) ?? 'Invalid email address';
  if (role.startsWith('group:')) return names.group?.(role.slice(6)) ?? 'Unavailable group';
  if (role.startsWith('person:')) return names.person?.(role.slice(7)) ?? 'Unavailable person';
  const fixed: Record<string, string> = {
    employeeWork: `Employee (${workEmailLabel()})`, employeePersonal: `Employee (${personalEmailLabel()})`,
    employee: 'Employee (login account)', supervisor: 'Line manager', ta: 'TA', taskOwners: 'Task owners', hrSignatory: 'HR signatory',
    pbp: 'PBP', peopleOps: 'GBS People Ops', starter: 'Whoever started it',
  };
  return fixed[role] ?? 'Unavailable recipient';
}
export const toRoles = (to: Role | Role[]): Role[] => Array.isArray(to) ? to : [to];
/** Roles that need replacing before a saved step or template may change or go live again. */
export function replaceableRoles(roles: readonly Role[]): RemovedRole[] { return [...new Set(roles.filter(isRemovedRole))]; }

/** Validation for a new or changed recipient list. Saved removed roles may stay only where they already were. */
export function recipientListProblems(list: readonly Role[], module: Module, kept: readonly Role[] = [], what = 'recipients'): string[] {
  const problems: string[] = [];
  if (list.length > MAX_RECIPIENT_CHOICES) problems.push(`Choose at most ${MAX_RECIPIENT_CHOICES} ${what}.`);
  if (new Set(list).size !== list.length) problems.push(`Choose each of the ${what} once.`);
  for (const role of list) {
    if (isRemovedRole(role) && !kept.includes(role)) problems.push(`${roleLabel(role)} can no longer be chosen. Choose another recipient.`);
    if (role === 'ta' && module !== 'onb' && !kept.includes(role)) problems.push('TA is only available for onboarding.');
  }
  return problems;
}

/** Mask everything but the first character of the mailbox and the domain, e.g. a•••••@gmail.com. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••••';
  return email[0] + '•••••' + email.slice(at);
}

type ConfigLike = { workflows: { id: string; name: string; module: Module; status: string; trigger: { event: string }; steps: ({ id: string; type: string; to?: Role | Role[]; cc?: Role[]; recipientReview?: true })[] }[]; emails: { id: string; name: string; module: Module; cc: Role[]; recipientReview?: true }[] };
export type RecipientChange = { kind: 'workflow' | 'email'; id: string; name: string; stepId?: string; before: Role[]; after: Role[] };
/** Employee choices that run before the join date reach the personal email; new joiners rarely have a work email yet. */
export const preStartWorkflow = (workflow: { module: Module; trigger: { event: string } }) => workflow.module === 'onb' && ['beforeJoin', 'submitted'].includes(workflow.trigger.event);
/** One-off conversion of saved Employee choices, flagging each changed step and template for HR to check.
 * Removed roles are not converted: they stay and are flagged "Replace recipient". Returns a new value. */
export function convertV9Recipients<T extends ConfigLike>(config: T): { config: T; changes: RecipientChange[] } {
  const next = structuredClone(config), changes: RecipientChange[] = [];
  const swap = (roles: Role[], replacement: Role) => { const out: Role[] = []; for (const role of roles) { const value = role === legacyEmployeeRole ? replacement : role; if (!out.includes(value)) out.push(value); } return out; };
  for (const workflow of next.workflows) for (const step of workflow.steps) {
    if (step.to === undefined || !step.cc) continue;
    const before = [...toRoles(step.to), ...step.cc];
    if (!before.includes(legacyEmployeeRole)) continue;
    const replacement: Role = preStartWorkflow(workflow) ? 'employeePersonal' : 'employeeWork';
    const to = swap(toRoles(step.to), replacement);
    step.to = Array.isArray(step.to) ? to : to[0]; step.cc = swap(step.cc, replacement).filter(role => !to.includes(role)); step.recipientReview = true;
    changes.push({ kind: 'workflow', id: workflow.id, name: workflow.name, stepId: step.id, before, after: [...to, ...step.cc] });
  }
  for (const email of next.emails) {
    if (!email.cc.includes(legacyEmployeeRole)) continue;
    const before = [...email.cc];
    email.cc = swap(email.cc, 'employeeWork'); email.recipientReview = true;
    changes.push({ kind: 'email', id: email.id, name: email.name, before, after: [...email.cc] });
  }
  return { config: next, changes };
}
export type RecipientReportRow = { kind: 'workflow' | 'email'; id: string; name: string; module: Module; status?: string; stepId?: string; roles: Role[]; action: 'replace' | 'converted' | 'information' };
/** Pre-release report: every workflow and template using PBP, Whoever started it or Employee; TA for information. */
export function v9RecipientReport(config: ConfigLike): RecipientReportRow[] {
  const rows: RecipientReportRow[] = [];
  const classify = (roles: Role[]): RecipientReportRow['action'] | null => roles.some(isRemovedRole) ? 'replace' : roles.includes(legacyEmployeeRole) ? 'converted' : roles.includes('ta') ? 'information' : null;
  for (const workflow of config.workflows) for (const step of workflow.steps) {
    if (step.to === undefined || !step.cc) continue;
    const roles = [...toRoles(step.to), ...step.cc], action = classify(roles);
    if (action) rows.push({ kind: 'workflow', id: workflow.id, name: workflow.name, module: workflow.module, status: workflow.status, stepId: step.id, roles: roles.filter(role => isRemovedRole(role) || role === legacyEmployeeRole || role === 'ta'), action });
  }
  for (const email of config.emails) { const action = classify(email.cc); if (action) rows.push({ kind: 'email', id: email.id, name: email.name, module: email.module, roles: email.cc.filter(role => isRemovedRole(role) || role === legacyEmployeeRole || role === 'ta'), action }); }
  return rows;
}
