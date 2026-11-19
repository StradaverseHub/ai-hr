import {initializePersonnelCompletion,personnelCompletionManagedField,effectivePersonnelCompletion,missingPersonnelCompletion,overridePersonnelCompletion,reconcilePersonnelCompletion,personnelCompletionLocked,savePersonnelCompletionAnswer,personnelCompletionIssues,personnelCompletionMergeValues,personnelCompletionEmployeeAnswers,type PersonnelCompletionPolicy} from './lifecycle-v9-personnel-completion';
import {initializeV9DocumentRouting,reviseV9DocumentRouting,v9RouteReadyForEmployee,v9RoutedHrComplete,v9RoutedHasSigningReceipt,type V9DocumentRoutingEnvironment} from './lifecycle-v9-document-routing';
import {canEditSigningContent,type SigningDocument} from './document-signing-model';
import type {DocumentRouting,DocumentRoutingUnresolved} from './document-signing-routing';
import { managerRecipientResult, type PersonnelManagerRecipient } from './personnel-manager-recipient';
import type {AutomationRecipient} from './automation/workflow';
import { bulkAssignmentProblem, RETURN_BULK_LABELS } from './lifecycle-bulk-assignment';
import { personnelMergeLabels } from '@/lib/lifecycle-v9-personnel-merge-fields';
import type { Note as LifecycleNote } from './onboarding-model';
import { resolveV9CaseFields, missingV9CaseFields, offCaseFormValues, type CaseField } from './lifecycle-v9-case-form';
import { v9LiteralAddress } from './lifecycle-v9-recipient';
import { v9EmploymentRule } from './lifecycle-v9-employment';
import type { EmploymentConfirmationDates } from './employment-confirmation';
import { MANAGED_EMAIL_ATTACHMENT_MAX_BYTES, MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT } from './managed-email-policy';
import { v9ImageTokens, v9ImageCid } from './lifecycle-v9-email-content';
import type { EmailBodyDoc } from './email-body/doc';
import { emailBodyImageIds } from './email-body/doc';
import { renderEmailBody } from './email-body/render';
import { roleLabel, toRoles, workEmailLabel, personalEmailLabel, maskEmail, recipientListProblems, MAX_RECIPIENT_CHOICES } from './lifecycle-v9-recipients';
/** V9 lifecycle rules. Services supply authorized identity, Personnel facts and final-pay snapshots. */
import { validV9SignatureValue } from './lifecycle-v9-signature';
import { isCalendarDate } from './calendar-date';
import type { SettlementPolicy, SettlementInput } from './lifecycle-v9-calculator';
import type {ExitType} from './lifecycle-v9-exit-types';
export type Module = 'onb' | 'off';
export type {ExitType} from './lifecycle-v9-exit-types';
export type CaseState = 'pending' | 'submitted' | 'cleared' | 'cancelled';
export type RuleField = 'businessGroup' | 'company' | 'department' | 'grade' | 'employmentType' | 'title' | 'caseType';
export type Rules = Partial<Record<RuleField, string[]>>;
export type Facts = Record<RuleField, string> & EmploymentConfirmationDates & {
  name: string; employeeNo: string; employmentId: string; personId: string;
  joinDate: string; lastDay: string; noticeDate: string;
  employeeUserId: string | null; supervisorUserId: string | null; taUserId: string | null; starterUserId?: string | null;
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
  sourceCatalogueId?: string;
  returnReported?: { at: string; by: string; note: string };
  nativeSource?: { caseId: string; requestId: string; itemId: string; requestNumber: string };
  group: string | null; assignee: string | null; dueOn: string;
  status: 'todo' | 'progress' | 'done' | 'notReturned' | 'notNeeded'; reason: string;
  /** d1e26f81 — presets from Onboarding & Offboarding settings. Absent on rows created before this release. */
  catalogueId?: string | null;
  method?: ReturnMethod;
  /** Day offset from the return anchor (the effective last working day); null keeps a fixed date. */
  dueDay?: number | null;
  assignmentFailure?: string | null;
  /** The team, person and handover date recorded on the issuing onboarding item. */
  providedBy?: { group: string | null; userId: string | null; at: string | null } | null;
  /** An access card with "Facility prints, Group Tech activates" returns as a collect row and a deactivate row. */
  cardStep?: 'collect' | 'deactivate'; pairId?: string;
};
export type ReturnMethod = 'rr' | 'manual';
/** d1e26f81 — the shared "Set for all items" change; `due` is a Day offset. */
export type ItemsBulk = { ids: string[]; group?: string; method?: ReturnMethod; due?: number };
export type ReturnPreset = Omit<ItemsBulk, 'ids'>;
export type Field = {
  id: string; label: string; type: 'text' | 'textarea' | 'select' | 'date' | 'checkbox' | 'phone' | 'email' | 'number' | 'table';
  owner: 'employee' | 'hr' | 'pmLocked'; pmKey: string | null; required: boolean;
  sensitive: boolean; options: string[]; section: string;
  width?: 'half' | 'full'; columns?: string[];
  when: { field: string; value: string } | null;
};
export type Block = { id: string; type: 'letterhead' | 'heading' | 'subheading' | 'text' | 'fields' | 'field' | 'table' | 'signature'; text: string; section: string; fieldId?: string; columns?: string; rows?: string; role?: string; label?: string };
export type TemplateVersion = { version: number; state: 'draft' | 'published'; at: string; by: string; blocks: Block[]; fields: Field[]; routing?: DocumentRouting };
export type Template = {
  id: string; name: string; module: Module; type: 'Form' | 'Letter' | 'Acknowledgement' | 'Attachment';
  rules: Rules; offboardingHrSignature?:'pbp'|'beforeEmployee'|'namedHr'; hrStep: 'none' | 'before' | 'after'; employeeAck: boolean; retired: boolean;
  versions: TemplateVersion[]; currentVersion?: number; note?: string;
};
export type ConfigSaveReceipt = { revision: number; groupsRevision: number; versionStamps?: { templateId: string; version: number; state: TemplateVersion['state']; at: string; by: string }[] };
export type Signature = { printedTitle?: string; by: Actor; at: string; method: 'typed' | 'drawn'; value: string; consent: true };
export type Document = {
  id: string; templateId: string; version: number; name: string;
  status: 'draft' | 'sent' | 'opened' | 'completed' | 'hrsigned' | 'countersign' | 'signed' | 'acknowledged' | 'superseded' | 'withdrawn';
  blocks: Block[]; fields: Field[]; values: Record<string, string>; edits: Record<string, string>;
  hrSignature: Signature | null; employeeSignature: Signature | null; createdAt: string; sentAt: string | null;
  supersededBy?: string;
  mergeValues?: Record<string, string>;
  personnelCompletion?:PersonnelCompletionPolicy;
  personnelSourceReference?:{version:1;basis:'current'|'exit-boundary'|'draft';asOf:string;assignmentId:string|null;reportingLineId:string|null;exitEventId:string|null};
  hrStep?: Template['hrStep']; employeeAck?: boolean; signatoryUserId?: string | null; templateType?: Template['type'];
  /** Documents generated from a routed template version: each Sign step's signature, keyed by step id (`step:<id>` signature blocks). */
  stepSignatures?: Record<string, Signature>;
  /** Frozen source routing and canonical content-bound signing state, owned by this saved instance. */
  routing?:DocumentRouting;signing?:SigningDocument;routingUnresolved?:DocumentRoutingUnresolved[];
};
export type Role = 'employeeWork' | 'employeePersonal' | 'employee' | 'supervisor' | 'pbp' | 'ta' | 'peopleOps' | 'taskOwners' | 'hrSignatory' | 'starter' | `group:${string}` | `person:${string}` | `address:${string}`;
/** A recipient that could not be found when the step ran. Labels and reasons only, never an address. */
export type RecipientMissing = { role: Role; label: string; reason: string };
export type RecipientOverride = { to: Role[]; cc: Role[]; by: Actor; at: string };
export type EmailAsset = { id: string; kind: 'file' | 'image'; name: string; mimeType: string; size: number; contentHash: string; at: string; by: string; /** Required for images used in a rich body. */ alt?: string };
export type DefinitionUsage = { kind: 'document' | 'email'; definitionId: string; messages: number; runs: number };
export type TemplateUsage = { templateId: string; version: number; documents: number };
export type EmailTemplate = {
  id: string; name: string; module: Module; active: boolean; sender: string;
  subject: string; body: string; cc: Role[]; links: string[]; attachments: string[];
  /** Set by the one-off recipient conversion; HR clears it after checking. */
  recipientReview?: true;
  /** Board 6bdda222: the structured rich body. Without it the legacy text body sends exactly as before. */
  bodyDoc?: EmailBodyDoc;
  /** Offboarding-only named routing CC; existing Role CC is preserved. */
  routingCc?: AutomationRecipient[];
  slots: { id: string; label: string; required: boolean; by?: AutomationRecipient }[]; files?: EmailAsset[]; images?: EmailAsset[];
};
export type Trigger = {
  event: 'submitted' | 'hrSigned' | 'docSigned' | 'taskDone' | 'fileUploaded' | 'manual' | 'beforeJoin' | 'afterJoin' | 'beforeLWD' | 'afterLWD'; days: number;
  workdays: boolean; repeat: boolean; skipIf: '' | 'noPre' | 'allDocsDone' | `task:${string}`;
};
export type Step =
  | { id: string; type: 'doc'; template: string; release: boolean }
  | { id: string; type: 'waitSign'; template: string; by: 'hr' | 'employee' }
  | { id: string; type: 'waitFile'; slot: string; label: string }
  | { id: string; type: 'email'; template: string; to: Role | Role[]; cc: Role[]; recipientReview?: true; recipientSetup?: true }
  | { id: string; type: 'notify'; subject: string; body: string; to: Role | Role[]; cc: Role[]; recipientReview?: true; recipientSetup?: true };
export type Workflow = {
  id: string; name: string; module: Module; status: 'draft' | 'published' | 'retired'; trigger: Trigger;
  conditions: { field: RuleField | 'joinWithin'; op: 'is' | 'isNot' | 'lt' | 'gte'; value: string }[];
  steps: Step[]; description: string;
  /** Set only by the retire action. A retired workflow never starts again; runs already started finish from their frozen definition. */
  retired?: WorkflowRetirement;
};
export type WorkflowRetirement = { at: string; by: Actor; cases: number; automatic: boolean };
/** Live workflows start new runs; retired workflows only let runs that already started finish. */
export function workflowFinishes(workflow: Pick<Workflow, 'status'> | undefined): boolean { return workflow?.status === 'published' || workflow?.status === 'retired'; }
/** A live workflow with any trigger other than "Started by hand" starts for new cases on its own. */
export function workflowStartsAutomatically(workflow: Pick<Workflow, 'status' | 'trigger'>): boolean { return workflow.status === 'published' && workflow.trigger.event !== 'manual'; }
/** Drafts can be incomplete. Activation must be safe and independently validated by the service. */
/** allowRecipientSetup: a ready-made step left without a To recipient for the company group to choose (recipientSetup)
 * keeps its live state until the workflow is next changed; it is held when it runs, and any change needs a recipient. */
export function workflowProblems(workflow: Workflow, config: Pick<Config, 'templates' | 'emails'>, options: { allowInactiveEmail?: boolean; allowRecipientSetup?: boolean } = {}): string[] {
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
      else if ('active' in template && !template.active && !options.allowInactiveEmail) problems.push(prefix + 'choose an active email template.');
    }
    if (step.type === 'waitFile' && !step.slot.trim()) problems.push(prefix + 'choose a file slot.');
    if (step.type === 'notify' && !step.subject.trim()) problems.push(prefix + 'add a subject.');
    if ('to' in step && !(Array.isArray(step.to) ? step.to.length : step.to) && !(options.allowRecipientSetup && step.recipientSetup)) problems.push(prefix + 'choose a recipient.');
  }
  for (const [i, condition] of workflow.conditions.entries()) if (!condition.value.trim() || condition.field === 'joinWithin' && !/^\d+$/.test(condition.value)) problems.push(`Condition ${i + 1}: choose a valid value.`);
  return problems;
}
export function dateTrigger(event: Trigger['event']): boolean { return ['beforeJoin','afterJoin','beforeLWD','afterLWD'].includes(event); }
export function afterTrigger(event: Trigger['event']): boolean { return event === 'afterJoin' || event === 'afterLWD'; }
export function workflowEvents(module: Module): { id: Trigger['event']; label: string }[] {
  return [{id:'submitted',label:module === 'onb' ? 'Onboarding case is submitted' : 'Offboarding case is submitted'}, {id:'docSigned',label:'A document is signed'}, {id:'hrSigned',label:'HR signs a document'}, {id:'taskDone',label:'A checklist task is completed'}, {id:'fileUploaded',label:'A file is uploaded for the person'}, ...(module === 'onb' ? [{id:'beforeJoin',label:'Days before the join date'}, {id:'afterJoin',label:'Days after the join date'}] : [{id:'beforeLWD',label:'Days before the last working day'}, {id:'afterLWD',label:'Days after the last working day'}]), {id:'manual',label:'Started by hand'}] as { id: Trigger['event']; label: string }[];
}
export function workflowWhen(workflow: Workflow): string {
  const trigger=workflow.trigger;
  if (!dateTrigger(trigger.event)) return workflowEvents(workflow.module).find(event=>event.id===trigger.event)?.label ?? 'Unknown trigger';
  return `${trigger.days}${trigger.workdays ? ' working' : ''} day${trigger.days === 1 ? '' : 's'} ${afterTrigger(trigger.event) ? 'after' : 'before'} the ${workflow.module === 'onb' ? 'join date' : 'last working day'}${trigger.repeat && !afterTrigger(trigger.event) ? ', every morning until then' : ''}`;
}
export type Run = { id: string; workflowId: string; revision: number; date: string; status: 'running' | 'waiting' | 'done' | 'skipped' | 'failed'; cursor: number; reason: string; at: string; definition?: Workflow; actor?: Actor;
  /** An email step waiting because a recipient is missing. Only Continue looks the recipients up again. */
  /** Original due day survives unsigned Personnel preparation and later signature/file waits. */
  completionHold?: {documentId:string;stepId:string;dueOn:string|null;at:string};
  hold?: { stepId: string; missing: RecipientMissing[]; at: string }; lateEmail?: { stepId: string; dueOn: string; at: string }; resumeOn?: string; sourceEvent?: { kind: 'hrSigned' | 'docSigned' | 'taskDone' | 'fileUploaded'; sourceId: string; at: string; revision: number } };
export type Mail = {
  id: string; key: string; workflowId: string | null; templateId: string | null;
  to: string[]; cc: string[]; subject: string; body: string; documentIds: string[];
  fileIds: string[]; status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled'; test: boolean;
  at: string; deliveredAt: string | null; failure: string | null; retryOf?: string; retryReason?: string; retryMode?: 'same'|'updated';
  /** Frozen transport choices; older history without this must not be silently reinterpreted.
   * New mail is always 'noreply'; 'onboarding' and 'hr' survive only in earlier history and send as the same sender. */
  delivery?: { /** 2 carries a rendered HTML snapshot; 1 is the unchanged text (and inline-image) path. */ version: 1 | 2; html?: string; queuedBy: Actor; sender: 'onboarding' | 'hr' | 'noreply'; linkDocumentIds: string[]; pdfDocumentIds: string[]; toNames: string[]; ccNames: string[]; assets?: EmailAsset[]; contact?: { kind: 'onboardingContact'; caseId: string; email: string; sourceRevision: string };
    /** Keys in to/cc that came from Employee (Personal email); masked for viewers without that Personnel permission. */
    personalKeys?: string[] };
};
export type PMChange = { id: string; documentId: string; field: string; before: string; after: string; status: 'proposed' | 'pushed' | 'conflict' | 'rejected'; sourceRevision: string; provenance?:{kind:'missing-personnel';version:1;by:Actor;at:string};superseded?:{at:string;by:Actor;reason:string} };
export type FinalFigures = { sourceRevision: string; lastDay: string; leaveDays: string; amount: string; currency: string; payDate: string; lockedAt: string; payrollReference: string };
export type Case = {
  /** Native Contract handoff receipt. Absence preserves earlier On/Off Boarding case behaviour. */
  contractSharedSourceCaseId?:string;
  contractSharedSourceLetter?:{letterId:string;signingDocumentId:string;hash:string};
  contractSharedTerminationReason?:string;
  contractSharedClearance?:'pending-manual-personnel';
  contractSharedNoticeReviewRequired?:boolean;
  version: 9; id: string; number: string; module: Module; revision: number; state: CaseState;
  facts: Facts; checklistId: string | null; checklistName: string; override: 'automatic' | 'none' | string;
  tasks: Task[]; items: Item[]; documents: Document[]; runs: Run[]; mails: Mail[];
  files: { id: string; slot: string; name: string; storageId: string; contentHash?: string }[];
  pmChanges: PMChange[]; log: Log[]; sourceRevision: string;
  submittedAt: string | null; closedAt: string | null; closedBy: Actor | null; closeReason: string;
  itemsClearedAt?: string | null;
  cancelReason: string; revokeDate: string; finalFigures: FinalFigures | null;
  review: { firstAt: string; open: number; overdue: number; notReturned: number; detail: string } | null;
  notes?: LifecycleNote[];
  returnSelections?: string[];
  caseValues?: Record<string,string>;
  revokeMode?: 'lastday' | 'date';
  /** Authorised read-only manager summary, excluded from persisted document state. */
  supervisorDelivery?: { name: string | null; problem: string | null; reason?: PersonnelManagerRecipient['reason'] };
  emailEdits?: Record<string, { subject: string; body: string }>;
  /** Per case and step (`workflowId:stepId`): To and CC chosen for this person only. */
  recipientOverrides?: Record<string, RecipientOverride>;
  settlementOptions?: Pick<SettlementInput, 'override' | 'keepSourceDate' | 'offsetLeave' | 'reduceEncashment'>;
  /** d1e26f81 — the effective last working day that Return and revoke Day offsets count from. */
  returnAnchor?: string;
  /** d1e26f81 — "Set for all items" choices made before submission, keyed by the pending preview id. */
  returnPresets?: Record<string, ReturnPreset>;
};
export type Config = {
  version: 9; revision: number; checklists: Checklist[]; templates: Template[];
  groupsRevision?: number;
  caseForms?: Partial<Record<Module, CaseField[]>>;
  emails: EmailTemplate[]; workflows: Workflow[]; groups: Group[]; peopleOpsGroup: string | null;
  settlementPolicy?: SettlementPolicy;
  /** Omitted fields preserve existing settings; null reofferMonths means no retention time limit. */
  offboarding?: { postingApproverGroupId?: string | null; reofferMonths?: number | null };
  signatoryTitles?: Record<string,string>;
  companies?: { companyId: string; signatoryUserId: string | null; signatoryTitle: string; allowedSignatoryUserIds?: string[]; letterhead?: { registrationNo?: string; address?: string; color?: string } }[];
};
export type Environment = {
  today: string; now: string; actor: Actor; nextId: () => string;
  documentRouting?:V9DocumentRoutingEnvironment;
  /** Canonical, authorized source; absence deliberately preserves legacy pure-model callers. */
  personnelCompletion?:{available?:boolean;country:string|null;source:Record<string,string>;fingerprint:(values:Record<string,string>,country:string|null)=>string};
  onLeave: (userId: string, date: string) => boolean;
  openLoad: (userId: string, groupId: string) => number;
  lastAssigned: (userId: string, groupId: string) => number;
  /** Services reject identities without an authorized verified destination before delivery. */
  eligibleUser: (userId: string) => boolean;
  userName: (userId: string) => string;
  /** Auth-owned actual account destination, provided only by the server's bounded preview read. */
  userEmail?: (userId: string) => string | null;
  /** Current PM supervisor account; null deliberately overrides an obsolete case snapshot. */
  supervisorUserId?: string | null;
  /** Current Personnel employment and work destination; never grants task/login eligibility. */
  supervisorRecipient?: PersonnelManagerRecipient;
  mergeValues: Record<string, string>;
  signatoryUserId?: string | null;
  actorSignatoryTitle?: string;
  /** Production workflows wait for the durable transport acknowledgement. */
  requireDeliveryAck?: boolean;
  /** Set only by the service's verified journey/clearance link; that shared runner owns resignation letters and mail. */
  managedResignation?: boolean;
  resignationOwnedTemplateIds?: readonly string[];
  /** A real Native onboarding contact; this is never an app-user identity or login grant. */
  onboardingContact?: { email: string; sourceRevision: string };
  /** d1e26f81 — the Leaver calculator's effective last working day, when the service could compute it. */
  effectiveLastDay?: string;
  /** Users with Full case view of this case, alerted when an email is held. Service-derived. */
  holdAlertUserIds?: string[];
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
  return Object.entries(rules).every(([key, values]) => !values?.length || (key === 'employmentType' ? values.some(value => v9EmploymentRule(value, facts) === true) : values.includes(facts[key as RuleField])));
}
export function specificity(rules: Rules): number { return Object.values(rules).filter(v => v?.length).length; }
export function matchChecklist(config: Config, c: Pick<Case, 'module' | 'facts' | 'override'>): { checklist: Checklist | null; tie: boolean } {
  const lists = config.checklists.filter(x => x.module === c.module);
  if (c.override === 'none') return { checklist: null, tie: false };
  if (c.override !== 'automatic') { const selected = lists.find(x => x.id === c.override); if (!selected) throw new V9Error('The selected checklist no longer exists.'); return { checklist: selected, tie: false }; }
  const ranked = lists.filter(x => matches(x.rules, c.facts)).map((x, index) => ({ x, index })).sort((a, b) => specificity(b.x.rules) - specificity(a.x.rules) || a.index - b.index);
  return { checklist: ranked[0]?.x ?? null, tie: ranked.length > 1 && specificity(ranked[0].x.rules) === specificity(ranked[1].x.rules) };
}
export function assign(config: Config, groupId: string | null, due: string, env: Environment, extra: Record<string, number>, tieBreak: 'recent' | 'memberOrder' = 'recent', exclude: string | null = null): { userId: string | null; reason: string | null } {
  const group = config.groups.find(g => g.id === groupId);
  if (!group) return { userId: null, reason: 'Choose an assignment group.' };
  // d1e26f81 — the leaver never owns their own offboarding work.
  const members = [...new Set(group.members)].filter(env.eligibleUser).filter(id => !exclude || id !== exclude);
  if (!members.length) return { userId: null, reason: `No eligible members in ${group.name}.` };
  const available = members.filter(id => !env.onLeave(id, due));
  if (!available.length) return { userId: null, reason: `Everyone in ${group.name} is on leave on ${due}.` };
  const ranked = available.map(id => ({ id, load: env.openLoad(id, group.id) + (extra[id] ?? 0) }))
    .filter(x => !group.limit || x.load < group.limit)
    .sort((a, b) => a.load - b.load || (tieBreak === 'recent' ? env.lastAssigned(a.id, group.id) - env.lastAssigned(b.id, group.id) : 0) || members.indexOf(a.id) - members.indexOf(b.id));
  return ranked.length ? { userId: ranked[0].id, reason: null } : { userId: null, reason: `Everyone available in ${group.name} is at their limit of ${group.limit} open tasks.` };
}
export function appendLog(c: Case, env: Pick<Environment,'actor'|'now'|'nextId'>, action: string, detail: string, assignment?: { userId: string; groupId: string }): void {
  c.log.push({ id: env.nextId(), at: env.now, actor: { ...env.actor }, action, detail, ...assignment });
}
export function submit(c: Case, config: Config, env: Environment): void {
  if (c.state !== 'pending') throw new V9Error('Only a pending case can be submitted.', 'conflict');
  const anchor = c.module === 'onb' ? c.facts.joinDate : c.facts.lastDay;
  if (!validDate(anchor) || !c.facts.name || !c.facts.employeeNo || !c.facts.employmentId || !c.facts.company) throw new V9Error('Complete the employee, employee ID, company and anchor date before submitting.');
  if (c.module === 'off' && !(['Resignation', 'Termination', 'Contract end', 'Retirement', 'Non-confirmation'] as string[]).includes(c.facts.caseType)) throw new V9Error('Choose the offboarding case type.');
  if (c.module === 'off') { const missing = missingV9CaseFields(resolveV9CaseFields('off',config.caseForms?.off), c.facts, offCaseFormValues(c), true); if (missing.length) throw new V9Error('Complete: '+missing.map(field=>field.label).join(', ')); }
  const selected = matchChecklist(config, c), extra: Record<string, number> = {};
  const conflicting=env.managedResignation?selected.checklist?.tasks.find(task=>task.documentTemplate&&env.resignationOwnedTemplateIds?.includes(task.documentTemplate)):null;
  if(conflicting)throw new V9Error(`Review checklist task “${conflicting.name}”: this document is owned by the resignation journey. HR must update the checklist requirement before starting clearance.`,'conflict');
  c.checklistId = selected.checklist?.id ?? null; c.checklistName = selected.checklist?.name ?? 'No checklist';
  c.tasks = (selected.checklist?.tasks ?? []).map(def => {
    const dueOn = taskDate(c.module, anchor, def.due), opensOn = def.opens === null ? null : taskDate(c.module, anchor, def.opens);
    if (opensOn && opensOn > dueOn) throw new V9Error(`Opens on cannot follow due by for ${def.name}.`);
    const owner = def.by === 'employee' ? { userId: c.facts.employeeUserId, reason: c.facts.employeeUserId ? null : 'Employee login is not linked.' }
      : def.by === 'manager' ? { userId: c.facts.supervisorUserId, reason: c.facts.supervisorUserId ? null : 'Line manager login is not linked.' }
      : def.mode === 'rr' ? assign(config, def.group, dueOn, env, extra, c.module === 'off' ? 'memberOrder' : 'recent', c.module === 'off' ? c.facts.employeeUserId : null) : { userId: null, reason: 'Manual assignment is required.' };
    if (owner.userId) extra[owner.userId] = (extra[owner.userId] ?? 0) + 1;
    return { ...structuredClone(def), dueOn, opensOn, assignee: owner.userId, assignmentFailure: owner.reason, status: 'todo' as const, reason: '' };
  });
  c.facts.starterUserId = env.actor.id;
  c.state = 'submitted'; c.submittedAt = env.now;
  appendLog(c, env, 'case.submitted', `Checklist confirmed: ${c.checklistName}.${selected.tie ? ' Equally specific matches; first display order selected.' : ''}`);
  for (const task of c.tasks) appendLog(c, env, 'task.assigned', `${task.name}: ${task.assignee ? env.userName(task.assignee) : task.assignmentFailure}`, task.assignee && task.group ? { userId: task.assignee, groupId: task.group } : undefined);
}
export function isResolved(status: Task['status'] | Item['status']): boolean { return status === 'done' || status === 'notNeeded'; }
/** d1e26f81 — Return and revoke defaults: physical items the day before the last working day, system access on it. */
export function defaultReturnDay(kind: Item['kind']): number { return kind === 'device' ? -1 : 0; }
/** Day 0 is the anchor (the effective last working day); -1 the day before. */
export function returnDue(anchor: string, dueDay: number): string { return taskDate('off', anchor, dueDay); }

/** Reuse the settlement-options date owner: only unresolved relative rows follow an effective anchor. */
export function reanchorOpenReturnDates(c:Case,anchor:string):number{let moved=0;for(const item of c.items)if(returnOpen(item)&&typeof item.dueDay==='number'){const next=returnDue(anchor,item.dueDay);if(next!==item.dueOn){item.dueOn=next;moved++;}}return moved;}
/** The purpose-bound service verifies the reverse source link and exact owner correction before this projection. */
export function synchronizeResignationLastDay(c:Case,oldDay:string,newDay:string,effectiveDay:string,env:Pick<Environment,'actor'|'now'|'nextId'>):void{
 if(c.module!=='off'||!(c as Case&{resignationSourceCaseId?:string}).resignationSourceCaseId||!['pending','submitted'].includes(c.state))throw new V9Error('Only an open linked resignation clearance case can follow this correction.','conflict');
 if(c.facts.lastDay!==oldDay||!validDate(newDay)||!validDate(effectiveDay)||newDay<c.facts.noticeDate)throw new V9Error('The linked case date changed. Refresh before correcting it.','conflict');
 if(oldDay===newDay)return;
 const oldRevoke=c.revokeDate;c.facts.lastDay=newDay;
 if((c.revokeMode??'lastday')==='lastday')c.revokeDate=newDay;
 for(const task of c.tasks)if(!isResolved(task.status)){task.dueOn=taskDate('off',newDay,task.due);task.opensOn=task.opens===null?null:taskDate('off',newDay,task.opens);}
 if(c.state==='submitted'){c.returnAnchor=effectiveDay;reanchorOpenReturnDates(c,effectiveDay);for(const item of c.items)if(returnOpen(item)&&item.method===undefined&&item.dueDay===undefined&&item.dueOn===oldRevoke)item.dueOn=c.revokeDate;}
 c.review=null;c.finalFigures=null;
 appendLog(c,env,'case.resignationLastDaySynchronized',`Agreed last working day corrected from ${oldDay} to ${newDay}. Open checklist dates and relative return dates now follow the corrected source.`);
}
export function returnOpen(item: Pick<Item, 'status'>): boolean { return !isResolved(item.status) && item.status !== 'notReturned'; }
/** Round-robin assignment for one return item: the leaver is excluded and the reason is kept when nobody can take it. */
export function assignReturnItem(c: Case, config: Config, item: Item, env: Environment, extra: Record<string, number>): void {
  if ((item.method ?? 'rr') === 'manual') { item.assignee = null; item.assignmentFailure = 'Manual assignment is required.'; return; }
  const assigned = assign(config, item.group, item.dueOn, env, extra, 'memberOrder', c.facts.employeeUserId);
  item.assignee = assigned.userId; item.assignmentFailure = assigned.reason;
  if (assigned.userId) extra[assigned.userId] = (extra[assigned.userId] ?? 0) + 1;
  appendLog(c, env, assigned.userId ? 'item.assigned' : 'item.assignment_failed', `${item.name}: ${assigned.userId ? env.userName(assigned.userId) : assigned.reason}`, assigned.userId && item.group ? { userId: assigned.userId, groupId: item.group } : undefined);
}
/** d1e26f81 — "Set for all items" on a submitted case; mirrors onboarding bulkEquipment. Done, not needed and not returned items are never changed. */
export function bulkItems(c: Case, config: Config, change: ItemsBulk, env: Environment): number {
  const problem = bulkAssignmentProblem(change, config.groups.map(group => group.id), RETURN_BULK_LABELS);
  if (problem) throw new V9Error(problem);
  if (c.module !== 'off' || c.state !== 'submitted') throw new V9Error('This case is not open.');
  if (change.ids.some(id => !c.items.some(item => item.id === id))) throw new V9Error('A return item is no longer available.');
  const targets = c.items.filter(item => change.ids.includes(item.id) && returnOpen(item));
  if (!targets.length) throw new V9Error('No open return items match this change.');
  const anchor = c.returnAnchor ?? c.facts.lastDay, extra: Record<string, number> = {};
  for (const item of targets) {
    if (change.due !== undefined) { item.dueDay = change.due; item.dueOn = returnDue(anchor, change.due); }
    if (change.method !== undefined) { item.method = change.method; if (change.method === 'manual' && !item.assignee) item.assignmentFailure = 'Manual assignment is required.'; }
    if (change.group !== undefined && change.group !== item.group) {
      if (item.assignee) extra[item.assignee] = (extra[item.assignee] ?? 0) - 1;
      item.group = change.group; item.assignee = null; item.assignmentFailure = null;
    }
    if (!item.assignee) assignReturnItem(c, config, item, env, extra);
  }
  appendLog(c, env, 'items.bulkUpdated', targets.length + ' items · ' + [change.group ? 'team ' + config.groups.find(group => group.id === change.group)!.name : '', change.method ?? '', change.due !== undefined ? 'due Day ' + change.due : ''].filter(Boolean).join(' · '));
  return targets.length;
}
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
export function merge(text: string, values: Record<string, string>, sensitive: ReadonlySet<string> = new Set(), readableMissing = false): { text: string; missing: string[] } {
  const missing: string[] = [];
  const result = text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}/g, (_, key: string) => {
    if (sensitive.has(key)) throw new V9Error('Sensitive fields cannot be included in an email.');
    if (values[key] !== undefined && values[key] !== '') return values[key];
    if (!missing.includes(key)) missing.push(key); return `[${(readableMissing && personnelMergeLabels.get(key)) || key}]`;
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
/** The persisted signed code also represents completed Review/Approve-only routes; never print a signature claim for those. */
export function documentPresentationStatus(document:Document):Document['status']{return document.signing&&document.status==='signed'&&!v9RoutedHasSigningReceipt(document)?'completed':document.status;}
/** Completed task history remains true; a signed task additionally requires a real current-round signing/acknowledgement receipt. */
export function synchronizeRoutedDocumentTasks(c:Case,document:Document){if(!document.signing||!documentFinal(document))return;for(const task of c.tasks)if(task.documentTemplate===document.templateId&&(task.documentAction==='completed'||task.documentAction==='signed'&&v9RoutedHasSigningReceipt(document)))task.status='done';}
/** Unused case-form answers never travel with a released document's merge snapshot. */
export function documentMergeValues(document: Pick<Document,'blocks'|'fields'> & { edits?: Document['edits'] }, values: Record<string,string>,restrictToUsed=false): Record<string,string> {
  const content=document.blocks.flatMap(block=>[document.edits?.[block.id]??block.text,block.rows??'',block.label??'']).join('\n');
  const used=new Set([...content.matchAll(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/g)].map(match=>match[1]));
  for(const field of document.fields)if(field.pmKey)used.add(field.pmKey);
  if(document.blocks.some(block=>block.type==='letterhead'))for(const key of ['company.name','company.regNo','company.address','company.color'])used.add(key);
  return Object.fromEntries(Object.entries(values).filter(([key])=>restrictToUsed?used.has(key):!key.startsWith('case.')||used.has(key)));
}
export function personnelFieldSourceValue(field: Field, values: Readonly<Record<string, string>>): string {
  const value = field.pmKey ? values[field.pmKey] ?? '' : '';
  if (field.type !== 'date') return value;
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = date ? `${date[3]}-${date[2]}-${date[1]}` : value;
  return validDate(iso) ? iso : '';
}
export function generate(c: Case, config: Config, templateId: string, env: Environment): Document {
  if(c.module==='off'&&env.managedResignation&&env.resignationOwnedTemplateIds?.includes(templateId))throw new V9Error('This letter is owned by the linked resignation journey. Open it in Documents instead.','conflict');
  const existing = activeDocument(c, templateId); if (existing) return existing;
  const template = config.templates.find(t => t.id === templateId && t.module === c.module);
  // As in the source opGenerate, an explicit workflow/email reference may retain a retired
  // or nonmatching template. Retirement only removes it from automatic applicability/pickers.
  if (!template) throw new V9Error('No document template is available for this module.');
  const version = currentVersion(template); if (!version) throw new V9Error('Publish the document template before using it.');
  const values: Record<string, string> = {};
  for (const field of version.fields) if (field.pmKey) values[field.id] = personnelFieldSourceValue(field, env.mergeValues);
  const doc: Document = { id: env.nextId(), templateId, version: version.version, name: template.name, status: 'draft', blocks: structuredClone(version.blocks), fields: structuredClone(version.fields), values, edits: {}, hrSignature: null, employeeSignature: null, createdAt: env.now, sentAt: null, mergeValues: documentMergeValues(version,env.mergeValues), templateType: template.type, hrStep: template.hrStep, employeeAck: template.employeeAck, signatoryUserId: env.signatoryUserId ?? null };
  if(env.personnelCompletion&&doc.fields.some(personnelCompletionManagedField)){
    if(env.personnelCompletion.available===false)throw new V9Error('The current authorized Personnel source is unavailable.','conflict');
    const source=env.personnelCompletion.source;
    if(source._sourceBasis==='unresolved-exit'&&doc.fields.some(field=>['employee.department','employee.position','employee.supervisor'].includes(field.pmKey??'')))throw new V9Error('The dated Personnel source requires review.','conflict');
    if(source._identityFieldsWithheld==='true'&&doc.fields.some(field=>['personalEmail','employee.icNo','employee.passportNo'].includes(field.pmKey??'')))throw new V9Error('Permission to view protected Personnel identity fields is required for this document.','forbidden');
    const official=Object.fromEntries(doc.fields.filter(personnelCompletionManagedField).map(field=>[field.id,personnelFieldSourceValue(field,source)]));
    initializePersonnelCompletion(doc,{country:env.personnelCompletion.country,sourceFingerprint:env.personnelCompletion.fingerprint(official,env.personnelCompletion.country),officialValues:official,actor:env.actor,at:env.now});
  }
  if(doc.personnelCompletion){doc.mergeValues=documentMergeValues(doc,{...doc.mergeValues,...Object.fromEntries(Object.entries(env.personnelCompletion!.source).filter(([key])=>!key.startsWith('_')))},true);if(env.personnelCompletion!.source._identityFieldsWithheld==='true'&&['personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo'].some(key=>Object.hasOwn(doc.mergeValues!,key)))throw new V9Error('Permission to view protected Personnel identity fields is required for this document.','forbidden');}
  initializeV9DocumentRouting(c,version,doc,env);
  c.documents.push(doc); appendLog(c, env, 'document.generated', `${doc.name} version ${doc.version}`); return doc;
}
/** Regeneration is explicit; publishing alone never replaces a person's document. */
export function canRegenerate(c: Pick<Case, 'state' | 'mails'>, document: Document): boolean {
  return ['pending', 'submitted'].includes(c.state) && !document.signing?.actions.length && !documentFinal(document) && !['superseded', 'withdrawn', 'countersign'].includes(document.status) && !documentDeliveryReserved(c, document.id);
}
export function regenerate(c: Case, config: Config, id: string, env: Environment): Document {
  const previous = c.documents.find(document => document.id === id);
  if (!previous) throw new V9Error('Document not found.', 'not_found');
  if(c.module==='off'&&env.managedResignation&&env.resignationOwnedTemplateIds?.includes(previous.templateId))throw new V9Error('Regenerate this letter through the linked resignation journey.','conflict');
  if (!canRegenerate(c, previous)) throw new V9Error('This document cannot be regenerated while closed, completed, awaiting countersignature or reserved for delivery.', 'conflict');
  const template = config.templates.find(template => template.id === previous.templateId && template.module === c.module);
  if (!template || !currentVersion(template)) throw new V9Error('Publish the document template before regenerating.');
  // A failed/cancelled/test delivery still owns its frozen document identity.
  const referenced = c.mails.some(mail => mail.documentIds.includes(id));
  if (previous.status === 'draft' && !referenced && !previous.personnelCompletion?.preparation) c.documents = c.documents.filter(document => document.id !== id);
  else previous.status = 'superseded';
  const replacement = generate(c, config, previous.templateId, env);
  if (previous.status === 'superseded') previous.supersededBy = replacement.id;
  reconcileDocumentCompletionProposals(c,previous,env);
  appendLog(c, env, 'document.regenerated', `${previous.name} (${previous.id}, v${previous.version}) replaced by ${replacement.id}, v${replacement.version}`);
  return replacement;
}
function linkedTasks(c: Case, doc: Document, action: TaskDefinition['documentAction']): void {
  for (const task of c.tasks) if (task.documentTemplate === doc.templateId && (task.documentAction === action || task.documentAction === 'completed' && action === 'signed')) task.status = 'done';
}
export function documentDeliveryReserved(c: Pick<Case, 'mails'>, documentId: string): boolean {
  return c.mails.some(mail => !mail.test && ['pending', 'sending', 'uncertain'].includes(mail.status) && mail.documentIds.includes(documentId));
}
export function missingDocumentPersonnelValues(doc: Document): string[] {
  const values = { ...doc.mergeValues,...personnelCompletionMergeValues(doc), ...doc.values };
  const missing = doc.blocks.flatMap(block => [
    doc.edits[block.id] ?? block.text, block.rows ?? '', block.label ?? '',
  ].flatMap(text => merge(text, values).missing));
  for (const field of doc.fields) {
    if (field.owner === 'pmLocked' && effectivePersonnelCompletion(doc,field)!=='employee' && field.pmKey && !doc.values[field.id]?.trim() &&
        (!field.when || doc.values[field.when.field] === field.when.value) &&
        doc.blocks.some(block => block.type === 'field' && block.fieldId === field.id ||
          block.type === 'fields' && block.section === field.section)) missing.push(field.pmKey);
  }
  return [...new Set(missing)].filter(key => personnelMergeLabels.has(key)&&!doc.fields.some(field=>field.pmKey===key&&effectivePersonnelCompletion(doc,field)==='employee'));
}
export function refreshDocumentPersonnelCompletion(doc:Document,env:Environment):boolean{
  if(!doc.personnelCompletion||personnelCompletionLocked(doc))return false;
  if(!env.personnelCompletion)throw new V9Error('Current Personnel values are unavailable. Refresh before continuing.','conflict');
  const values=Object.fromEntries(doc.fields.filter(personnelCompletionManagedField).map(field=>[field.id,personnelFieldSourceValue(field,env.personnelCompletion!.source)]));
  return reconcilePersonnelCompletion(doc,{values,sourceFingerprint:env.personnelCompletion.fingerprint(values,doc.personnelCompletion.country),actor:env.actor,at:env.now});
}
export function overrideDocumentPersonnelCompletion(c:Case,id:string,input:{fieldId:string;owner:'employee'|'hr';reason:string},env:Environment){
  const doc=c.documents.find(document=>document.id===id);if(!doc)throw new V9Error('Document not found.','not_found');
  if(c.state!=='submitted'||documentDeliveryReserved(c,id))throw new V9Error('This document is no longer editable.','conflict');
  refreshDocumentPersonnelCompletion(doc,env);overridePersonnelCompletion(doc,{...input,actor:env.actor,at:env.now});reviseV9DocumentRouting(doc,env);
  reconcileDocumentCompletionProposals(c,doc,env);
  appendLog(c,env,'document.completionOwnerChanged',`${doc.name}: ${input.fieldId}; ${input.reason.trim()}`);
}
/** An earlier submitted answer is audit history, not permission to push an abandoned draft. */
export function currentDocumentCompletionProposal(doc:Document,change:PMChange):boolean{
  if(!doc.personnelCompletion||!doc.fields.some(field=>field.owner==='pmLocked'&&field.pmKey===change.field))return true;
  if(change.provenance?.kind!=='missing-personnel'||['withdrawn','superseded'].includes(doc.status))return false;
  return doc.fields.some(field=>{const entry=doc.personnelCompletion!.fields[field.id],answer=entry?.answer;return field.pmKey===change.field&&effectivePersonnelCompletion(doc,field)==='employee'&&answer?.owner==='employee'&&answer.value===change.after&&doc.values[field.id]===change.after&&answer.by.id===change.provenance!.by.id;});
}
function reconcileDocumentCompletionProposals(c:Case,doc:Document,env:Environment){
  for(const change of c.pmChanges)if(change.documentId===doc.id&&change.status==='proposed'&&!currentDocumentCompletionProposal(doc,change)){change.status='rejected';change.superseded={at:env.now,by:{...env.actor},reason:'The active employee answer changed or completion moved to another owner'};}
}
export function submitDocumentPersonnelCompletion(c:Case,id:string,env:Environment){
  const doc=c.documents.find(document=>document.id===id);if(!doc?.personnelCompletion)throw new V9Error('This document has no Personnel completion request.','not_found');
  refreshDocumentPersonnelCompletion(doc,env);
  const issue=personnelCompletionIssues(doc,{owner:'employee',final:true})[0];if(issue)throw new V9Error(issue.message);
  if(personnelCompletionLocked(doc))throw new V9Error('Signed content is locked.','conflict');
  doc.personnelCompletion.submitted={at:env.now,by:{...env.actor},sourceFingerprint:doc.personnelCompletion.sourceFingerprint};
  reconcileDocumentCompletionProposals(c,doc,env);
  for(const answer of personnelCompletionEmployeeAnswers(doc,env.actor.id))if(!c.pmChanges.some(change=>change.documentId===id&&change.field===answer.key&&change.status==='proposed'&&change.after===answer.value&&change.provenance?.by.id===answer.by.id))c.pmChanges.push({id:env.nextId(),documentId:id,field:answer.key,before:'',after:answer.value,sourceRevision:c.sourceRevision,status:'proposed',provenance:{kind:'missing-personnel',version:1,by:{...answer.by},at:answer.at}});
  reviseV9DocumentRouting(doc,env,true);appendLog(c,env,'document.completionSubmitted',doc.name);
}
function documentPersonnelHold(doc: Document): string | null {
  if(doc.personnelCompletion){const missing=missingPersonnelCompletion(doc,'hr');if(missing.length)return 'Complete missing Personnel values for '+doc.name+': '+missing.map(field=>field.label).join(', ')+'.';}
  const missing = missingDocumentPersonnelValues(doc);
  return missing.length ? 'Complete missing Personnel values for ' + doc.name + ': ' +
    missing.map(key => personnelMergeLabels.get(key)).join(', ') + '.' : null;
}
export function fillDocumentPersonnelValues(c: Case, id: string, values: Record<string, string>, env: Environment): void {
  const doc = c.documents.find(document => document.id === id);
  if (!doc) throw new V9Error('Document not found.', 'not_found');
  if (c.state !== 'submitted' || (!doc.signing&&doc.status !== 'draft') || doc.hrSignature || doc.employeeSignature ||
      documentDeliveryReserved(c, id)) throw new V9Error('Only an unsigned draft can be filled in.', 'conflict');
  const missing = new Set(missingDocumentPersonnelValues(doc));
  for (const [key, value] of Object.entries(values)) {
    if (!missing.has(key) || !value.trim() || value.length > 20000) {
      throw new V9Error('Choose a missing Personnel value and enter a value for this document.');
    }
    for (const field of doc.fields) {
      if (field.owner === 'pmLocked' && field.pmKey === key) validateFieldValue(field, value.trim());
    }
  }
  doc.mergeValues ??= {};
  for (const [key, value] of Object.entries(values)) {
    doc.mergeValues[key] = value.trim();
    for (const field of doc.fields) {
      if (field.owner === 'pmLocked' && field.pmKey === key && !doc.values[field.id]?.trim()) doc.values[field.id] = value.trim();
    }
  }
  reviseV9DocumentRouting(doc,env);
  appendLog(c, env, 'document.saved', doc.name);
}
export function saveDocument(c: Case, id: string, values: Record<string, string>, owner: 'employee' | 'hr', env: Environment): void {
  const doc = c.documents.find(d => d.id === id); if (!doc) throw new V9Error('Document not found.', 'not_found');
  refreshDocumentPersonnelCompletion(doc,env);
  if(doc.signing&&!canEditSigningContent(doc.signing,env.actor.id)&&owner==='hr')throw new V9Error('The document is locked or it is not your turn to edit.','forbidden');
  if(doc.signing&&owner==='employee'&&doc.signing.actions.some(action=>action.action==='signed'&&action.contentHash===doc.signing!.contentHash))throw new V9Error('Signed document content is locked.','conflict');
  if (owner === 'employee' && doc.templateType === 'Attachment') throw new V9Error('Attachments are read-only PDFs.', 'forbidden');
  if (c.state !== 'submitted' || documentFinal(doc) || ['withdrawn', 'superseded'].includes(doc.status)) throw new V9Error('This document is no longer editable.', 'conflict');
  if (owner === 'hr' && !doc.signing && !doc.personnelCompletion && doc.status !== 'draft') throw new V9Error('Released document fields are frozen. Prepare a new document to make this correction.', 'conflict');
  if (owner === 'hr' && documentDeliveryReserved(c, id)) throw new V9Error('This document is frozen for email delivery.', 'conflict');
  if (owner === 'hr' && (doc.hrSignature || doc.employeeSignature)) throw new V9Error('Signed document fields are frozen. Prepare a new document to make this correction.', 'conflict');
  if (owner === 'employee' && !doc.signing && !doc.personnelCompletion?.preparation && !['sent', 'opened'].includes(doc.status)) throw new V9Error('This document has not been released to you.');
  for (const [key, value] of Object.entries(values)) {
    const field = doc.fields.find(f => f.id === key); if (!field || effectivePersonnelCompletion(doc,field) !== owner) throw new V9Error('This field cannot be changed.', 'forbidden');
    validateFieldValue(field, value);
    if(field.owner==='pmLocked')savePersonnelCompletionAnswer(doc,field,value,{owner,actor:env.actor,at:env.now});else doc.values[key] = value;
    if(owner==='employee'&&doc.personnelCompletion)delete doc.personnelCompletion.submitted;
  }
  reviseV9DocumentRouting(doc,env,owner==='employee');
  reconcileDocumentCompletionProposals(c,doc,env);
  appendLog(c, env, 'document.saved', doc.name);
}
/** Per-person wording is stored on the saved instance, never on the published template. */
export function editDocumentText(c: Case, config: Config, id: string, edits: Record<string, string>, env: Environment): void {
  const doc = c.documents.find(document => document.id === id);
  if (!doc) throw new V9Error('Document not found.', 'not_found');
  const template = config.templates.find(template => template.id === doc.templateId);
  if (!template) throw new V9Error('Document template not found.', 'not_found');
  if ((doc.templateType ?? template.type) === 'Attachment') throw new V9Error('Attachments are read-only PDFs.', 'forbidden');
  if (c.state !== 'submitted' || (!doc.signing&&doc.status !== 'draft') || doc.hrSignature || doc.employeeSignature || documentDeliveryReserved(c, id)||doc.signing&&!canEditSigningContent(doc.signing,env.actor.id)) throw new V9Error(doc.signing?'Only an unsigned document at your review step can be edited.':'Only an unsigned draft not reserved for delivery can be edited.', 'conflict');
  const editable = doc.blocks.filter(block => ['heading','subheading','text'].includes(block.type));
  if (Object.keys(edits).length > 500 || Object.entries(edits).some(([key,value]) => !editable.some(block => block.id === key) || typeof value !== 'string' || value.length > 20000)) throw new V9Error('Choose an editable title, section heading or text block.', 'forbidden');
  const saved = Object.fromEntries(Object.entries(edits).filter(([key,value]) => value !== editable.find(block => block.id === key)!.text));
  doc.edits = saved;
  reviseV9DocumentRouting(doc,env);
  appendLog(c, env, 'document.textEdited', doc.name);
}
export function signDocument(c: Case, config: Config, id: string, role: 'employee' | 'hr', signature: Signature, env: Environment): void {
  const doc = c.documents.find(d => d.id === id), template = doc && config.templates.find(t => t.id === doc.templateId);
  if (!doc || !template) throw new V9Error('Document not found.', 'not_found');
  if(doc.signing)throw new V9Error('Use the assigned signing route for this document.','conflict');
  refreshDocumentPersonnelCompletion(doc,env);
  if(doc.personnelCompletion){const issue=personnelCompletionIssues(doc,{final:true})[0];if(issue)throw new V9Error(issue.message);}
  if ((doc.templateType ?? template.type) === 'Attachment') throw new V9Error('Attachments are read-only PDFs and do not require a signature.', 'conflict');
  const hrStep = doc.hrStep ?? template.hrStep, employeeAck = doc.employeeAck ?? template.employeeAck;
  if (c.state !== 'submitted' || ['superseded', 'withdrawn'].includes(doc.status)) throw new V9Error('This document is no longer open.', 'conflict');
  if (role === 'hr' && documentDeliveryReserved(c, id)) throw new V9Error('This document is frozen for email delivery.', 'conflict');
  if (!signature.consent || !validV9SignatureValue(signature.method, signature.value) || signature.by.id !== env.actor.id) throw new V9Error('Confirm consent and provide your own signature.');
  const missing = doc.blocks.filter(b => ['heading', 'subheading', 'text'].includes(b.type)).flatMap(b => merge(doc.edits[b.id] ?? b.text, { ...doc.mergeValues,...personnelCompletionMergeValues(doc), ...doc.values }).missing);
  const personnelHold = documentPersonnelHold(doc);
  if (personnelHold) throw new V9Error(personnelHold, 'conflict');
  if (missing.length) throw new V9Error(`Complete missing document fields: ${[...new Set(missing)].join(', ')}.`);
  if (role === 'employee') {
    if (!['sent', 'opened'].includes(doc.status)) throw new V9Error('This document is not ready for employee completion.', 'conflict');
    for (const field of doc.fields) if (!field.when || doc.values[field.when.field] === field.when.value) {
      validateFieldValue(field, doc.values[field.id] ?? '');
      if (field.required && (!doc.values[field.id]?.trim() || field.type === 'checkbox' && doc.values[field.id] !== 'true' || field.type === 'table' && doc.values[field.id] === '[]')) throw new V9Error(`Complete ${field.label} before signing.`);
    }
    doc.employeeSignature = { ...signature, at: env.now, by: { ...env.actor } };
    doc.status = hrStep === 'after' ? 'countersign' : employeeAck ? 'acknowledged' : 'signed';
    for (const field of doc.fields) if (field.pmKey && !field.pmKey.startsWith('case.') && field.owner === 'employee' && (!field.when || doc.values[field.when.field] === field.when.value) && (doc.values[field.id] ?? '') !== (doc.mergeValues?.[field.pmKey] ?? '') && !c.pmChanges.some(p => p.documentId === id && p.field === field.pmKey)) c.pmChanges.push({ id: env.nextId(), documentId: id, field: field.pmKey, before: doc.mergeValues?.[field.pmKey] ?? '', after: doc.values[field.id] ?? '', sourceRevision: c.sourceRevision, status: 'proposed' });
  } else {
    if (hrStep !== 'after' && (!doc.signatoryUserId || doc.signatoryUserId !== env.actor.id)) throw new V9Error('Only the designated company HR signatory can sign this document.', 'forbidden');
    if (hrStep === 'before' && doc.status !== 'draft' || hrStep === 'after' && doc.status !== 'countersign' || hrStep === 'none') throw new V9Error('This document does not need an HR signature at this stage.', 'conflict');
    for (const field of doc.fields) if (field.owner !== 'employee' && (!field.when || doc.values[field.when.field] === field.when.value)) {
      const value = doc.values[field.id] ?? '';
      validateFieldValue(field, value);
      if (field.required && (!value.trim() || field.type === 'checkbox' && value !== 'true' || field.type === 'table' && value === '[]')) throw new V9Error(`Complete ${field.label} before signing.`);
    }
    doc.hrSignature = { ...signature, at: env.now, by: { ...env.actor }, printedTitle: hrStep === 'after' ? env.actorSignatoryTitle ?? '' : doc.mergeValues?.['signatory.title'] ?? env.mergeValues['signatory.title'] ?? '' }; doc.status = hrStep === 'before' ? 'hrsigned' : 'signed';
  }
  if (documentFinal(doc)) linkedTasks(c, doc, 'signed'); appendLog(c, env, 'document.signed', `${doc.name} · ${role}`);
}
function eligibleRecipient(id: string, env: Pick<Environment, 'eligibleUser'>): boolean { return id.startsWith('address:') ? !!v9LiteralAddress(id) : env.eligibleUser(id); }
function recipientName(id: string, env: Pick<Environment, 'userName'>): string { return v9LiteralAddress(id) ?? env.userName(id); }
function recipients(c: Case, config: Config, role: Role): string[] {
  if (role.startsWith('address:')) return v9LiteralAddress(role) ? [role] : [];
  if (role.startsWith('person:')) return [role.slice(7)];
  if (role.startsWith('group:')) return config.groups.find(group => group.id === role.slice(6))?.members ?? [];
  if (role === 'peopleOps') return config.groups.find(g => g.id === config.peopleOpsGroup)?.members ?? [];
  if (role === 'taskOwners') return [...new Set(pendingPre(c).map(t => t.assignee).filter((id): id is string => !!id))];
  const id = role === 'employee' ? c.facts.employeeUserId : role === 'supervisor' ? c.facts.supervisorUserId : role === 'ta' ? c.facts.taUserId : role === 'hrSignatory' ? config.companies?.find(company => company.companyId === c.facts.company)?.signatoryUserId : role === 'starter' ? c.facts.starterUserId ?? c.log.find(log => log.action === 'case.submitted')?.actor.id : null;
  return id ? [id] : [];
}
function recipientLabel(role: Role, config: Config, env: Pick<Environment, 'userName'>): string {
  return roleLabel(role, { group: id => config.groups.find(group => group.id === id)?.name, person: id => env.userName(id) });
}
export type ResolvedRecipient = { key: string; name: string; personal?: true };
export type StepRecipients = { to: ResolvedRecipient[]; cc: ResolvedRecipient[]; missing: RecipientMissing[]; contact?: { email: string; sourceRevision: string } };
const literalEmail = (value: string | undefined) => { const email = value?.trim() ?? ''; return email && v9LiteralAddress('address:' + email) ? email : null; };
/** One role, looked up now: Employee and Line manager come from the current Personnel facts, never the case's creation. */
function resolveRole(c: Case, config: Config, role: Role, env: Pick<Environment, 'eligibleUser' | 'userName' | 'mergeValues' | 'onboardingContact' | 'supervisorUserId' | 'supervisorRecipient'>): { found: ResolvedRecipient[]; reason: string | null; contact?: { email: string; sourceRevision: string } } {
  const user = (id: string | null | undefined, none: string, inactive = 'no longer has an active account') => !id ? { found: [], reason: none } : env.eligibleUser(id) ? { found: [{ key: id, name: recipientName(id, env) }], reason: null } : { found: [], reason: inactive };
  if (role.startsWith('address:')) return v9LiteralAddress(role) ? { found: [{ key: role, name: v9LiteralAddress(role)! }], reason: null } : { found: [], reason: 'not a valid email address' };
  if (role.startsWith('person:')) return user(role.slice(7), 'no person is chosen');
  if (role.startsWith('group:')) {
    const group = config.groups.find(group => group.id === role.slice(6));
    if (!group) return { found: [], reason: 'the assignment group no longer exists' };
    const members = [...new Set(group.members)].filter(env.eligibleUser);
    return members.length ? { found: members.map(id => ({ key: id, name: recipientName(id, env) })), reason: null } : { found: [], reason: `no active members in ${group.name}` };
  }
  if (role === 'employeeWork' || role === 'employeePersonal') {
    const email = literalEmail(env.mergeValues[role === 'employeeWork' ? 'email' : 'personalEmail']);
    return email ? { found: [{ key: 'address:' + email, name: c.facts.name, ...(role === 'employeePersonal' ? { personal: true as const } : {}) }], reason: null }
      : { found: [], reason: `${role === 'employeeWork' ? workEmailLabel() : personalEmailLabel()} is empty on the Personnel record` };
  }
  if (role === 'employee') {
    if (c.facts.employeeUserId) return user(c.facts.employeeUserId, 'Employee login is not linked');
    const contact = c.module === 'onb' ? env.onboardingContact : undefined;
    return contact ? { found: [{ key: contact.email, name: c.facts.name }], reason: null, contact } : { found: [], reason: 'Employee login is not linked' };
  }
  if (role === 'supervisor' && env.supervisorRecipient) {
    const recipient = managerRecipientResult(env.supervisorRecipient);
    return 'reason' in recipient ? { found: [], reason: recipient.reason } : { found: [recipient], reason: null };
  }
  if (role === 'supervisor') return user(env.supervisorUserId === undefined ? c.facts.supervisorUserId : env.supervisorUserId, 'no supervisor on the Personnel record', 'the line manager has no active account');
  if (role === 'ta') return user(c.facts.taUserId && env.eligibleUser(c.facts.taUserId) ? c.facts.taUserId : null, 'the TA is not linked to a user');
  if (role === 'hrSignatory') return user(config.companies?.find(company => company.companyId === c.facts.company)?.signatoryUserId, 'no HR signatory is set for the company');
  if (role === 'taskOwners') {
    const owners = [...new Set(pendingPre(c).map(task => task.assignee).filter((id): id is string => !!id))].filter(env.eligibleUser);
    return owners.length ? { found: owners.map(id => ({ key: id, name: recipientName(id, env) })), reason: null } : { found: [], reason: 'no open task has an owner' };
  }
  if (role === 'pbp') return { found: [], reason: 'PBP routing has been removed; replace this recipient' };
  if (role === 'peopleOps') {
    // The group chosen as the GBS People Ops group in Settings, every active member, looked up when the email goes out.
    if (!config.groups.some(group => group.id === config.peopleOpsGroup)) return { found: [], reason: 'no GBS People Ops group is chosen in Settings' };
    const ids = [...new Set(recipients(c, config, role))].filter(env.eligibleUser);
    return ids.length ? { found: ids.map(id => ({ key: id, name: recipientName(id, env) })), reason: null } : { found: [], reason: 'the GBS People Ops group has no active members' };
  }
  if (role === 'starter') return user(c.facts.starterUserId ?? c.log.find(log => log.action === 'case.submitted')?.actor.id, 'nobody is recorded as starting the case');
  return { found: [], reason: 'this recipient is unavailable' };
}
/** To and CC for one email, with every missing recipient named. One copy per address; To wins over CC. */
export function resolveStepRecipients(c: Case, config: Config, roles: { to: Role[]; cc: Role[] }, env: Pick<Environment, 'eligibleUser' | 'userName' | 'mergeValues' | 'onboardingContact' | 'supervisorUserId' | 'supervisorRecipient'>): StepRecipients {
  const missing: RecipientMissing[] = [], seen = new Set<string>(), out: StepRecipients = { to: [], cc: [], missing };
  for (const position of ['to', 'cc'] as const) for (const role of roles[position]) {
    const result = resolveRole(c, config, role, env);
    if (result.reason) { if (!missing.some(entry => entry.role === role)) missing.push({ role, label: recipientLabel(role, config, env), reason: result.reason }); continue; }
    if (result.contact) {
      // An onboarding contact without an account can only be the first To recipient (the delivery owner checks it there).
      if (position !== 'to') { missing.push({ role, label: recipientLabel(role, config, env), reason: 'link an employee account before copying them' }); continue; }
      out.contact = result.contact;
    }
    for (const recipient of result.found) {
      const id = (v9LiteralAddress(recipient.key) ?? recipient.key).toLowerCase();
      if (seen.has(id)) continue; seen.add(id);
      out[position].push(recipient);
    }
  }
  if (out.contact) out.to.sort((a, b) => Number(b.key === out.contact!.email) - Number(a.key === out.contact!.email));
  if (!roles.to.length) missing.push({ role: 'employeeWork', label: 'To', reason: 'no recipient is chosen for this step' });
  else if (!out.to.length && !missing.length) missing.push({ role: toRoles(roles.to)[0], label: 'To', reason: 'nobody could be found' });
  return out;
}
/** The roles a workflow step uses for this case: a per-case change wins over the workflow. */
export function stepRecipientRoles(c: Pick<Case, 'recipientOverrides'>, workflowId: string | null, step: Extract<Step, { type: 'email' | 'notify' }>, email: EmailTemplate | null | undefined): { to: Role[]; cc: Role[]; overridden: boolean } {
  const override = workflowId ? c.recipientOverrides?.[workflowId + ':' + step.id] : undefined;
  return override ? { to: [...override.to], cc: [...override.cc], overridden: true } : { to: toRoles(step.to), cc: [...new Set([...step.cc, ...(email?.cc ?? [])])], overridden: false };
}
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** Every open task with its owner, for one email to everyone. */
export function pendingTaskLines(c: Case, env: Pick<Environment, 'userName'>, bullets = false): string[] {
  return pendingPre(c).map(task => bullets
    ? `• ${task.name}${validDate(task.dueOn) ? ` (due ${Number(task.dueOn.slice(8))} ${months[Number(task.dueOn.slice(5,7))-1]})` : ''} – ${task.assignee ? env.userName(task.assignee) : 'unassigned'}`
    : `${task.name} (due ${task.dueOn}) – ${task.assignee ? env.userName(task.assignee) : 'unassigned'}`);
}
export function effectiveDelivery(c: Pick<Case, 'mails'>, original: Mail): Mail {
  let current = original; const seen = new Set<string>();
  while (!seen.has(current.id)) { seen.add(current.id); const next = c.mails.find(mail => mail.retryOf === current.id); if (!next) break; current = next; }
  return current;
}
export function retryEmail(c: Case, config: Config, id: string, reason: string, env: Environment): Mail {
  if (c.state !== 'submitted') throw new V9Error('Reopen the case before retrying delivery.', 'conflict');
  const original = c.mails.find(mail => mail.id === id);
  if (!original || original.status !== 'failed' || !original.delivery || !['smtpTemporary','smtpRejected','smtpAuthentication','smtpTls'].includes(original.failure ?? '') || c.mails.some(mail => mail.retryOf === id)) throw new V9Error('This delivery needs review and cannot be retried.', 'conflict');
  if (!reason.trim()) throw new V9Error('Record the delivery review reason before retrying.');
  if (original.templateId && !config.emails.some(email => email.id === original.templateId && email.active) || original.workflowId && !workflowFinishes(config.workflows.find(workflow => workflow.id === original.workflowId))) throw new V9Error('Turn on the email and workflow before retrying.');
  const accountRecipients = original.delivery.contact ? original.cc : [...original.to, ...original.cc];
  if (accountRecipients.some(userId => !eligibleRecipient(userId, env))) throw new V9Error('Review the unavailable recipients before retrying.');
  const next = structuredClone(original); next.id = env.nextId(); next.key = `retry:${original.id}:${next.id}`;
  next.retryOf = original.id; next.retryMode='same'; next.retryReason = reason.trim(); next.status = 'pending'; next.at = env.now; next.deliveredAt = null; next.failure = null;
  next.delivery!.queuedBy = { ...env.actor }; next.delivery!.sender = 'noreply'; c.mails.push(next);
  appendLog(c, env, 'email.retryQueued', reason.trim()); return next;
}
/** Build a fresh, reviewable template copy without changing the case or its old delivery intent. */
export function updatedDeliveryPlan(c:Case,config:Config,id:string,env:Environment):{case:Case;mail:Mail} {
  const original=c.mails.find(mail=>mail.id===id);
  if(c.state!=='submitted'||!original||!['failed','cancelled'].includes(original.status)||!original.templateId||!original.delivery||original.test||c.mails.some(mail=>mail.retryOf===id))throw new V9Error('This delivery cannot be replaced. Review its receipt.','conflict');
  if(!config.emails.some(email=>email.id===original.templateId&&email.module===c.module&&email.active))throw new V9Error('Turn on the email before preparing an updated copy.');
  let step:Extract<Step,{type:'email'}>={id:'manual',type:'email',template:original.templateId,to:'employee',cc:[]};
  if(original.workflowId){
    if(!workflowFinishes(config.workflows.find(workflow=>workflow.id===original.workflowId)))throw new V9Error('Turn on the source workflow before preparing an updated copy.');
    const candidates=c.runs.filter(run=>run.workflowId===original.workflowId).flatMap(run=>(run.definition?.steps??[]).filter((candidate):candidate is Extract<Step,{type:'email'}>=>candidate.type==='email'&&candidate.template===original.templateId&&original.key.startsWith(`${run.id}:${candidate.id}:`)));
    if(candidates.length!==1)throw new V9Error('Review the original workflow step before preparing another copy.');
    step=candidates[0];
  }
  const next=structuredClone(c),before=next.mails.length;
  enqueue(next,config,step,`updated:${original.id}:${env.nextId()}`,original.workflowId,env);
  if(next.mails.length!==before+1)throw new V9Error('Review the recipient before preparing another copy.');
  const mail=next.mails.at(-1)!;mail.retryOf=original.id;mail.retryMode='updated';
  return {case:next,mail};
}
function acceptanceDeliveryHold(c: Case, emailId: string): string | null {
  if (c.module !== 'off' || emailId !== 'e3') return null;
  const document = activeDocument(c, 't4');
  if (!document) return null;
  const mail = c.mails.find(mail => !mail.test && mail.workflowId === null && mail.key.startsWith(`acceptance:${document.id}:`));
  if (!mail) return null;
  const current = effectiveDelivery(c, mail);
  if (current.status === 'sent') return 'The acceptance email has already been sent for this document.';
  if (['pending','sending'].includes(current.status)) return 'The acceptance email is already queued or sending. Review its delivery history.';
  return 'Review the previous acceptance delivery before sending another copy.';
}
export function workflowMatches(c: Case, workflow: Workflow, today: string): boolean {
  return c.module === workflow.module && workflow.conditions.every(condition => {
    if (condition.field === 'joinWithin') { if (!validDate(c.facts.joinDate)) return false; const days = (Date.parse(c.facts.joinDate) - Date.parse(today)) / DAY; return condition.op === 'lt' ? days < Number(condition.value) : condition.op === 'gte' && days >= Number(condition.value); }
    if (condition.field === 'employmentType') { const result = v9EmploymentRule(condition.value, c.facts); return result !== null && (condition.op === 'is' ? result : condition.op === 'isNot' && !result); }
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
  edit: { subject: string; body: string }; to: Actor[]; cc: (Actor & { personal?: true })[];
  documents: { templateId: string; name: string; version: number | null; generated: boolean }[];
  holds: string[]; canSend: boolean; assets?: EmailAsset[];
  /** Board 6bdda222: sanitised rendered HTML of a rich body (CID images, document-link tokens unresolved). */
  html?: string;
};
/** Preview uses current authorized facts without generating documents, allocating IDs or queuing mail. */
export function previewEmail(c: Case, config: Config, emailId: string, env: Environment,context?:{workflowId:string;step:Extract<Step,{type:'email'}>}): EmailPreview {
  const email = config.emails.find(email => email.id === emailId && email.module === c.module);
  if (!email) throw new V9Error('Email template not found.', 'not_found');
  const stepRecipients=context?resolveStepRecipients(c,config,stepRecipientRoles(c,context.workflowId,context.step,email),env):null;
  const holds: string[] = [], edit = c.emailEdits?.[email.id] ?? { subject: email.subject, body: email.body };
  const values = { ...env.mergeValues, 'owner.name': stepRecipients?stepRecipients.to.map(recipient=>recipient.name).join(', '):c.facts.name, 'pending.tasks': context?pendingTaskLines(c,env).join('\n'):pendingPre(c).map(t => `${t.name} (due ${t.dueOn})`).join('\n') };
  const sensitive = emailSensitiveKeys(config);
  const previewValues = Object.fromEntries(Object.entries(values).filter(([key]) => !sensitive.has(key)));
  let rich: ReturnType<typeof renderTemplateBody> = null;
  try { rich = c.emailEdits?.[email.id] ? null : renderTemplateBody(email, config, previewValues, sensitive, true); } catch { holds.push('Remove sensitive fields from the email text.'); }
  const subject = merge(edit.subject, previewValues), body = rich ? { text: rich.text, missing: rich.missing } : merge(edit.body, previewValues);
  if (c.state !== 'submitted') holds.push('Submit or reopen the case before sending.');
  if (!email.active) holds.push('This email template is inactive.');
  const acceptanceHold = acceptanceDeliveryHold(c, emailId); if (acceptanceHold) holds.push(acceptanceHold);
  if (!rich && v9ImageTokens(body.text).some(id => !email.images?.some(image => image.id === id))) holds.push('Insert an available inline image before sending.');
  const usedImages = rich && email.bodyDoc ? new Set(emailBodyImageIds(email.bodyDoc)) : new Set(v9ImageTokens(body.text));
  const missing = [...new Set([...subject.missing, ...body.missing])];
  if (missing.length) holds.push(`Complete missing merge fields: ${missing.join(', ')}.`);
  try { merge(edit.subject + '\n' + edit.body, previewValues, sensitive); } catch { holds.push('Remove sensitive fields from the email text.'); }
  const contact = context?stepRecipients?.contact:c.module === 'onb' && !c.facts.employeeUserId ? env.onboardingContact : undefined;
  const target = c.facts.employeeUserId ?? contact?.email;
  const to = stepRecipients?stepRecipients.to.map(recipient=>({id:recipient.key,name:recipient.name})):target && (contact || env.eligibleUser(target)) ? [{ id: target, name: contact ? c.facts.name : recipientName(target, env) }] : [];
  if (!context&&!to.length) holds.push('Link an available employee account or enter the onboarding contact before sending.');
  if (contact && email.links.length) holds.push('Link an employee account before sending document links.');
  const imageCount = (email.images ?? []).filter(image => usedImages.has(image.id)).length;
  const caseFileCount = c.files.filter(file => email.slots.some(slot => file.slot === `${email.id}:${slot.id}`)).length;
  if ((email.files?.length ?? 0) + imageCount + email.attachments.length + caseFileCount > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) holds.push('Keep the total attached files and inline images within 20.');
  if ([...(email.files ?? []), ...(email.images ?? []).filter(image => usedImages.has(image.id))].reduce((sum, asset) => sum + asset.size, 0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES) holds.push('Keep the total attached files and inline images within 20 MB.');
  const copied = stepRecipients??resolveStepRecipients(c, config, { to: ['employee'], cc: email.cc }, env);
  for (const entry of copied.missing) if (context||email.cc.includes(entry.role)) holds.push(`${context?'Resolve recipient':'Resolve the CC recipient'}: ${entry.label}: ${entry.reason}.`);
  const cc = copied.cc.filter(recipient => context||recipient.key !== target).map(recipient => ({ id: recipient.key, name: recipient.name, ...(recipient.personal ? { personal: true as const } : {}) }));
  const documents = [...new Set([...email.links, ...email.attachments])].flatMap(templateId => {
    const template = config.templates.find(template => template.id === templateId && template.module === c.module), document = activeDocument(c, templateId);
    if (!template) { holds.push('A linked document template is unavailable.'); return []; }
    const version = document?.version ?? currentVersion(template)?.version ?? null;
    if (!version) holds.push(`Publish ${template.name} before sending.`);
    if (document?.signing?!v9RouteReadyForEmployee(document):(document?.hrStep ?? template.hrStep) === 'before' && !document?.hrSignature) holds.push(`HR must review and sign ${template.name} before sending.`);
    return [{ templateId, name: document?.name ?? template.name, version, generated: !!document }];
  });
  for (const slot of email.slots) if (slot.required && !c.files.some(file => file.slot === `${email.id}:${slot.id}`)) holds.push(`Upload ${slot.label}.`);
  if (email.id === 'e3') {
    const acceptance = activeDocument(c, 't4');
    if (!(acceptance?.signing?v9RouteReadyForEmployee(acceptance):acceptance?.hrSignature) && !holds.some(hold => hold.startsWith('HR must review and sign'))) holds.push('HR must review and sign the acceptance letter before sending.');
  }
  const assets = [...(email.files ?? []), ...(email.images ?? []).filter(image => usedImages.has(image.id))];
  return { emailId, name: email.name, subject: subject.text, body: body.text, ...(rich ? { html: rich.html } : {}), edit: { ...edit }, to, cc, documents, holds: [...new Set(holds)], canSend: holds.length === 0, ...(assets.length ? { assets: structuredClone(assets) } : {}) };
}
export function emailSensitiveKeys(config: Config): Set<string> {
  const identityKeys = ['icNo', 'passportNo', 'taxNo', 'epfNo', 'bankAcc', 'bankAccount', 'bankAccountNo', 'spIc', 'spTax', 'race', 'religion'];
  return new Set([...identityKeys.flatMap(key => [key, `employee.${key}`, `case.${key}`]), ...(['onb','off'] as const).flatMap(module => resolveV9CaseFields(module,config.caseForms?.[module],true).filter(field=>field.hrOnly).map(field=>`case.${field.key}`)), ...config.templates.flatMap(t => t.versions.flatMap(v => v.fields.filter(f => f.sensitive).flatMap(f => [f.id, ...(f.pmKey ? [f.pmKey, `employee.${f.pmKey}`] : [])])))]);
}

/** A wait text, a recipient hold (nothing queued, CC included), or nothing to wait for. */
export type EnqueueOutcome = { wait: string } | { held: RecipientMissing[] } | null;
function enqueue(c: Case, config: Config, step: Extract<Step, { type: 'email' | 'notify' }>, key: string, workflowId: string | null, env: Environment, test = false): EnqueueOutcome {
  const original = c.mails.filter(mail => mail.workflowId === workflowId && (mail.key === key || mail.key.startsWith(key + ':')));
  const existing = [...new Map(original.map(mail => { const current = effectiveDelivery(c, mail); return [current.id, current] as const; })).values()];
  const deliveryHold = (mails: Mail[]) => { const wait = !workflowId || !env.requireDeliveryAck || mails.every(mail => mail.status === 'sent') ? null : mails.some(mail => mail.status === 'uncertain') ? 'Delivery outcome is uncertain. Review the delivery receipt before continuing.' : mails.some(mail => ['failed', 'cancelled'].includes(mail.status)) ? 'Email delivery did not complete. Review the delivery failure.' : 'Waiting for email delivery confirmation.'; return wait ? { wait } : null; };
  // Resume the original recipients even if roles or task ownership changed meanwhile.
  if (existing.length) return deliveryHold(existing);
  const email = step.type === 'email' ? config.emails.find(e => e.id === step.template && (e.active || test) && e.module === c.module) : null;
  if (step.type === 'email' && !email) {
    if (workflowId && config.emails.some(email => email.id === step.template && email.module === c.module && !email.active)) return { wait: 'This email is turned off. Turn it on before continuing.' };
    throw new V9Error('The email template is inactive or unavailable.');
  }
  const slots = email?.slots.filter(s => s.required && !c.files.some(f => f.slot === `${email.id}:${s.id}`)) ?? [];
  if (slots.length && !test) return { wait: `Upload ${slots.map(s => s.label).join(', ')}.` };
  // Look everyone up now. If anyone in To or CC is missing, nobody is emailed and the step waits for Continue.
  const resolved: StepRecipients = test ? { to: [{ key: env.actor.id, name: recipientName(env.actor.id, env) }], cc: [], missing: [] } : resolveStepRecipients(c, config, stepRecipientRoles(c, workflowId, step, email), env);
  if (resolved.missing.length) return { held: resolved.missing };
  const contact = resolved.contact;
  if (contact && email?.links.length) return { wait: 'Link an employee account before sending document links.' };
  if (!test && [...resolved.to, ...resolved.cc].some(recipient => recipient.key !== contact?.email && !eligibleRecipient(recipient.key, env))) throw new V9Error('A selected recipient is no longer eligible for delivery. Review the recipients before continuing.');
  const sensitive = emailSensitiveKeys(config);
  const itemKey = `${key}:main`;
  if (!c.mails.some(m => m.key === itemKey)) {
    // One email to everyone in To and CC. {owner.name} is the To person, or the To names together.
    const values = { ...env.mergeValues, 'owner.name': resolved.to.map(recipient => recipient.name).join(', '), 'pending.tasks': pendingTaskLines(c, env).join('\n') };
    const edits = email ? c.emailEdits?.[email.id] : null;
    // A per-person edit is a text edit and keeps the text path; otherwise a saved rich body renders HTML and text.
    const rich = email && !edits ? renderTemplateBody(email, config, values, sensitive, test) : null;
    const subject = merge(edits?.subject ?? email?.subject ?? (step.type === 'notify' ? step.subject : ''), values, sensitive), body = rich ? { text: rich.text, missing: rich.missing } : merge(edits?.body ?? email?.body ?? (step.type === 'notify' ? step.body : ''), values, sensitive);
    if (!test && (subject.missing.length || body.missing.length)) throw new V9Error(`Complete missing merge fields: ${[...new Set([...subject.missing, ...body.missing])].join(', ')}.`);
    if (!rich && v9ImageTokens(body.text).some(id => !email?.images?.some(image => image.id === id))) throw new V9Error('Insert an available inline image before sending.');
    const usedImages = rich && email?.bodyDoc ? new Set(emailBodyImageIds(email.bodyDoc)) : new Set(v9ImageTokens(body.text));
    const docs = [...new Set([...(email?.links ?? []), ...(email?.attachments ?? [])])].flatMap(id => {
      const d = activeDocument(c, id) ?? (test ? null : generate(c, config, id, env)), template = config.templates.find(t => t.id === id);
      if (!d) return [];
      if ((d.hrStep ?? template?.hrStep) === 'before' && d.status === 'draft' && !test) throw new V9Error('HR must sign the letter before it can be sent.');
      const hold = !test && documentPersonnelHold(d);
      if (hold) throw new V9Error(hold, 'conflict');
      return [d];
    });
    const assetCount = (email?.files?.length ?? 0) + (email?.images ?? []).filter(image => usedImages.has(image.id)).length;
    if (assetCount + (email?.attachments.length ?? 0) + c.files.filter(file => email?.slots.some(slot => file.slot === `${email.id}:${slot.id}`)).length > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) throw new V9Error('Keep the total attached files and inline images within 20.');
    // One On/Off Boarding sender: its display name is the tenant's setting, resolved when the message is sent.
    const sender = 'noreply' as const;
    const assets = structuredClone([...(email?.files ?? []), ...(email?.images ?? []).filter(image => usedImages.has(image.id))]);
    if (assets.reduce((sum, asset) => sum + asset.size, 0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES) throw new V9Error('Keep the total attached files and inline images within 20 MB.');
    if (rich && new TextEncoder().encode(rich.html).length > 1_000_000) throw new V9Error('This email is too large to send. Shorten the body.');
    const personalKeys = [...resolved.to, ...resolved.cc].filter(recipient => recipient.personal).map(recipient => recipient.key);
    c.mails.push({ id: env.nextId(), key: itemKey, workflowId, templateId: email?.id ?? null, to: resolved.to.map(recipient => recipient.key), cc: resolved.cc.map(recipient => recipient.key), subject: subject.text, body: body.text, documentIds: docs.map(d => d.id), delivery: { version: rich ? 2 : 1, ...(rich ? { html: rich.html } : {}), queuedBy: { ...env.actor }, sender, linkDocumentIds: docs.filter(document => email?.links.includes(document.templateId)).map(document => document.id), pdfDocumentIds: docs.filter(document => email?.attachments.includes(document.templateId)).map(document => document.id), toNames: resolved.to.map(recipient => recipient.name), ccNames: resolved.cc.map(recipient => recipient.name), ...(assets.length ? { assets } : {}), ...(contact ? { contact: { kind: 'onboardingContact' as const, caseId: c.id, email: contact.email, sourceRevision: contact.sourceRevision } } : {}), ...(personalKeys.length ? { personalKeys } : {}) }, fileIds: c.files.filter(f => email?.slots.some(s => f.slot === `${email.id}:${s.id}`)).map(f => f.id), status: 'pending', test, at: env.now, deliveredAt: null, failure: null });
    appendLog(c, env, test ? 'email.test.queued' : 'email.queued', `${email?.name ?? subject.text} · ${resolved.to.map(recipient => recipient.name).join(', ')}`);
  }
  return deliveryHold(c.mails.filter(mail => mail.workflowId === workflowId && mail.key.startsWith(key + ':')));
}
/** Board 6bdda222: render a template's rich body with merged values. Every value is escaped by the renderer. */
export function renderTemplateBody(email: EmailTemplate, config: Config, values: Record<string, string>, sensitive: ReadonlySet<string>, readableMissing = false) {
  if (!email.bodyDoc) return null;
  return renderEmailBody(email.bodyDoc, { values, sensitive: key => sensitive.has(key), readableMissing, missingLabel: key => personnelMergeLabels.get(key),
    images: (email.images ?? []).map(image => ({ id: image.id, alt: image.alt || image.name, cid: v9ImageCid(image.id) })),
    documentLink: id => { const template = config.templates.find(template => template.id === id && template.module === email.module); return template && email.links.includes(id) ? { name: template.name } : null; } });
}
const heldText = (missing: RecipientMissing[]) => 'Email held. Nobody was emailed because ' + (missing.length === 1 ? 'a recipient is' : 'recipients are') + ' missing: ' + missing.map(entry => `${entry.label}: ${entry.reason}`).join('; ') + '. Fix it and press Continue.';
const outcomeText = (outcome: EnqueueOutcome) => !outcome ? null : 'wait' in outcome ? outcome.wait : heldText(outcome.held);
export function queueEmail(c: Case, config: Config, emailId: string, env: Environment, test = false): void {
  if (c.state !== 'submitted' && !test) throw new V9Error('Only an open case can send email.', 'conflict');
  const email = config.emails.find(e => e.id === emailId && e.module === c.module);
  if (!email) throw new V9Error('Email template not found.', 'not_found');
  const acceptance = c.module === 'off' && emailId === 'e3';
  const doc = acceptance ? activeDocument(c, 't4') : null;
  if (!test) { const hold = acceptanceDeliveryHold(c, emailId); if (hold) throw new V9Error(hold, 'conflict'); }
  if (acceptance && !test && (!doc || (doc.signing?!v9RouteReadyForEmployee(doc):!doc.hrSignature))) throw new V9Error('HR must review and sign the acceptance letter before sending.');
  const key = test ? `test:${env.nextId()}` : acceptance ? `acceptance:${doc!.id}` : `manual:${env.nextId()}`;
  const held = outcomeText(enqueue(c, config, { id: key, type: 'email', template: emailId, to: 'employee', cc: [] }, key, null, env, test));
  if (held) throw new V9Error(held);
}
export function previewWorkflowNotification(c: Case, config: Config, step: Extract<Step,{type:'notify'}>, env: Environment, workflowId: string | null = null) {
 const roles=stepRecipientRoles(c,workflowId,step,null),resolved=resolveStepRecipients(c,config,roles,env),lines=pendingTaskLines(c,env,true);
 const values={...env.mergeValues,'owner.name':resolved.to.map(recipient=>recipient.name.split(' ')[0]).join(', '),'pending.count':String(lines.length),'pending.tasks':lines.length?lines.join('\n'):'Nothing pending'};
 const ownerText=(text:string)=>text.split('{owner.name}').join(values['owner.name']).split('{pending.count}').join(values['pending.count']).split('{pending.tasks}').join(values['pending.tasks']);
 return {subject:merge(ownerText(step.subject),env.mergeValues,emailSensitiveKeys(config)).text,body:merge(ownerText(step.body),env.mergeValues,emailSensitiveKeys(config)).text,to:roles.to.map(role=>recipientLabel(role,config,env)).join(', '),cc:roles.cc.map(role=>recipientLabel(role,config,env)).join(', ')};
}
/** A workflow test queues only its message steps to the actor, never advancing a run or employee work. */
export function testWorkflowMessages(c: Case, config: Config, workflowId: string, env: Environment): void {
  const workflow = config.workflows.find(workflow => workflow.id === workflowId && workflow.module === c.module);
  if (!workflow) throw new V9Error('Workflow not found.', 'not_found');
  if (workflow.status === 'retired') throw new V9Error('This workflow is retired. Restore it before testing it.', 'conflict');
  const message = workflow.steps.find(step=>step.type==='email') ?? workflow.steps.find(step=>step.type==='notify');
  if (!message || (message.type!=='email' && message.type!=='notify')) throw new V9Error('This workflow has no message to test.');
  for (const step of [message]) {
    const output=step.type==='notify'?{...step,...previewWorkflowNotification(c,config,step,env),to:step.to,cc:step.cc}:step;
    const hold = outcomeText(enqueue(c, config, output, `test:${env.nextId()}`, null, env, true));
    if (hold) throw new V9Error(hold);
  }
}
/** Source dry run: inspect every step against current data, independent of submission/date eligibility. */
export type PlanEnvironment = Pick<Environment, 'today' | 'userName'> & Partial<Pick<Environment, 'eligibleUser' | 'mergeValues' | 'onboardingContact' | 'userEmail' | 'supervisorUserId' | 'supervisorRecipient'>> & { revealPersonal?: boolean; workflowId?: string | null };
export function planWorkflow(c: Case, config: Config, workflow: Workflow, env: PlanEnvironment): { matches: boolean; lines: { text: string; ok: boolean }[] } {
  const matches = workflowMatches(c, workflow, env.today), lines: { text: string; ok: boolean }[] = [];
  if (!matches) return { matches, lines: [{ text: 'Skipped: this record does not match the conditions.', ok: false }] };
  lines.push({ text: 'Conditions match.', ok: true });
  const skipped = skipReason(c, workflow, config);
  if (skipped) return { matches, lines: [...lines, { text: `Would skip: ${skipped}`, ok: true }] };
  const lookup = { eligibleUser: env.eligibleUser ?? (() => true), userName: env.userName, mergeValues: env.mergeValues ?? {}, onboardingContact: env.onboardingContact, supervisorUserId: env.supervisorUserId, supervisorRecipient: env.supervisorRecipient };
  // A selected personal mailbox stays protected when another role resolves to the same address.
  const protectedPersonal = literalEmail(env.mergeValues?.personalEmail)?.toLowerCase();
  // Each person and the address they are reached at. Personal email is masked unless the viewer may see it.
  const shown = (recipient: ResolvedRecipient) => { const address = v9LiteralAddress(recipient.key) ?? (recipient.key.includes('@') ? recipient.key : env.userEmail?.(recipient.key)); return address ? `${recipient.name} <${(recipient.personal || address.toLowerCase() === protectedPersonal) && !env.revealPersonal ? maskEmail(address) : address}>` : `${recipient.name} (account email)`; };
  const message = (step: Extract<Step, { type: 'email' | 'notify' }>, what: string, active: boolean) => {
    const email = step.type === 'email' ? config.emails.find(e => e.id === step.template) : null;
    const roles = stepRecipientRoles(c, env.workflowId ?? workflow.id, step, email), resolved = resolveStepRecipients(c, config, roles, lookup);
    if (env.userEmail) {
      // Match the delivery owner's address dedupe, including a literal address equal to an account destination.
      const seen = new Set<string>();
      for (const position of ['to', 'cc'] as const) resolved[position] = resolved[position].filter(recipient => {
        const address = v9LiteralAddress(recipient.key) ?? (recipient.key.includes('@') ? recipient.key : env.userEmail!(recipient.key));
        if (!address) { resolved.missing.push({ role: `person:${recipient.key}`, label: recipient.name, reason: 'no verified account email is available' }); return true; }
        const key = address.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
      });
    }
    if (resolved.missing.length) return { text: `Would hold ${what}: nobody is emailed because ${resolved.missing.map(entry => `${entry.label}: ${entry.reason}`).join('; ')}.${env.userEmail && (resolved.to.length || resolved.cc.length) ? ` Found To: ${resolved.to.map(shown).join(', ') || 'No one'}; CC: ${resolved.cc.map(shown).join(', ') || 'No one'}.` : ''}`, ok: false };
    return { text: `Would send ${what} to ${resolved.to.map(shown).join(', ')}${resolved.cc.length ? ', CC ' + resolved.cc.map(shown).join(', ') : ''}${roles.overridden ? ' (recipients changed for this case)' : ''}`, ok: active };
  };
  for (const step of workflow.steps) {
    if (step.type === 'doc') { const doc = activeDocument(c, step.template), template = config.templates.find(t => t.id === step.template); lines.push({ text: doc ? `Already generated: ${doc.name} (v${doc.version})` : `Would generate ${template?.name ?? 'a document'}`, ok: !!template }); }
    else if (step.type === 'email') { const email = config.emails.find(e => e.id === step.template); lines.push(message(step, `"${email?.name ?? ''}"`, !!email?.active)); }
    else if (step.type === 'notify') lines.push(message(step, `"${step.subject || 'the notification'}"`, true));
    else if (step.type === 'waitFile') { const present = c.files.some(file => file.slot === step.slot); lines.push({ text: present ? `${step.label || 'The file'} is uploaded, so it carries on.` : `Would wait: ${step.label || 'the file'} is not uploaded yet.`, ok: present }); }
    else { const doc = activeDocument(c, step.template), name = config.templates.find(t => t.id === step.template)?.name ?? 'the document', signed = step.by === 'hr' ? !!doc&&(doc.signing?v9RoutedHrComplete(doc):!!doc.hrSignature) : !!doc && documentFinal(doc); lines.push({ text: signed ? `${name} is signed, so it carries on.` : `Would wait for ${name} to be signed by ${step.by === 'hr' ? 'the HR signatory' : c.facts.name}.`, ok: signed }); }
  }
  return { matches, lines };
}
/** Frozen workflow dates govern held mail; a repeated reminder keeps the run's own day. */
export function heldEmailDueOn(c: Pick<Case, 'facts'>, run: Run): string | null {
  if(run.completionHold)return run.completionHold.dueOn&&validDate(run.completionHold.dueOn)?run.completionHold.dueOn:null;
  const trigger = run.definition?.trigger;
  if (!trigger || !dateTrigger(trigger.event) || trigger.repeat) return validDate(run.date) ? run.date : null;
  const anchor = ['beforeLWD', 'afterLWD'].includes(trigger.event) ? c.facts.lastDay : c.facts.joinDate;
  return validDate(anchor) ? addDays(anchor, afterTrigger(trigger.event) ? trigger.days : -trigger.days, trigger.workdays) : null;
}
/** Only an existing held step, under the caller's case/revision authority, accepts a late decision. */
export function decideLateEmail(c: Case, config: Config, input: { workflowId: string; runId: string; stepId: string; decision: 'send' | 'skip' }, env: Environment): Run | null {
  if (env.actor.id === 'system') throw new V9Error('HR must decide whether a late email is sent.', 'forbidden');
  const run = c.runs.find(run => run.id === input.runId && run.workflowId === input.workflowId && run.status === 'waiting');
  const definition = run?.definition ?? config.workflows.find(workflow => workflow.id === input.workflowId);
  const step = definition?.steps[run?.cursor ?? -1];
  const due = run && heldEmailDueOn(c, run);
  if (!run || !definition || !step || !['email', 'notify'].includes(step.type) || step.id !== input.stepId || !(run.hold?.stepId === step.id || run.lateEmail?.stepId === step.id) || !due || due >= env.today) throw new V9Error('This late email changed. Refresh before deciding.', 'conflict');
  if(c.mails.some(mail=>mail.workflowId===definition.id&&(mail.key===`${run.id}:${step.id}`||mail.key.startsWith(`${run.id}:${step.id}:`))))throw new V9Error('This email already has a delivery record. Review its receipt.','conflict');
  return runWorkflow(c, config, definition, env, 'resume', { continueHeld: true, lateDecision: input });
}
export function runWorkflow(c: Case, config: Config, workflow: Workflow, env: Environment, event: 'submitted' | 'date' | 'resume' | 'hrSigned' | 'docSigned' | 'manual', options: { startNow?: boolean; continueHeld?: boolean; resumeRunId?:string; sourceEvent?:Run['sourceEvent'];lateDecision?:{runId:string;stepId:string;decision:'send'|'skip'} } = {}): Run | null {
  if (c.module === 'off' && env.managedResignation) return null;
  const unfinished = c.runs.find(r => r.workflowId === workflow.id && (r.status === 'waiting' || r.status === 'failed') && (!options.resumeRunId || r.id===options.resumeRunId) && (!options.lateDecision || r.id === options.lateDecision.runId) && (!options.sourceEvent || r.sourceEvent?.kind===options.sourceEvent.kind && r.sourceEvent.sourceId===options.sourceEvent.sourceId && r.sourceEvent.revision===options.sourceEvent.revision));
  // A held email waits for HR: fixing a record alone sends nothing until someone presses Continue.
  if ((unfinished?.hold || unfinished?.lateEmail) && unfinished.status === 'waiting' && !options.continueHeld) return unfinished;
  // A retired workflow starts nothing new, but a run that already started finishes with the steps it saved.
  const finishing = workflow.status === 'retired' && event === 'resume' && !!unfinished;
  if (c.state !== 'submitted' || workflow.status !== 'published' && !finishing) return null;
  if (unfinished?.definition) workflow = unfinished.definition;
  else if (finishing) workflow = { ...workflow, status: 'published' };
  if (c.state !== 'submitted' || workflow.status !== 'published' || !(event === 'resume' && unfinished?.sourceEvent) && !workflowMatches(c, workflow, env.today)) return null;
  const trigger = workflow.trigger, anchor = ['beforeLWD','afterLWD'].includes(trigger.event) ? c.facts.lastDay : c.facts.joinDate;
  if (event !== 'resume' && !options.startNow && (event === 'date' ? !dateTrigger(trigger.event) : trigger.event !== event)) return null;
  const waiting = event === 'resume' ? unfinished : null;
  if (event === 'resume' && !waiting) return null;
  if (dateTrigger(trigger.event) && !waiting && !options.startNow) {
    if (!validDate(anchor)) return null;
    const due = addDays(anchor, afterTrigger(trigger.event) ? trigger.days : -trigger.days, trigger.workdays);
    if (env.today < due || !afterTrigger(trigger.event) && env.today > anchor) return null;
  }
  const repeat = trigger.repeat && dateTrigger(trigger.event) && !afterTrigger(trigger.event);
  const runKey = waiting?.id ?? `${workflow.id}:${options.sourceEvent ? `${options.sourceEvent.kind}:${options.sourceEvent.sourceId}:${options.sourceEvent.revision}` : repeat ? env.today : 'once'}`;
  let run = c.runs.find(r => r.id === runKey);
  if (run?.status === 'done') return run;
  if (!run) { run = { id: runKey, workflowId: workflow.id, revision: config.revision, date: env.today, status: 'running', cursor: 0, reason: '', at: env.now, definition: structuredClone(workflow), actor: { ...env.actor },...(options.sourceEvent?{sourceEvent:structuredClone(options.sourceEvent)}:{}) }; c.runs.push(run); }
  if (run.resumeOn && env.today < run.resumeOn) return run;
  delete run.resumeOn;
  const skip = skipReason(c, workflow, config); if (skip) { if (run.status !== 'skipped' || run.reason !== skip) appendLog(c, env, 'workflow.skipped', `${workflow.name}: ${skip}`); run.status = 'skipped'; run.reason = skip; return run; }
  run.status = 'running';
  try {
    while (run.cursor < workflow.steps.length) {
      const step = workflow.steps[run.cursor]; let waiting = '';
      if (step.type === 'doc') {
        const doc = generate(c, config, step.template, env), template = config.templates.find(t => t.id === step.template);synchronizeRoutedDocumentTasks(c,doc);
        if (step.release && (['draft', 'hrsigned'].includes(doc.status)||doc.signing&&!doc.sentAt&&!['withdrawn','superseded'].includes(doc.status))) {
          const employeePreparation=doc.personnelCompletion&&!personnelCompletionLocked(doc)&&!doc.personnelCompletion.submitted&&doc.fields.some(field=>field.required&&effectivePersonnelCompletion(doc,field)==='employee'&&(!field.when||doc.values[field.when.field]===field.when.value));
          if(employeePreparation){
            const hold=documentPersonnelHold(doc);
            if(hold)waiting=hold;
            else {if(!doc.personnelCompletion!.preparation){doc.personnelCompletion!.preparation={at:env.now,by:{...env.actor}};appendLog(c,env,'document.preparationOpened',doc.name);}waiting='Waiting for the employee to complete required Personnel answers before the first signature.';}
          }
          else if (doc.signing?!v9RouteReadyForEmployee(doc):(doc.hrStep ?? template?.hrStep) === 'before' && !doc.hrSignature) waiting = 'HR must sign before release.';
          else {
            waiting = documentPersonnelHold(doc) ?? '';
            if (!waiting) { if(!doc.signing||!documentFinal(doc))doc.status = 'sent'; doc.sentAt = env.now; linkedTasks(c, doc, 'sent'); appendLog(c, env, 'document.released', doc.name); }
          }
        }
        if(waiting&&step.release&&doc.personnelCompletion&&!run.completionHold){
          run.completionHold={documentId:doc.id,stepId:step.id,dueOn:heldEmailDueOn(c,run),at:env.now};
          appendLog(c,env,'workflow.personnelCompletionHeld',`${workflow.name}: ${doc.name}`);
        }
      } else if (step.type === 'waitSign') { const d = activeDocument(c, step.template);if(d)synchronizeRoutedDocumentTasks(c,d); if (!(step.by === 'hr' ? d&&(d.signing?v9RoutedHrComplete(d):d.hrSignature) : d && documentFinal(d))) waiting = `Waiting for ${step.by === 'hr' ? 'HR' : 'the employee'} to sign.`; }
      else if (step.type === 'waitFile') { if (!c.files.some(f => f.slot === step.slot)) waiting = `Waiting for ${step.label}.`; }
      else {
        const dueOn = heldEmailDueOn(c, run);
        const captured=c.mails.some(mail=>mail.workflowId===workflow.id&&(mail.key===`${run.id}:${step.id}`||mail.key.startsWith(`${run.id}:${step.id}:`)));
        if(run.completionHold&&!captured&&!dueOn){run.status='waiting';run.reason='The original scheduled date is unavailable. HR must review this workflow.';return run;}
        if(run.completionHold&&!captured&&dueOn&&dueOn>env.today){run.resumeOn=dueOn;run.status='waiting';run.reason=`Waiting until the original scheduled date ${dueOn}.`;return run;}
        if (!captured&&(run.hold?.stepId === step.id || run.lateEmail?.stepId === step.id || run.completionHold) && dueOn && dueOn < env.today) {
          const decision = options.lateDecision;
          if (!decision || decision.runId !== run.id || decision.stepId !== step.id || env.actor.id === 'system') {
            run.lateEmail = { stepId: step.id, dueOn, at: run.lateEmail?.at ?? env.now };
            run.status = 'waiting'; run.reason = `This held email was due on ${dueOn}. HR must choose Send anyway or Skip this email.`;
            return run;
          }
          // No decision may replay a captured, delivered or uncertain message.
          if (c.mails.some(mail => mail.workflowId === workflow.id && mail.key.startsWith(`${run.id}:${step.id}:`))) throw new V9Error('This email already has a delivery record. Review its receipt.', 'conflict');
          appendLog(c, env, decision.decision === 'skip' ? 'workflow.lateEmailSkipped' : 'workflow.lateEmailApproved', `${workflow.name}: ${stepMessageName(config, step)} · due ${dueOn}`);
          if (decision.decision === 'skip') { delete run.hold; delete run.lateEmail; run.cursor++; continue; }
        }
        const outcome = enqueue(c, config, step, `${run.id}:${step.id}`, workflow.id, env);
        if (outcome && 'held' in outcome) { holdEmail(c, config, workflow, run, step, outcome.held, env); return run; }
        if (run.hold?.stepId === step.id) { appendLog(c, env, 'workflow.emailReleased', `${workflow.name}: ${stepMessageName(config, step)}`); delete run.hold; }
        // A captured receipt owns further delivery progress; approval never needs to replay it.
        if (!outcome||c.mails.some(mail=>mail.workflowId===workflow.id&&(mail.key===`${run.id}:${step.id}`||mail.key.startsWith(`${run.id}:${step.id}:`)))) delete run.lateEmail;
        waiting = outcome?.wait ?? '';
      }
      if (waiting) { run.status = 'waiting'; run.reason = waiting; return run; }
      run.cursor++;
    }
    run.status = 'done'; run.reason = ''; delete run.completionHold; appendLog(c, env, 'workflow.completed', workflow.name);
  } catch (error) { run.status = 'failed'; run.reason = error instanceof Error ? error.message : 'Workflow could not complete.'; appendLog(c, env, 'workflow.failed', `${workflow.name}: ${run.reason}`); }
  return run;
}
function stepMessageName(config: Config, step: Extract<Step, { type: 'email' | 'notify' }>): string { return step.type === 'email' ? config.emails.find(email => email.id === step.template)?.name ?? 'Email' : step.subject || 'Notification'; }
const missingKey = (missing: RecipientMissing[]) => missing.map(entry => entry.role + ':' + entry.reason).sort().join('|');
/** Nothing is queued for the step. The case shows who is missing; Full case view users get one alert per distinct missing set. */
function holdEmail(c: Case, config: Config, workflow: Workflow, run: Run, step: Extract<Step, { type: 'email' | 'notify' }>, missing: RecipientMissing[], env: Environment): void {
  const changed = run.hold?.stepId !== step.id || missingKey(run.hold.missing) !== missingKey(missing);
  run.status = 'waiting'; run.reason = heldText(missing);
  if (!changed) return;
  run.hold = { stepId: step.id, missing: structuredClone(missing), at: env.now };
  const name = stepMessageName(config, step);
  appendLog(c, env, 'workflow.emailHeld', `${workflow.name}: ${name} · ${missing.map(entry => `${entry.label}: ${entry.reason}`).join('; ')}`);
  const alert = [...new Set(env.holdAlertUserIds ?? [])].filter(env.eligibleUser);
  if (!alert.length) { appendLog(c, env, 'email.routingFailed', `Nobody with Full case view could be alerted that ${name} is held.`); return; }
  for (let index = 0; index < alert.length; index += MAX_RECIPIENT_CHOICES) {
    const to = alert.slice(index, index + MAX_RECIPIENT_CHOICES);
    // Like the last-day review: a direct operational message with no workflow, so it never holds a workflow delivery.
    c.mails.push({ id: env.nextId(), key: `hold-alert:${run.id}:${step.id}:${env.now}:${index / MAX_RECIPIENT_CHOICES}`, workflowId: null, templateId: null, to, cc: [],
      subject: `Email held for ${c.facts.name} (${c.number}): ${name}`,
      body: `The email "${name}" in the workflow "${workflow.name}" for ${c.facts.name} (${c.number}) was not sent to anyone because ${missing.length === 1 ? 'a recipient is' : 'recipients are'} missing:\n\n${missing.map(entry => `- ${entry.label}: ${entry.reason}`).join('\n')}\n\nFix the record or change the recipients for this case, then press Continue on the case. Nobody receives the email until then.`,
      documentIds: [], fileIds: [], delivery: { version: 1, queuedBy: { ...env.actor }, sender: 'noreply', linkDocumentIds: [], pdfDocumentIds: [], toNames: to.map(env.userName), ccNames: [] }, status: 'pending', test: false, at: env.now, deliveredAt: null, failure: null });
  }
}
/** The email and notify steps a case can change recipients for: live workflows and frozen runs of this case. */
export function caseMessageSteps(c: Case, config: Config, workflowId: string): Extract<Step, { type: 'email' | 'notify' }>[] {
  const definitions = [config.workflows.find(workflow => workflow.id === workflowId && workflow.module === c.module), ...c.runs.filter(run => run.workflowId === workflowId).map(run => run.definition)];
  const steps = new Map<string, Extract<Step, { type: 'email' | 'notify' }>>();
  for (const definition of definitions) for (const step of definition?.steps ?? []) if ((step.type === 'email' || step.type === 'notify') && !steps.has(step.id)) steps.set(step.id, step);
  return [...steps.values()];
}
/** Board 4a60b3ec: To and CC for this case and step only, before it runs or while it is held. */
export function overrideRecipients(c: Case, config: Config, input: { workflowId: string; stepId: string } & ({ to: Role[]; cc: Role[] } | { clear: true }), env: Environment): void {
  if (!['pending', 'submitted'].includes(c.state)) throw new V9Error('Reopen this case before changing its recipients.', 'conflict');
  const step = caseMessageSteps(c, config, input.workflowId).find(candidate => candidate.id === input.stepId);
  if (!step) throw new V9Error('Choose an email step of a workflow on this case.', 'not_found');
  const key = input.workflowId + ':' + input.stepId;
  const run = c.runs.filter(candidate => candidate.workflowId === input.workflowId).at(-1);
  if (run && run.status !== 'done' && c.mails.some(mail => mail.workflowId === input.workflowId && mail.key.startsWith(`${run.id}:${input.stepId}:`)))
    throw new V9Error('This step has already queued its email for the current run. Its recipients can no longer change.', 'conflict');
  const email = step.type === 'email' ? config.emails.find(candidate => candidate.id === step.template) : null;
  const before = stepRecipientRoles(c, input.workflowId, step, email), labels = (roles: Role[]) => roles.map(role => recipientLabel(role, config, env)).join(', ') || 'No one';
  if ('clear' in input) {
    if (!c.recipientOverrides?.[key]) return;
    delete c.recipientOverrides[key];
  } else {
    // The same rules as the workflow editor. A removed role may stay only where this step already had it.
    const kept = [...before.to, ...before.cc];
    const problems = [...recipientListProblems(input.to, c.module, kept, 'To recipients'), ...recipientListProblems(input.cc, c.module, kept, 'CC recipients')];
    if (!input.to.length) problems.push('Choose at least one To recipient.');
    if (problems.length) throw new V9Error([...new Set(problems)].join(' '));
    c.recipientOverrides = { ...c.recipientOverrides, [key]: { to: [...input.to], cc: [...input.cc], by: { ...env.actor }, at: env.now } };
  }
  const after = stepRecipientRoles(c, input.workflowId, step, email);
  appendLog(c, env, 'workflow.recipientsChanged', `${config.workflows.find(workflow => workflow.id === input.workflowId)?.name ?? 'Workflow'} · ${stepMessageName(config, step)}: To ${labels(before.to)}, CC ${labels(before.cc)} → To ${labels(after.to)}, CC ${labels(after.cc)}${'clear' in input ? ' (back to the workflow recipients)' : ''}`);
}
/** Durable delivery acknowledgement is the only operation that marks email-linked documents sent. */
export function markDelivered(c: Case, id: string, env: Environment, unchangedDocumentIds?: ReadonlySet<string>): void {
  const mail = c.mails.find(m => m.id === id); if (!mail || mail.status === 'sent') return;
  if (mail.status !== 'sending' && ((c.state !== 'submitted' && !mail.test) || mail.status !== 'pending')) throw new V9Error('Delivery is no longer eligible.', 'conflict');
  mail.status = 'sent'; mail.deliveredAt = env.now; mail.failure = null;
  // A late acknowledgement records the truth without reopening a closed case.
  if (!mail.test && c.state === 'submitted') for (const doc of c.documents.filter(d => mail.documentIds.includes(d.id) && (!unchangedDocumentIds || unchangedDocumentIds.has(d.id)))) {
    if (['draft', 'hrsigned'].includes(doc.status)) { doc.status = 'sent'; doc.sentAt = env.now; }
    linkedTasks(c, doc, 'sent');
  }
  appendLog(c, env, 'email.sent', mail.subject);
}
export function unresolvedWorkflowDeliveries(c: Pick<Case, 'mails'>): Mail[] { return c.mails.filter(mail => !mail.test && mail.workflowId !== null && ['pending','sending','uncertain','failed','cancelled'].includes(mail.status) && !c.mails.some(next => next.retryOf === mail.id)); }
export function unresolvedSourceRuns(c: Pick<Case, 'runs'>): Run[] { return c.runs.filter(run => run.sourceEvent && ['running','waiting','failed'].includes(run.status)); }
export function close(c: Case, figures: FinalFigures, reason: string, env: Environment, automatic = false): void {
  if (c.module !== 'off' || c.state !== 'submitted') throw new V9Error('Only an open offboarding case can be cleared.', 'conflict');
  const state = work(c);
  if ((state.open.length || state.notReturned.length || unresolvedWorkflowDeliveries(c).length || unresolvedSourceRuns(c).length) && (automatic || !reason.trim())) throw new V9Error('Record an exception reason for outstanding work, unreturned items or unresolved workflow delivery.');
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
  const deliveries = unresolvedWorkflowDeliveries(c), events = unresolvedSourceRuns(c);
  if (!events.length && !state.open.length && !state.notReturned.length && !deliveries.length && figures) { close(c, figures, '', env, true); return 'closed'; }
  const detail = [state.open.length ? `${state.open.length} still open: ${state.open.map(t => `${t.name} (due ${t.dueOn})`).join('; ')}` : '', state.notReturned.length ? `${state.notReturned.length} items marked not returned need HR sign-off.` : '', deliveries.length ? `${deliveries.length} workflow email deliveries require confirmation or review.` : '', events.length ? `${events.length} workflows from recorded actions require completion or review.` : '', !figures ? 'Final figures require confirmation in Payroll.' : ''].filter(Boolean).join('\n');
  const first = !c.review;
  c.review = { firstAt: c.review?.firstAt ?? env.now, open: state.open.length, overdue: state.open.filter(t => t.dueOn <= env.today).length, notReturned: state.notReturned.length, detail };
  if (!first) return 'unchanged';
  appendLog(c, env, 'case.reviewRequired', detail);
  const ops = recipients(c, config, 'peopleOps').filter(env.eligibleUser);
  if (ops.length) c.mails.push({ id: env.nextId(), key: 'last-day-review', workflowId: null, templateId: null, to: [ops[0]], cc: ops.slice(1), subject: `${c.facts.name}: last working day reached, case not closed`, body: `${c.facts.name}'s last working day (${c.facts.lastDay}) has been reached.\n\n${detail}\n\nPlease review the case.`, documentIds: [], fileIds: [], delivery: { version: 1, queuedBy: { ...env.actor }, sender: 'noreply', linkDocumentIds: [], pdfDocumentIds: [], toNames: [env.userName(ops[0])], ccNames: ops.slice(1).map(env.userName) }, status: 'pending', test: false, at: env.now, deliveredAt: null, failure: null });
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
