import { MANAGED_EMAIL_ATTACHMENT_MAX_BYTES, MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT } from './managed-email-policy';
import { v9ImageTokens } from './lifecycle-v9-email-content';
/** V9 lifecycle rules. Services supply authorized identity, Personnel facts and final-pay snapshots. */
import { validV9SignatureValue } from './lifecycle-v9-signature';
import { isCalendarDate } from './calendar-date';
import type { SettlementPolicy, SettlementInput } from './lifecycle-v9-calculator';
export type Module = 'onb' | 'off';
export type ExitType = 'Resignation' | 'Termination' | 'Contract end' | 'Retirement' | 'Non-confirmation';
export type CaseState = 'pending' | 'submitted' | 'cleared' | 'cancelled';
export type RuleField = 'businessGroup' | 'company' | 'department' | 'grade' | 'employmentType' | 'title' | 'caseType';
export type Rules = Partial<Record<RuleField, string[]>>;
export type Facts = Record<RuleField, string> & {
  name: string; employeeNo: string; employmentId: string; personId: string;
  joinDate: string; lastDay: string; noticeDate: string;
  employeeUserId: string | null; supervisorUserId: string | null; pbpUserId: string | null; taUserId: string | null;
};
export type Actor = { id: string; name: string };
export type Log = { id: string; at: string; actor: Actor; action: string; detail: string; userId?: string; groupId?: string };
export type Group = { id: string; name: string; members: string[]; limit: number };
export type TaskDefinition = {
  id: string; name: string; by: 'group' | 'manager' | 'employee'; group: string | null;
  mode: 'rr' | 'manual'; opens: number | null; due: number; required: boolean;
  documentTemplate: string | null; documentAction: 'completed' | 'signed' | 'sent';
};
export type Checklist = { id: string; name: string; module: Module; rules: Rules; tasks: TaskDefinition[]; ownerUserId?: string; createdAt?: string };
export type Task = TaskDefinition & {
  opensOn: string | null; dueOn: string; assignee: string | null;
  status: 'todo' | 'progress' | 'done' | 'notNeeded'; reason: string; assignmentFailure: string | null;
};
export type Item = {
  id: string; name: string; kind: 'system' | 'device'; sourceId: string | null;
  group: string | null; assignee: string | null; dueOn: string;
  status: 'todo' | 'progress' | 'done' | 'notReturned' | 'notNeeded'; reason: string;
};
export type Field = {
  id: string; label: string; type: 'text' | 'textarea' | 'select' | 'date' | 'checkbox' | 'phone' | 'email' | 'number' | 'table';
  owner: 'employee' | 'hr' | 'pmLocked'; pmKey: string | null; required: boolean;
  sensitive: boolean; options: string[]; section: string;
  width?: 'half' | 'full'; columns?: string[];
  when: { field: string; value: string } | null;
};
export type Block = { id: string; type: 'letterhead' | 'heading' | 'subheading' | 'text' | 'fields' | 'field' | 'table' | 'signature'; text: string; section: string; fieldId?: string; columns?: string; rows?: string; role?: string; label?: string };
export type TemplateVersion = { version: number; state: 'draft' | 'published'; at: string; by: string; blocks: Block[]; fields: Field[] };
export type Template = {
  id: string; name: string; module: Module; type: 'Form' | 'Letter' | 'Acknowledgement' | 'Attachment';
  rules: Rules; hrStep: 'none' | 'before' | 'after'; employeeAck: boolean; retired: boolean;
  versions: TemplateVersion[]; currentVersion?: number; note?: string;
};
export type ConfigSaveReceipt = { revision: number; groupsRevision: number; versionStamps?: { templateId: string; version: number; state: TemplateVersion['state']; at: string; by: string }[] };
export type Signature = { by: Actor; at: string; method: 'typed' | 'drawn'; value: string; consent: true };
export type Document = {
  id: string; templateId: string; version: number; name: string;
  status: 'draft' | 'sent' | 'opened' | 'completed' | 'hrsigned' | 'countersign' | 'signed' | 'acknowledged' | 'superseded' | 'withdrawn';
  blocks: Block[]; fields: Field[]; values: Record<string, string>; edits: Record<string, string>;
  hrSignature: Signature | null; employeeSignature: Signature | null; createdAt: string; sentAt: string | null;
  mergeValues?: Record<string, string>;
  hrStep?: Template['hrStep']; employeeAck?: boolean; signatoryUserId?: string | null; templateType?: Template['type'];
};
export type Role = 'employee' | 'supervisor' | 'pbp' | 'ta' | 'peopleOps' | 'taskOwners';
export type EmailAsset = { id: string; kind: 'file' | 'image'; name: string; mimeType: string; size: number; contentHash: string; at: string; by: string };
export type TemplateUsage = { templateId: string; version: number; documents: number };
export type EmailTemplate = {
  id: string; name: string; module: Module; active: boolean; sender: string;
  subject: string; body: string; cc: Role[]; links: string[]; attachments: string[];
  slots: { id: string; label: string; required: boolean }[]; files?: EmailAsset[]; images?: EmailAsset[];
};
export type Trigger = {
  event: 'submitted' | 'beforeJoin' | 'afterJoin' | 'beforeLWD'; days: number;
  workdays: boolean; repeat: boolean; skipIf: '' | 'noPre' | 'allDocsDone' | `task:${string}`;
};
export type Step =
  | { id: string; type: 'doc'; template: string; release: boolean }
  | { id: string; type: 'waitSign'; template: string; by: 'hr' | 'employee' }
  | { id: string; type: 'waitFile'; slot: string; label: string }
  | { id: string; type: 'email'; template: string; to: Role | Role[]; cc: Role[] }
  | { id: string; type: 'notify'; subject: string; body: string; to: Role | Role[]; cc: Role[] };
export type Workflow = {
  id: string; name: string; module: Module; status: 'draft' | 'published'; trigger: Trigger;
  conditions: { field: RuleField | 'joinWithin'; op: 'is' | 'isNot' | 'lt' | 'gte'; value: string }[];
  steps: Step[]; description: string;
};
/** Drafts can be incomplete. Activation must be safe and independently validated by the service. */
export function workflowProblems(workflow: Workflow, config: Pick<Config, 'templates' | 'emails'>): string[] {
  const problems: string[] = [];
  if (!workflow.name.trim()) problems.push('Give this workflow a name.');
  if (!workflow.steps.length) problems.push('Add at least one step.');
  for (const [i, step] of workflow.steps.entries()) {
    const prefix = `Step ${i + 1}: `;
    if ('template' in step) {
      const template = (step.type === 'email' ? config.emails : config.templates).find(t => t.id === step.template && t.module === workflow.module);
      if (!template) problems.push(prefix + 'choose a template in the same module.');
      else if ('versions' in template && !template.versions.some(v => v.state === 'published')) problems.push(prefix + 'choose a published document template.');
      else if (step.type === 'waitSign' && 'versions' in template && template.type === 'Attachment') problems.push(prefix + 'attachments do not require a signature.');
      else if ('active' in template && !template.active) problems.push(prefix + 'choose an active email template.');
    }
    if (step.type === 'waitFile' && !step.slot.trim()) problems.push(prefix + 'choose a file slot.');
    if (step.type === 'notify' && !step.subject.trim()) problems.push(prefix + 'add a subject.');
    if ('to' in step && !(Array.isArray(step.to) ? step.to.length : step.to)) problems.push(prefix + 'choose a recipient.');
  }
  for (const [i, condition] of workflow.conditions.entries()) if (!condition.value.trim() || condition.field === 'joinWithin' && !/^\d+$/.test(condition.value)) problems.push(`Condition ${i + 1}: choose a valid value.`);
  return problems;
}
export type Run = { id: string; workflowId: string; revision: number; date: string; status: 'running' | 'waiting' | 'done' | 'skipped' | 'failed'; cursor: number; reason: string; at: string; definition?: Workflow; actor?: Actor };
export type Mail = {
  id: string; key: string; workflowId: string | null; templateId: string | null;
  to: string[]; cc: string[]; subject: string; body: string; documentIds: string[];
  fileIds: string[]; status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled'; test: boolean;
  at: string; deliveredAt: string | null; failure: string | null;
  /** Frozen transport choices; older history without this must not be silently reinterpreted. */
  delivery?: { version: 1; queuedBy: Actor; sender: 'onboarding' | 'hr' | 'noreply'; linkDocumentIds: string[]; pdfDocumentIds: string[]; toNames: string[]; ccNames: string[]; assets?: EmailAsset[]; contact?: { kind: 'onboardingContact'; caseId: string; email: string; sourceRevision: string } };
};
export type PMChange = { id: string; documentId: string; field: string; before: string; after: string; status: 'proposed' | 'pushed' | 'conflict' | 'rejected'; sourceRevision: string };
export type FinalFigures = { sourceRevision: string; lastDay: string; leaveDays: string; amount: string; currency: string; payDate: string; lockedAt: string; payrollReference: string };
export type Case = {
  version: 9; id: string; number: string; module: Module; revision: number; state: CaseState;
  facts: Facts; checklistId: string | null; checklistName: string; override: 'automatic' | 'none' | string;
  tasks: Task[]; items: Item[]; documents: Document[]; runs: Run[]; mails: Mail[];
  files: { id: string; slot: string; name: string; storageId: string; contentHash?: string }[];
  pmChanges: PMChange[]; log: Log[]; sourceRevision: string;
  submittedAt: string | null; closedAt: string | null; closedBy: Actor | null; closeReason: string;
  cancelReason: string; revokeDate: string; finalFigures: FinalFigures | null;
  review: { firstAt: string; open: number; overdue: number; notReturned: number; detail: string } | null;
  emailEdits?: Record<string, { subject: string; body: string }>;
  settlementOptions?: Pick<SettlementInput, 'override' | 'keepSourceDate' | 'offsetLeave' | 'reduceEncashment'>;
};
export type Config = {
  version: 9; revision: number; checklists: Checklist[]; templates: Template[];
  groupsRevision?: number;
  emails: EmailTemplate[]; workflows: Workflow[]; groups: Group[]; peopleOpsGroup: string | null;
  bpRules: { rules: Pick<Rules, 'businessGroup' | 'company' | 'department'>; userId: string }[];
  settlementPolicy?: SettlementPolicy;
  companies?: { companyId: string; signatoryUserId: string | null; signatoryTitle: string }[];
};
export type Environment = {
  today: string; now: string; actor: Actor; nextId: () => string;
  onLeave: (userId: string, date: string) => boolean;
  openLoad: (userId: string, groupId: string) => number;
  lastAssigned: (userId: string, groupId: string) => number;
  /** Services reject identities without an authorized verified destination before delivery. */
  eligibleUser: (userId: string) => boolean;
  userName: (userId: string) => string;
  mergeValues: Record<string, string>;
  signatoryUserId?: string | null;
  /** Production workflows wait for the durable transport acknowledgement. */
  requireDeliveryAck?: boolean;
  /** A real Native onboarding contact; this is never an app-user identity or login grant. */
  onboardingContact?: { email: string; sourceRevision: string };
};

export class V9Error extends Error {
  constructor(message: string, readonly code: 'invalid' | 'forbidden' | 'conflict' | 'not_found' = 'invalid') { super(message); this.name = 'V9Error'; }
}
const DAY = 86400000;
export function validDate(value: string): boolean {
  return isCalendarDate(value);
}
export function addDays(value: string, days: number, workdays = false): string {
  if (!validDate(value) || !Number.isInteger(days) || Math.abs(days) > 3660) throw new V9Error('A valid date and day offset are required.');
  let time = Date.parse(`${value}T00:00:00Z`);
  if (!workdays) time += days * DAY;
  else { let left = Math.abs(days); while (left) { time += Math.sign(days) * DAY; const day = new Date(time).getUTCDay(); if (day !== 0 && day !== 6) left--; } }
  const result = new Date(time).toISOString().slice(0, 10);
  if (!validDate(result)) throw new V9Error('The resulting date is outside the supported calendar.');
  return result;
}
export function taskDate(module: Module, anchor: string, day: number): string {
  if (module === 'onb' && day === 0) throw new V9Error('Day 1 is the join date. Use negative days before joining.');
  return addDays(anchor, module === 'onb' && day > 0 ? day - 1 : day);
}
export function matches(rules: Rules, facts: Facts): boolean {
  return Object.entries(rules).every(([key, values]) => !values?.length || values.includes(facts[key as RuleField]));
}
export function specificity(rules: Rules): number { return Object.values(rules).filter(v => v?.length).length; }
export function matchChecklist(config: Config, c: Pick<Case, 'module' | 'facts' | 'override'>): { checklist: Checklist | null; tie: boolean } {
  const lists = config.checklists.filter(x => x.module === c.module);
  if (c.override === 'none') return { checklist: null, tie: false };
  if (c.override !== 'automatic') { const selected = lists.find(x => x.id === c.override); if (!selected) throw new V9Error('The selected checklist no longer exists.'); return { checklist: selected, tie: false }; }
  const ranked = lists.filter(x => matches(x.rules, c.facts)).map((x, index) => ({ x, index })).sort((a, b) => specificity(b.x.rules) - specificity(a.x.rules) || a.index - b.index);
  return { checklist: ranked[0]?.x ?? null, tie: ranked.length > 1 && specificity(ranked[0].x.rules) === specificity(ranked[1].x.rules) };
}
export function resolvePbp(config: Config, facts: Facts): string | null {
  if (facts.pbpUserId) return facts.pbpUserId;
  const score = (r: Rules) => (r.businessGroup?.length ? 4 : 0) + (r.company?.length ? 2 : 0) + (r.department?.length ? 1 : 0);
  return config.bpRules.filter(r => matches(r.rules, facts)).map((r, index) => ({ r, index })).sort((a, b) => score(b.r.rules) - score(a.r.rules) || a.index - b.index)[0]?.r.userId ?? null;
}
export function assign(config: Config, groupId: string | null, due: string, env: Environment, extra: Record<string, number>, tieBreak: 'recent' | 'memberOrder' = 'recent'): { userId: string | null; reason: string | null } {
  const group = config.groups.find(g => g.id === groupId);
  if (!group) return { userId: null, reason: 'Choose an assignment group.' };
  const members = [...new Set(group.members)].filter(env.eligibleUser);
  if (!members.length) return { userId: null, reason: `No eligible members in ${group.name}.` };
  const available = members.filter(id => !env.onLeave(id, due));
  if (!available.length) return { userId: null, reason: `Everyone in ${group.name} is on leave on ${due}.` };
  const ranked = available.map(id => ({ id, load: env.openLoad(id, group.id) + (extra[id] ?? 0) }))
    .filter(x => !group.limit || x.load < group.limit)
    .sort((a, b) => a.load - b.load || (tieBreak === 'recent' ? env.lastAssigned(a.id, group.id) - env.lastAssigned(b.id, group.id) : 0) || members.indexOf(a.id) - members.indexOf(b.id));
  return ranked.length ? { userId: ranked[0].id, reason: null } : { userId: null, reason: `Everyone available in ${group.name} is at their limit of ${group.limit} open tasks.` };
}
export function appendLog(c: Case, env: Environment, action: string, detail: string, assignment?: { userId: string; groupId: string }): void {
  c.log.push({ id: env.nextId(), at: env.now, actor: { ...env.actor }, action, detail, ...assignment });
}
export function submit(c: Case, config: Config, env: Environment): void {
  if (c.state !== 'pending') throw new V9Error('Only a pending case can be submitted.', 'conflict');
  const anchor = c.module === 'onb' ? c.facts.joinDate : c.facts.lastDay;
  if (!validDate(anchor) || !c.facts.name || !c.facts.employeeNo || !c.facts.employmentId || !c.facts.company) throw new V9Error('Complete the employee, employee ID, company and anchor date before submitting.');
  if (c.module === 'off' && !(['Resignation', 'Termination', 'Contract end', 'Retirement', 'Non-confirmation'] as string[]).includes(c.facts.caseType)) throw new V9Error('Choose the offboarding case type.');
  const selected = matchChecklist(config, c), extra: Record<string, number> = {};
  c.checklistId = selected.checklist?.id ?? null; c.checklistName = selected.checklist?.name ?? 'No checklist';
  c.tasks = (selected.checklist?.tasks ?? []).map(def => {
    const dueOn = taskDate(c.module, anchor, def.due), opensOn = def.opens === null ? null : taskDate(c.module, anchor, def.opens);
    if (opensOn && opensOn > dueOn) throw new V9Error(`Opens on cannot follow due by for ${def.name}.`);
    const owner = def.by === 'employee' ? { userId: c.facts.employeeUserId, reason: c.facts.employeeUserId ? null : 'Employee login is not linked.' }
      : def.by === 'manager' ? { userId: c.facts.supervisorUserId, reason: c.facts.supervisorUserId ? null : 'Line manager login is not linked.' }
      : def.mode === 'rr' ? assign(config, def.group, dueOn, env, extra, c.module === 'off' ? 'memberOrder' : 'recent') : { userId: null, reason: 'Manual assignment is required.' };
    if (owner.userId) extra[owner.userId] = (extra[owner.userId] ?? 0) + 1;
    return { ...structuredClone(def), dueOn, opensOn, assignee: owner.userId, assignmentFailure: owner.reason, status: 'todo' as const, reason: '' };
  });
  c.state = 'submitted'; c.submittedAt = env.now;
  appendLog(c, env, 'case.submitted', `Checklist confirmed: ${c.checklistName}.${selected.tie ? ' Equally specific matches; first display order selected.' : ''}`);
  for (const task of c.tasks) appendLog(c, env, 'task.assigned', `${task.name}: ${task.assignee ? env.userName(task.assignee) : task.assignmentFailure}`, task.assignee && task.group ? { userId: task.assignee, groupId: task.group } : undefined);
}
export function isResolved(status: Task['status'] | Item['status']): boolean { return status === 'done' || status === 'notNeeded'; }
export function work(c: Case) {
  const tasks = c.tasks.filter(t => t.status !== 'notNeeded'), items = c.items.filter(i => i.status !== 'notNeeded');
  const done = tasks.filter(t => t.status === 'done').length + items.filter(i => i.status === 'done' || i.status === 'notReturned').length;
  const total = tasks.length + items.length;
  return { done, total, percent: total ? Math.round(done * 100 / total) : 0,
    open: [...tasks, ...items].filter(t => !isResolved(t.status) && t.status !== 'notReturned'), notReturned: items.filter(i => i.status === 'notReturned') };
}
export function completeTask(c: Case, id: string, status: Task['status'], reason: string, env: Environment): void {
  if (!['todo', 'progress', 'done', 'notNeeded'].includes(status)) throw new V9Error('Choose a valid task status.');
  if (c.state !== 'submitted') throw new V9Error('This case is not open.', 'conflict');
  const task = c.tasks.find(t => t.id === id); if (!task) throw new V9Error('Task not found.', 'not_found');
  if (task.opensOn && task.opensOn > env.today && status !== 'notNeeded') throw new V9Error(`This task opens on ${task.opensOn}.`);
  if (status === 'notNeeded' && !reason.trim()) throw new V9Error('Add a reason why this task is not needed.');
  if (task.documentTemplate && status === 'done') throw new V9Error('Complete the linked document to finish this task.');
  task.status = status; task.reason = reason.trim(); appendLog(c, env, 'task.updated', `${task.name}: ${status}${reason ? ` · ${reason}` : ''}`);
}
export function merge(text: string, values: Record<string, string>, sensitive: ReadonlySet<string> = new Set()): { text: string; missing: string[] } {
  const missing: string[] = [];
  const result = text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}/g, (_, key: string) => {
    if (sensitive.has(key)) throw new V9Error('Sensitive fields cannot be included in an email.');
    if (values[key] !== undefined && values[key] !== '') return values[key];
    if (!missing.includes(key)) missing.push(key); return `[${key}]`;
  });
  return { text: result, missing };
}
export function currentVersion(template: Template): TemplateVersion | null {
  const published = template.versions.filter(v => v.state === 'published');
  return published.find(v => v.version === template.currentVersion) ?? published.sort((a, b) => b.version - a.version)[0] ?? null;
}
export function activeDocument(c: Case, templateId: string): Document | null { return c.documents.filter(d => d.templateId === templateId && d.status !== 'superseded' && d.status !== 'withdrawn').at(-1) ?? null; }
export function validateFieldValue(field: Field, value: string): void {
  if (value.length > 20000) throw new V9Error('A field exceeds the allowed length.');
  if (field.type === 'select' && value && !field.options.includes(value)) throw new V9Error(`Choose a valid option for ${field.label}.`);
  if (field.type === 'date' && value && !validDate(value)) throw new V9Error(`Enter a valid date for ${field.label}.`);
  if (field.type === 'checkbox' && value && !['true', 'false'].includes(value)) throw new V9Error(`Choose a valid value for ${field.label}.`);
  if (field.type === 'number' && value && !Number.isFinite(Number(value))) throw new V9Error(`Enter a valid number for ${field.label}.`);
  if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new V9Error(`Enter a valid email for ${field.label}.`);
  if (field.type === 'table' && value) {
    let rows: unknown; try { rows = JSON.parse(value); } catch { throw new V9Error(`Enter valid rows for ${field.label}.`); }
    if (!Array.isArray(rows) || rows.length > 50 || !rows.every(row => Array.isArray(row) && row.length === (field.columns?.length ?? 0) && row.every(cell => typeof cell === 'string' && cell.length <= 1000))) throw new V9Error(`Enter valid rows for ${field.label}.`);
  }
}
export function documentFinal(d: Document): boolean { return ['completed', 'signed', 'acknowledged'].includes(d.status) || d.templateType === 'Attachment' && ['sent', 'opened'].includes(d.status); }
export function generate(c: Case, config: Config, templateId: string, env: Environment): Document {
  const existing = activeDocument(c, templateId); if (existing) return existing;
  const template = config.templates.find(t => t.id === templateId && t.module === c.module);
  // As in the source opGenerate, an explicit workflow/email reference may retain a retired
  // or nonmatching template. Retirement only removes it from automatic applicability/pickers.
  if (!template) throw new V9Error('No document template is available for this module.');
  const version = currentVersion(template); if (!version) throw new V9Error('Publish the document template before using it.');
  const values: Record<string, string> = {};
  for (const field of version.fields) if (field.pmKey) values[field.id] = env.mergeValues[field.pmKey] ?? '';
  const doc: Document = { id: env.nextId(), templateId, version: version.version, name: template.name, status: 'draft', blocks: structuredClone(version.blocks), fields: structuredClone(version.fields), values, edits: {}, hrSignature: null, employeeSignature: null, createdAt: env.now, sentAt: null, mergeValues: { ...env.mergeValues }, templateType: template.type, hrStep: template.hrStep, employeeAck: template.employeeAck, signatoryUserId: env.signatoryUserId ?? null };
  c.documents.push(doc); appendLog(c, env, 'document.generated', `${doc.name} version ${doc.version}`); return doc;
}
function linkedTasks(c: Case, doc: Document, action: TaskDefinition['documentAction']): void {
  for (const task of c.tasks) if (task.documentTemplate === doc.templateId && (task.documentAction === action || task.documentAction === 'completed' && action === 'signed')) task.status = 'done';
}
export function documentDeliveryReserved(c: Pick<Case, 'mails'>, documentId: string): boolean {
  return c.mails.some(mail => !mail.test && ['pending', 'sending', 'uncertain'].includes(mail.status) && mail.documentIds.includes(documentId));
}
export function saveDocument(c: Case, id: string, values: Record<string, string>, owner: 'employee' | 'hr', env: Environment): void {
  const doc = c.documents.find(d => d.id === id); if (!doc) throw new V9Error('Document not found.', 'not_found');
  if (owner === 'employee' && doc.templateType === 'Attachment') throw new V9Error('Attachments are read-only PDFs.', 'forbidden');
  if (c.state !== 'submitted' || documentFinal(doc) || ['withdrawn', 'superseded'].includes(doc.status)) throw new V9Error('This document is no longer editable.', 'conflict');
  if (owner === 'hr' && doc.status !== 'draft') throw new V9Error('Released document fields are frozen. Prepare a new document to make this correction.', 'conflict');
  if (owner === 'hr' && documentDeliveryReserved(c, id)) throw new V9Error('This document is frozen for email delivery.', 'conflict');
  if (owner === 'hr' && (doc.hrSignature || doc.employeeSignature)) throw new V9Error('Signed document fields are frozen. Prepare a new document to make this correction.', 'conflict');
  if (owner === 'employee' && !['sent', 'opened'].includes(doc.status)) throw new V9Error('This document has not been released to you.');
  for (const [key, value] of Object.entries(values)) {
    const field = doc.fields.find(f => f.id === key); if (!field || field.owner !== owner) throw new V9Error('This field cannot be changed.', 'forbidden');
    validateFieldValue(field, value);
    doc.values[key] = value;
  }
  appendLog(c, env, 'document.saved', doc.name);
}
export function signDocument(c: Case, config: Config, id: string, role: 'employee' | 'hr', signature: Signature, env: Environment): void {
  const doc = c.documents.find(d => d.id === id), template = doc && config.templates.find(t => t.id === doc.templateId);
  if (!doc || !template) throw new V9Error('Document not found.', 'not_found');
  if ((doc.templateType ?? template.type) === 'Attachment') throw new V9Error('Attachments are read-only PDFs and do not require a signature.', 'conflict');
  const hrStep = doc.hrStep ?? template.hrStep, employeeAck = doc.employeeAck ?? template.employeeAck;
  if (c.state !== 'submitted' || ['superseded', 'withdrawn'].includes(doc.status)) throw new V9Error('This document is no longer open.', 'conflict');
  if (role === 'hr' && documentDeliveryReserved(c, id)) throw new V9Error('This document is frozen for email delivery.', 'conflict');
  if (!signature.consent || !validV9SignatureValue(signature.method, signature.value) || signature.by.id !== env.actor.id) throw new V9Error('Confirm consent and provide your own signature.');
  const missing = doc.blocks.filter(b => ['heading', 'subheading', 'text'].includes(b.type)).flatMap(b => merge(doc.edits[b.id] ?? b.text, { ...doc.mergeValues, ...doc.values }).missing);
  if (missing.length) throw new V9Error(`Complete missing document fields: ${[...new Set(missing)].join(', ')}.`);
  if (role === 'employee') {
    if (!['sent', 'opened'].includes(doc.status)) throw new V9Error('This document is not ready for employee completion.', 'conflict');
    for (const field of doc.fields) if (!field.when || doc.values[field.when.field] === field.when.value) {
      validateFieldValue(field, doc.values[field.id] ?? '');
      if (field.required && (!doc.values[field.id]?.trim() || field.type === 'checkbox' && doc.values[field.id] !== 'true' || field.type === 'table' && doc.values[field.id] === '[]')) throw new V9Error(`Complete ${field.label} before signing.`);
    }
    doc.employeeSignature = { ...signature, at: env.now, by: { ...env.actor } };
    doc.status = hrStep === 'after' ? 'countersign' : employeeAck ? 'acknowledged' : 'signed';
    for (const field of doc.fields) if (field.pmKey && field.owner === 'employee' && (!field.when || doc.values[field.when.field] === field.when.value) && (doc.values[field.id] ?? '') !== (doc.mergeValues?.[field.pmKey] ?? '') && !c.pmChanges.some(p => p.documentId === id && p.field === field.pmKey)) c.pmChanges.push({ id: env.nextId(), documentId: id, field: field.pmKey, before: doc.mergeValues?.[field.pmKey] ?? '', after: doc.values[field.id] ?? '', sourceRevision: c.sourceRevision, status: 'proposed' });
  } else {
    if (!doc.signatoryUserId || doc.signatoryUserId !== env.actor.id) throw new V9Error('Only the designated company HR signatory can sign this document.', 'forbidden');
    if (hrStep === 'before' && doc.status !== 'draft' || hrStep === 'after' && doc.status !== 'countersign' || hrStep === 'none') throw new V9Error('This document does not need an HR signature at this stage.', 'conflict');
    for (const field of doc.fields) if (field.owner !== 'employee' && (!field.when || doc.values[field.when.field] === field.when.value)) {
      const value = doc.values[field.id] ?? '';
      validateFieldValue(field, value);
      if (field.required && (!value.trim() || field.type === 'checkbox' && value !== 'true' || field.type === 'table' && value === '[]')) throw new V9Error(`Complete ${field.label} before signing.`);
    }
    doc.hrSignature = { ...signature, at: env.now, by: { ...env.actor } }; doc.status = hrStep === 'before' ? 'hrsigned' : 'signed';
  }
  if (documentFinal(doc)) linkedTasks(c, doc, 'signed'); appendLog(c, env, 'document.signed', `${doc.name} · ${role}`);
}
function recipients(c: Case, config: Config, role: Role): string[] {
  if (role === 'peopleOps') return config.groups.find(g => g.id === config.peopleOpsGroup)?.members ?? [];
  if (role === 'taskOwners') return [...new Set(pendingPre(c).map(t => t.assignee).filter((id): id is string => !!id))];
  const id = role === 'employee' ? c.facts.employeeUserId : role === 'supervisor' ? c.facts.supervisorUserId : role === 'pbp' ? resolvePbp(config, c.facts) : role === 'ta' ? c.facts.taUserId : null;
  return id ? [id] : [];
}
export function workflowMatches(c: Case, workflow: Workflow, today: string): boolean {
  return c.module === workflow.module && workflow.conditions.every(condition => {
    if (condition.field === 'joinWithin') { if (!validDate(c.facts.joinDate)) return false; const days = (Date.parse(c.facts.joinDate) - Date.parse(today)) / DAY; return condition.op === 'lt' ? days < Number(condition.value) : condition.op === 'gte' && days >= Number(condition.value); }
    return condition.op === 'is' ? c.facts[condition.field] === condition.value : condition.op === 'isNot' && c.facts[condition.field] !== condition.value;
  });
}
function pendingPre(c: Case): (Task | Item)[] { const anchor = c.module === 'onb' ? c.facts.joinDate : c.facts.lastDay; return [...c.tasks, ...c.items].filter(t => !isResolved(t.status) && t.status !== 'notReturned' && t.dueOn <= anchor); }
function skipReason(c: Case, workflow: Workflow, config: Config): string {
  const skip = workflow.trigger.skipIf;
  if (skip === 'noPre' && !pendingPre(c).length) return 'Nothing pending before the anchor date.';
  if (skip === 'allDocsDone') {
    const referenced = new Set<string>();
    for (const step of workflow.steps) {
      if (step.type === 'doc' || step.type === 'waitSign') referenced.add(step.template);
      else if (step.type === 'email') {
        const email = config.emails.find(email => email.id === step.template);
        for (const id of [...email?.links ?? [], ...email?.attachments ?? []]) referenced.add(id);
      }
    }
    const ids = [...referenced].filter(id => config.templates.find(template => template.id === id)?.type !== 'Attachment');
    if (ids.length && ids.every(id => { const document = activeDocument(c, id); return document && documentFinal(document); })) return 'All documents done.';
  }
  if (skip.startsWith('task:') && c.tasks.some(t => t.name.toLocaleLowerCase() === skip.slice(5).toLocaleLowerCase() && isResolved(t.status))) return 'Linked task is done.';
  return '';
}
export type EmailPreview = {
  emailId: string; name: string; subject: string; body: string;
  edit: { subject: string; body: string }; to: Actor[]; cc: Actor[];
  documents: { templateId: string; name: string; version: number | null; generated: boolean }[];
  holds: string[]; canSend: boolean; assets?: EmailAsset[];
};
/** Preview uses current authorized facts without generating documents, allocating IDs or queuing mail. */
export function previewEmail(c: Case, config: Config, emailId: string, env: Environment): EmailPreview {
  const email = config.emails.find(email => email.id === emailId && email.module === c.module);
  if (!email) throw new V9Error('Email template not found.', 'not_found');
  const holds: string[] = [], edit = c.emailEdits?.[email.id] ?? { subject: email.subject, body: email.body };
  const values = { ...env.mergeValues, 'owner.name': c.facts.name, 'pending.tasks': pendingPre(c).map(t => `${t.name} (due ${t.dueOn})`).join('\n') };
  const subject = merge(edit.subject, values), body = merge(edit.body, values);
  if (c.state !== 'submitted') holds.push('Submit or reopen the case before sending.');
  if (!email.active) holds.push('This email template is inactive.');
  if (v9ImageTokens(body.text).some(id => !email.images?.some(image => image.id === id))) holds.push('Insert an available inline image before sending.');
  const missing = [...new Set([...subject.missing, ...body.missing])];
  if (missing.length) holds.push(`Complete missing merge fields: ${missing.join(', ')}.`);
  try { merge(edit.subject + '\n' + edit.body, values, emailSensitiveKeys(config)); } catch { holds.push('Remove sensitive fields from the email text.'); }
  const contact = c.module === 'onb' && !c.facts.employeeUserId ? env.onboardingContact : undefined;
  const target = c.facts.employeeUserId ?? contact?.email;
  const to = target && (contact || env.eligibleUser(target)) ? [{ id: target, name: contact ? c.facts.name : env.userName(target) }] : [];
  if (!to.length) holds.push('Link an available employee account or enter the onboarding contact before sending.');
  if (contact && email.links.length) holds.push('Link an employee account before sending document links.');
  const imageCount = (email.images ?? []).filter(image => body.text.includes('{image:' + image.id + '}')).length;
  const caseFileCount = c.files.filter(file => email.slots.some(slot => file.slot === `${email.id}:${slot.id}`)).length;
  if ((email.files?.length ?? 0) + imageCount + email.attachments.length + caseFileCount > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) holds.push('Keep the total attached files and inline images within 20.');
  if ([...(email.files ?? []), ...(email.images ?? []).filter(image => body.text.includes('{image:' + image.id + '}'))].reduce((sum, asset) => sum + asset.size, 0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES) holds.push('Keep the total attached files and inline images within 20 MB.');
  const cc = [...new Set(email.cc.flatMap(role => recipients(c, config, role)))].filter(id => id !== target && env.eligibleUser(id)).map(id => ({ id, name: env.userName(id) }));
  const documents = [...new Set([...email.links, ...email.attachments])].flatMap(templateId => {
    const template = config.templates.find(template => template.id === templateId && template.module === c.module), document = activeDocument(c, templateId);
    if (!template) { holds.push('A linked document template is unavailable.'); return []; }
    const version = document?.version ?? currentVersion(template)?.version ?? null;
    if (!version) holds.push(`Publish ${template.name} before sending.`);
    if ((document?.hrStep ?? template.hrStep) === 'before' && !document?.hrSignature) holds.push(`HR must review and sign ${template.name} before sending.`);
    return [{ templateId, name: document?.name ?? template.name, version, generated: !!document }];
  });
  for (const slot of email.slots) if (slot.required && !c.files.some(file => file.slot === `${email.id}:${slot.id}`)) holds.push(`Upload ${slot.label}.`);
  if (email.id === 'e3') {
    const acceptance = activeDocument(c, 't4');
    if (!acceptance?.hrSignature && !holds.some(hold => hold.startsWith('HR must review and sign'))) holds.push('HR must review and sign the acceptance letter before sending.');
  }
  const assets = [...(email.files ?? []), ...(email.images ?? []).filter(image => body.text.includes('{image:' + image.id + '}'))];
  return { emailId, name: email.name, subject: subject.text, body: body.text, edit: { ...edit }, to, cc, documents, holds: [...new Set(holds)], canSend: holds.length === 0, ...(assets.length ? { assets: structuredClone(assets) } : {}) };
}
function emailSensitiveKeys(config: Config): Set<string> {
  const identityKeys = ['icNo', 'passportNo', 'taxNo', 'epfNo', 'bankAcc', 'bankAccount', 'bankAccountNo', 'spIc', 'spTax'];
  return new Set([...identityKeys.flatMap(key => [key, `employee.${key}`]), ...config.templates.flatMap(t => t.versions.flatMap(v => v.fields.filter(f => f.sensitive).flatMap(f => [f.id, ...(f.pmKey ? [f.pmKey, `employee.${f.pmKey}`] : [])])))]);
}

function enqueue(c: Case, config: Config, step: Extract<Step, { type: 'email' | 'notify' }>, key: string, workflowId: string | null, env: Environment, test = false): string | null {
  const existing = c.mails.filter(mail => mail.workflowId === workflowId && (mail.key === key || mail.key.startsWith(key + ':')));
  const deliveryHold = (mails: Mail[]) => !workflowId || !env.requireDeliveryAck || mails.every(mail => mail.status === 'sent') ? null : mails.some(mail => mail.status === 'uncertain') ? 'Delivery outcome is uncertain. Review the delivery receipt before continuing.' : mails.some(mail => ['failed', 'cancelled'].includes(mail.status)) ? 'Email delivery did not complete. Review the delivery failure.' : 'Waiting for email delivery confirmation.';
  // Resume the original recipients even if roles or task ownership changed meanwhile.
  if (existing.length) return deliveryHold(existing);
  const email = step.type === 'email' ? config.emails.find(e => e.id === step.template && (e.active || test) && e.module === c.module) : null;
  if (step.type === 'email' && !email) throw new V9Error('The email template is inactive or unavailable.');
  const slots = email?.slots.filter(s => s.required && !c.files.some(f => f.slot === `${email.id}:${s.id}`)) ?? [];
  if (slots.length && !test) return `Upload ${slots.map(s => s.label).join(', ')}.`;
  const roles = (Array.isArray(step.to) ? step.to.slice(0, 1) : [step.to]);
  const owners = pendingPre(c).map(t => t.assignee).filter((id): id is string => !!id);
  const contact = !test && c.module === 'onb' && !c.facts.employeeUserId && roles[0] === 'employee' ? env.onboardingContact : undefined;
  if (contact && email?.links.length) return 'Link an employee account before sending document links.';
  const targets = contact ? [contact.email] : [...new Set(roles.flatMap(role => role === 'taskOwners' ? owners : recipients(c, config, role)))];
  if (!targets.length && !test) throw new V9Error('No recipient is linked. Resolve the recipient before continuing.');
  // The source fans out only Task owners. An ordinary email uses the role's first
  // destination; a Notify step puts the remaining group members in CC once.
  const perOwner = roles.includes('taskOwners');
  const to = test ? [env.actor.id] : perOwner ? targets : targets.slice(0, 1);
  const groupCc = !test && !perOwner && step.type === 'notify' ? targets.slice(1) : [];
  const sensitive = emailSensitiveKeys(config);
  for (const target of to) {
    const itemKey = `${key}:${target}`; if (c.mails.some(m => m.key === itemKey)) continue;
    if (!contact && !env.eligibleUser(target)) throw new V9Error('The recipient is no longer eligible for delivery.');
    const tasks = pendingPre(c).filter(t => t.assignee === target);
    const values = { ...env.mergeValues, 'owner.name': contact ? c.facts.name : env.userName(target), 'pending.tasks': (roles.includes('taskOwners') && owners.includes(target) ? tasks : pendingPre(c)).map(t => `${t.name} (due ${t.dueOn})`).join('\n') };
    const edits = email ? c.emailEdits?.[email.id] : null;
    const subject = merge(edits?.subject ?? email?.subject ?? (step.type === 'notify' ? step.subject : ''), values, sensitive), body = merge(edits?.body ?? email?.body ?? (step.type === 'notify' ? step.body : ''), values, sensitive);
    if (!test && (subject.missing.length || body.missing.length)) throw new V9Error(`Complete missing merge fields: ${[...new Set([...subject.missing, ...body.missing])].join(', ')}.`);
    if (v9ImageTokens(body.text).some(id => !email?.images?.some(image => image.id === id))) throw new V9Error('Insert an available inline image before sending.');
    const docs = [...new Set([...(email?.links ?? []), ...(email?.attachments ?? [])])].flatMap(id => {
      const d = activeDocument(c, id) ?? (test ? null : generate(c, config, id, env)), template = config.templates.find(t => t.id === id);
      if (!d) return [];
      if ((d.hrStep ?? template?.hrStep) === 'before' && d.status === 'draft' && !test) throw new V9Error('HR must sign the letter before it can be sent.');
      return [d];
    });
    const cc = test ? [] : [...new Set([...groupCc, ...[...step.cc, ...(email?.cc ?? [])].flatMap(role => recipients(c, config, role))])].filter(id => id !== target && env.eligibleUser(id));
    const assetCount = (email?.files?.length ?? 0) + (email?.images ?? []).filter(image => body.text.includes('{image:' + image.id + '}')).length;
    if (assetCount + (email?.attachments.length ?? 0) + c.files.filter(file => email?.slots.some(slot => file.slot === `${email.id}:${slot.id}`)).length > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) throw new V9Error('Keep the total attached files and inline images within 20.');
    const sender = email?.sender ?? 'noreply';
    if (!['onboarding', 'hr', 'noreply'].includes(sender)) throw new V9Error('Choose a managed sender profile before sending.');
    const assets = structuredClone([...(email?.files ?? []), ...(email?.images ?? []).filter(image => body.text.includes('{image:' + image.id + '}'))]);
    if (assets.reduce((sum, asset) => sum + asset.size, 0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES) throw new V9Error('Keep the total attached files and inline images within 20 MB.');
    c.mails.push({ id: env.nextId(), key: itemKey, workflowId, templateId: email?.id ?? null, to: [target], cc, subject: subject.text, body: body.text, documentIds: docs.map(d => d.id), delivery: { version: 1, queuedBy: { ...env.actor }, sender: sender as 'onboarding' | 'hr' | 'noreply', linkDocumentIds: docs.filter(document => email?.links.includes(document.templateId)).map(document => document.id), pdfDocumentIds: docs.filter(document => email?.attachments.includes(document.templateId)).map(document => document.id), toNames: [contact ? c.facts.name : env.userName(target)], ccNames: cc.map(env.userName), ...(assets.length ? { assets } : {}), ...(contact ? { contact: { kind: 'onboardingContact' as const, caseId: c.id, email: contact.email, sourceRevision: contact.sourceRevision } } : {}) }, fileIds: c.files.filter(f => email?.slots.some(s => f.slot === `${email.id}:${s.id}`)).map(f => f.id), status: 'pending', test, at: env.now, deliveredAt: null, failure: null });
    appendLog(c, env, test ? 'email.test.queued' : 'email.queued', `${email?.name ?? subject.text} · ${contact ? c.facts.name : env.userName(target)}`);
  }
  return deliveryHold(c.mails.filter(mail => mail.workflowId === workflowId && mail.key.startsWith(key + ':')));
}
export function queueEmail(c: Case, config: Config, emailId: string, env: Environment, test = false): void {
  if (c.state !== 'submitted') throw new V9Error('Only an open case can send email.', 'conflict');
  const email = config.emails.find(e => e.id === emailId && e.module === c.module);
  if (!email) throw new V9Error('Email template not found.', 'not_found');
  const acceptance = c.module === 'off' && emailId === 'e3';
  const doc = acceptance ? activeDocument(c, 't4') : null;
  if (acceptance && !test && (!doc || !doc.hrSignature)) throw new V9Error('HR must review and sign the acceptance letter before sending.');
  const key = test ? `test:${env.nextId()}` : acceptance ? `acceptance:${doc!.id}` : `manual:${env.nextId()}`;
  const held = enqueue(c, config, { id: key, type: 'email', template: emailId, to: 'employee', cc: [] }, key, null, env, test);
  if (held) throw new V9Error(held);
}
/** Source dry run: inspect every step against current data, independent of submission/date eligibility. */
export function planWorkflow(c: Case, config: Config, workflow: Workflow, env: Pick<Environment, 'today' | 'userName'>): { matches: boolean; lines: { text: string; ok: boolean }[] } {
  const matches = workflowMatches(c, workflow, env.today), lines: { text: string; ok: boolean }[] = [];
  if (!matches) return { matches, lines: [{ text: 'Skipped: this record does not match the conditions.', ok: false }] };
  lines.push({ text: 'Conditions match.', ok: true });
  const names = (roles: Role[]) => roles.flatMap(role => { const ids = recipients(c, config, role); return ids.length ? ids.map(env.userName) : [`${role}: no linked recipient`]; }).join(', ');
  for (const step of workflow.steps) {
    if (step.type === 'doc') { const doc = activeDocument(c, step.template), template = config.templates.find(t => t.id === step.template); lines.push({ text: doc ? `Already generated: ${doc.name} (v${doc.version})` : `Would generate ${template?.name ?? 'a document'}`, ok: !!template }); }
    else if (step.type === 'email') { const email = config.emails.find(e => e.id === step.template); lines.push({ text: `Would email "${email?.name ?? ''}" to ${names((Array.isArray(step.to) ? step.to : [step.to]).slice(0, 1))}${step.cc.length ? ', CC ' + names(step.cc) : ''}`, ok: !!email }); }
    else if (step.type === 'notify') lines.push({ text: `Would alert ${names((Array.isArray(step.to) ? step.to : [step.to]).slice(0, 1))}`, ok: true });
    else if (step.type === 'waitFile') { const present = c.files.some(file => file.slot === step.slot); lines.push({ text: present ? `${step.label || 'The file'} is uploaded, so it carries on.` : `Would wait: ${step.label || 'the file'} is not uploaded yet.`, ok: present }); }
    else { const doc = activeDocument(c, step.template), name = config.templates.find(t => t.id === step.template)?.name ?? 'the document', signed = step.by === 'hr' ? !!doc?.hrSignature : !!doc && documentFinal(doc); lines.push({ text: signed ? `${name} is signed, so it carries on.` : `Would wait for ${name} to be signed by ${step.by === 'hr' ? 'the HR signatory' : c.facts.name}.`, ok: signed }); }
  }
  return { matches, lines };
}
export function runWorkflow(c: Case, config: Config, workflow: Workflow, env: Environment, event: 'submitted' | 'date' | 'resume'): Run | null {
  if (c.state !== 'submitted' || workflow.status !== 'published') return null;
  const unfinished = c.runs.find(r => r.workflowId === workflow.id && (r.status === 'waiting' || r.status === 'failed'));
  if (unfinished?.definition) workflow = unfinished.definition;
  if (c.state !== 'submitted' || workflow.status !== 'published' || !workflowMatches(c, workflow, env.today)) return null;
  const trigger = workflow.trigger, anchor = trigger.event === 'beforeLWD' ? c.facts.lastDay : c.facts.joinDate;
  if (event === 'submitted' && trigger.event !== 'submitted' || event === 'date' && trigger.event === 'submitted') return null;
  const waiting = event === 'resume' ? unfinished : null;
  if (event === 'resume' && !waiting) return null;
  if (trigger.event !== 'submitted' && !waiting) {
    if (!validDate(anchor)) return null;
    const due = addDays(anchor, trigger.event === 'afterJoin' ? trigger.days : -trigger.days, trigger.workdays);
    if (env.today < due || trigger.event !== 'afterJoin' && env.today > anchor) return null;
  }
  const repeat = trigger.repeat && trigger.event !== 'submitted' && trigger.event !== 'afterJoin';
  const runKey = waiting?.id ?? `${workflow.id}:${repeat ? env.today : 'once'}`;
  let run = c.runs.find(r => r.id === runKey);
  if (run?.status === 'done') return run;
  if (!run) { run = { id: runKey, workflowId: workflow.id, revision: config.revision, date: env.today, status: 'running', cursor: 0, reason: '', at: env.now, definition: structuredClone(workflow), actor: { ...env.actor } }; c.runs.push(run); }
  const skip = skipReason(c, workflow, config); if (skip) { if (run.status !== 'skipped' || run.reason !== skip) appendLog(c, env, 'workflow.skipped', `${workflow.name}: ${skip}`); run.status = 'skipped'; run.reason = skip; return run; }
  run.status = 'running';
  try {
    while (run.cursor < workflow.steps.length) {
      const step = workflow.steps[run.cursor]; let waiting = '';
      if (step.type === 'doc') {
        const doc = generate(c, config, step.template, env), template = config.templates.find(t => t.id === step.template);
        if (step.release && ['draft', 'hrsigned'].includes(doc.status)) {
          if ((doc.hrStep ?? template?.hrStep) === 'before' && !doc.hrSignature) waiting = 'HR must sign before release.';
          else { doc.status = 'sent'; doc.sentAt = env.now; linkedTasks(c, doc, 'sent'); appendLog(c, env, 'document.released', doc.name); }
        }
      } else if (step.type === 'waitSign') { const d = activeDocument(c, step.template); if (!(step.by === 'hr' ? d?.hrSignature : d && documentFinal(d))) waiting = `Waiting for ${step.by === 'hr' ? 'HR' : 'the employee'} to sign.`; }
      else if (step.type === 'waitFile') { if (!c.files.some(f => f.slot === step.slot)) waiting = `Waiting for ${step.label}.`; }
      else waiting = enqueue(c, config, step, `${run.id}:${step.id}`, workflow.id, env) ?? '';
      if (waiting) { run.status = 'waiting'; run.reason = waiting; return run; }
      run.cursor++;
    }
    run.status = 'done'; run.reason = ''; appendLog(c, env, 'workflow.completed', workflow.name);
  } catch (error) { run.status = 'failed'; run.reason = error instanceof Error ? error.message : 'Workflow could not complete.'; appendLog(c, env, 'workflow.failed', `${workflow.name}: ${run.reason}`); }
  return run;
}
/** Durable delivery acknowledgement is the only operation that marks email-linked documents sent. */
export function markDelivered(c: Case, id: string, env: Environment, unchangedDocumentIds?: ReadonlySet<string>): void {
  const mail = c.mails.find(m => m.id === id); if (!mail || mail.status === 'sent') return;
  if (mail.status !== 'sending' && (c.state !== 'submitted' || mail.status !== 'pending')) throw new V9Error('Delivery is no longer eligible.', 'conflict');
  mail.status = 'sent'; mail.deliveredAt = env.now; mail.failure = null;
  // A late acknowledgement records the truth without reopening a closed case.
  if (!mail.test && c.state === 'submitted') for (const doc of c.documents.filter(d => mail.documentIds.includes(d.id) && (!unchangedDocumentIds || unchangedDocumentIds.has(d.id)))) {
    if (['draft', 'hrsigned'].includes(doc.status)) { doc.status = 'sent'; doc.sentAt = env.now; }
    linkedTasks(c, doc, 'sent');
  }
  appendLog(c, env, 'email.sent', mail.subject);
}
export function close(c: Case, figures: FinalFigures, reason: string, env: Environment, automatic = false): void {
  if (c.module !== 'off' || c.state !== 'submitted') throw new V9Error('Only an open offboarding case can be cleared.', 'conflict');
  const state = work(c);
  if ((state.open.length || state.notReturned.length) && (automatic || !reason.trim())) throw new V9Error('Record an exception reason for outstanding work or unreturned items.');
  if (!figures.sourceRevision || figures.lastDay !== c.facts.lastDay || !figures.payrollReference) throw new V9Error('Refresh and confirm the final figures in Payroll before clearance.');
  c.finalFigures = { ...figures, lockedAt: env.now }; c.state = 'cleared'; c.closedAt = env.now;
  c.closedBy = automatic ? { id: 'system', name: 'System (auto-close)' } : { ...env.actor };
  c.closeReason = reason.trim(); c.review = null;
  for (const mail of c.mails) if (mail.status === 'pending') mail.status = 'cancelled';
  appendLog(c, env, automatic ? 'case.autoClosed' : 'case.cleared', reason.trim() || 'Every task and item was resolved.');
}
export function lastDayCheck(c: Case, config: Config, env: Environment, figures: FinalFigures | null): 'closed' | 'flagged' | 'unchanged' {
  if (c.module !== 'off' || c.state !== 'submitted' || !validDate(c.facts.lastDay) || env.today < c.facts.lastDay) return 'unchanged';
  const state = work(c);
  if (!state.open.length && !state.notReturned.length && figures) { close(c, figures, '', env, true); return 'closed'; }
  const detail = [state.open.length ? `${state.open.length} still open: ${state.open.map(t => `${t.name} (due ${t.dueOn})`).join('; ')}` : '', state.notReturned.length ? `${state.notReturned.length} items marked not returned need HR sign-off.` : '', !figures ? 'Final figures require confirmation in Payroll.' : ''].filter(Boolean).join('\n');
  const first = !c.review;
  c.review = { firstAt: c.review?.firstAt ?? env.now, open: state.open.length, overdue: state.open.filter(t => t.dueOn <= env.today).length, notReturned: state.notReturned.length, detail };
  if (!first) return 'unchanged';
  appendLog(c, env, 'case.reviewRequired', detail);
  const ops = recipients(c, config, 'peopleOps').filter(env.eligibleUser), pbp = resolvePbp(config, c.facts);
  if (ops.length) c.mails.push({ id: env.nextId(), key: 'last-day-review', workflowId: null, templateId: null, to: [ops[0]], cc: [...new Set([...ops.slice(1), ...(pbp && env.eligibleUser(pbp) ? [pbp] : [])])].filter(id => id !== ops[0]), subject: `${c.facts.name}: last working day reached, case not closed`, body: `${c.facts.name}'s last working day (${c.facts.lastDay}) has been reached.\n\n${detail}\n\nPlease review the case.`, documentIds: [], fileIds: [], delivery: { version: 1, queuedBy: { ...env.actor }, sender: 'noreply', linkDocumentIds: [], pdfDocumentIds: [], toNames: [env.userName(ops[0])], ccNames: [...new Set([...ops.slice(1), ...(pbp && env.eligibleUser(pbp) ? [pbp] : [])])].filter(id => id !== ops[0]).map(env.userName) }, status: 'pending', test: false, at: env.now, deliveredAt: null, failure: null });
  else appendLog(c, env, 'email.routingFailed', 'No eligible People Ops recipient for the last working day review.');
  return 'flagged';
}
export function cancel(c: Case, reason: string, env: Environment): void {
  if (!['pending', 'submitted'].includes(c.state)) throw new V9Error('This case cannot be cancelled.', 'conflict');
  if (!reason.trim()) throw new V9Error('Choose or enter a cancellation reason.');
  c.state = 'cancelled'; c.cancelReason = reason.trim();
  for (const mail of c.mails) if (mail.status === 'pending') mail.status = 'cancelled';
  appendLog(c, env, 'case.cancelled', reason.trim());
}
export function reopen(c: Case, reason: string, env: Environment): void {
  if (c.state !== 'cleared' || !reason.trim()) throw new V9Error('Add a reason to reopen a cleared case.');
  c.state = 'submitted'; c.finalFigures = null; c.closedAt = null; c.closedBy = null; c.closeReason = ''; c.review = null;
  appendLog(c, env, 'case.reopened', reason.trim());
}
