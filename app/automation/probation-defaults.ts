/**
 * The Probation automation the prototype ships (handoff A1; prototype WORKFLOWS0 and EMAILS0), mapped onto the Probation
 * catalogue (lib/automation/catalogues/probation.ts). Installed only on request, always Paused, idempotent by these
 * fixed ids (core/automation-builder.ts installAutomationDefaults). Fictional-free: no people or companies are named.
 *
 * Mapping notes (kept here so a reviewer can check them against the prototype):
 *  - Prototype triggers afterStart, beforeDue, outcome, signRequest, sentBack, rejected, override and declined are the
 *    catalogue's dueAfterStart, dueBeforeReview, outcomeDecided, letterActionNeeded, letterSentBack, returned,
 *    outcomeOverridden and declinedToSign. "Part 1 · Week 1 KPIs" is the catalogue's "Part 1 · Week 1 Success Plan".
 *  - Recipients: supervisor is the Direct Superior; routing r-bp / r-hod are the two routings below (installed with no
 *    rows, so they reach nobody until rows are added and the workflows show that problem until then).
 *  - Prototype merge fields {x} become {{key}}. The prototype's first name, result band and letter fields (document
 *    name, signing step, sent back by/reason) are not in the catalogue yet: they are kept as typed and the editor warns.
 *  - Generate a document steps need a letter template chosen per tenant (letter templates are kept per company), so
 *    they are installed without one and the workflow shows "choose a letter template" until it is chosen.
 */
import type {AutomationCondition} from '@/lib/automation/conditions';
import type {AutomationRecipient,AutomationStep,AutomationWorkflow} from '@/lib/automation/workflow';
import type {Routing} from '@/lib/automation/routing';
import type {AutomationEmailTemplate} from '@/lib/automation/email';

const id = (kind: 1 | 2 | 3, n: number) => `a0700000-0000-4000-8000-${String(kind * 1000 + n).padStart(12, '0')}`;
export const DEFAULT_ROUTING_IDS = { bp: id(1, 1), hod: id(1, 2) } as const;
export const DEFAULT_EMAIL_IDS = { kpiAlert: id(2, 1), formOpen: id(2, 2), signingRequest: id(2, 3), letter: id(2, 4) } as const;

const P1 = 'Part 1 · Week 1 Success Plan', P3 = 'Part 3 · Final Confirmation Review';
const employee: AutomationRecipient = { kind: 'role', role: 'employee' };
const superior: AutomationRecipient = { kind: 'role', role: 'directSuperior' };
const bp: AutomationRecipient = { kind: 'routing', routingId: DEFAULT_ROUTING_IDS.bp };
const hod: AutomationRecipient = { kind: 'routing', routingId: DEFAULT_ROUTING_IDS.hod };
const pending: AutomationRecipient = { kind: 'pending' };
const is = (field: string, ...values: string[]): AutomationCondition => ({ field, op: 'is', values });
const isNot = (field: string, ...values: string[]): AutomationCondition => ({ field, op: 'isNot', values });

let stepNumber = 0;
const step = (type: string, params: Record<string, unknown>, to: AutomationRecipient[] = [], cc: AutomationRecipient[] = [], conditions: AutomationCondition[] = []): AutomationStep =>
  ({ id: `s${++stepNumber}`, type, conditions, to, cc, params });
const notify = (to: AutomationRecipient[], cc: AutomationRecipient[], subject: string, body: string, conditions: AutomationCondition[] = []) => step('notify', { subject, body }, to, cc, conditions);
const email = (templateId: string, to: AutomationRecipient[], cc: AutomationRecipient[] = []) => step('sendEmail', { emailTemplateId: templateId }, to, cc);
const letter = () => step('generateDocument', { letterTemplateId: '' });

const reviewSteps = () => [
  notify([employee], [], 'Reminder: your {{probation.part}} is due {{probation.dueDate}}', 'Hi {{employee.firstName}}, your {{probation.part}} needs your action: complete your self-assessment, or review and acknowledge your Line Manager’s assessment. You’ll find it in Today › Needs you. Due {{probation.dueDate}}.', [is('pendingStep', 'Employee'), is('extensionsUsed', '0')]),
  notify([employee], [], 'Reminder: your review after your probation extension is due {{probation.dueDate}}', 'Hi {{employee.firstName}}, this is your final review after your probation extension. Please complete your self-assessment, or review and acknowledge your Line Manager’s assessment, in Today › Needs you by {{probation.dueDate}}.', [is('pendingStep', 'Employee'), isNot('extensionsUsed', '0')]),
  notify([superior], [], 'Reminder: {{probation.part}} for {{employee.name}} due {{probation.dueDate}}', 'Please complete your assessment of {{employee.name}} for {{probation.part}} and sign it in Today › Needs you by {{probation.dueDate}}.', [is('pendingStep', 'Line Manager')]),
  notify([hod], [], 'Approval needed: {{probation.part}} for {{employee.name}}', 'Please review, approve and sign {{probation.part}} for {{employee.name}} in My Action Centre › Approval Items by {{probation.dueDate}}.', [is('pendingStep', 'HOD')]),
  notify([bp], [], 'Action needed: {{probation.part}} for {{employee.name}}', 'Please review {{probation.part}} for {{employee.name}} in My Action Centre › Approval Items by {{probation.dueDate}}. For Part 3, approve and sign it.', [is('pendingStep', 'PBP')]),
];

let workflowNumber = 0;
const workflow = (name: string, event: string, required: boolean, steps: AutomationStep[], conditions: AutomationCondition[] = [], timing: { days?: number; workdays?: boolean; repeat?: boolean } = {}): AutomationWorkflow => {
  stepNumber = 0;
  return { id: id(3, ++workflowNumber), module: 'probation', name, description: '', status: 'paused', required, trigger: { event, days: timing.days ?? 0, workdays: timing.workdays ?? false, repeat: timing.repeat ?? false }, skipWhen: 'never', conditions, steps: steps.map((s, i) => ({ ...s, id: `s${i + 1}` })) };
};

export const PROBATION_DEFAULT_ROUTINGS: readonly Routing[] = [
  { id: DEFAULT_ROUTING_IDS.bp, name: 'BP by business group', rows: [] },
  { id: DEFAULT_ROUTING_IDS.hod, name: 'HOD by business group and department', rows: [] },
];

const SIGN_OFF = '\n\nIf you have any questions, reply to this email or contact the Human Resource Department.\n\nRegards,\nHuman Resource Department\n{{org.company}}';
export const PROBATION_DEFAULT_EMAILS: readonly AutomationEmailTemplate[] = [
  { id: DEFAULT_EMAIL_IDS.kpiAlert, module: 'probation', name: 'Week 1 KPI alert', active: true, cc: [], subject: 'Welcome {{employee.name}}: agree your Week 1 KPIs',
    body: 'Dear {{employee.name}},\n\nWelcome to {{org.company}}! Your probation as {{employee.jobTitle}} in {{org.department}} has started. Please agree your Week 1 KPIs with your supervisor, {{people.lineManager}}, by {{probation.dueDate}}.\n\nOpen your Week 1 KPIs: {{case.link}}' + SIGN_OFF },
  { id: DEFAULT_EMAIL_IDS.formOpen, module: 'probation', name: 'Review form is open', active: true, cc: [], subject: '{{probation.part}} for {{employee.name}} is open, due {{probation.dueDate}}',
    body: 'Hello,\n\n{{probation.part}} for {{employee.name}} ({{employee.jobTitle}}, {{org.department}}) is now open. Please complete your step by {{probation.dueDate}}.\n\nSelf-assessment · Employee · {{probation.dueDate}}\nAssessment and signature · Line Manager · {{probation.dueDate}}\n\nOpen the review form: {{case.link}}' + SIGN_OFF },
  { id: DEFAULT_EMAIL_IDS.signingRequest, module: 'probation', name: 'Signing request', active: true, cc: [], subject: '{{probation.part}} for {{employee.name}} needs your signature',
    body: 'Hello,\n\n{{probation.part}} for {{employee.name}} is ready for your signature.\n\nReview and sign: {{case.link}}' + SIGN_OFF },
  { id: DEFAULT_EMAIL_IDS.letter, module: 'probation', name: 'Your probation letter', active: true, cc: [], subject: 'Your probation letter: {{probation.outcome}}',
    body: 'Dear {{employee.name}},\n\nYour probation outcome is {{probation.outcome}}. Your letter is attached to this email as a PDF, and a copy is saved on your employee file.\n\nIf anything in the letter looks wrong, reply to this email.' + SIGN_OFF },
];

export const PROBATION_DEFAULT_WORKFLOWS: readonly AutomationWorkflow[] = [
  workflow('Week 1 KPI alert', 'dueAfterStart', true, [email(DEFAULT_EMAIL_IDS.kpiAlert, [employee, superior], [bp])], [], { days: 1, workdays: true }),
  workflow('Week 1 KPI reminder · Line Manager', 'dueAfterStart', true, [notify([superior], [], 'Week 1 KPIs due {{probation.dueDate}}', 'The Week 1 KPIs for {{employee.name}} are still pending. Please agree them with {{employee.firstName}} by {{probation.dueDate}}.')], [is('part', P1), is('pendingStep', 'Line Manager')], { days: 3, workdays: true }),
  workflow('Week 1 KPI acknowledgement reminder · Employee', 'dueAfterStart', false, [notify([employee], [], 'Please acknowledge your Week 1 KPIs by {{probation.dueDate}}', 'Hi {{employee.firstName}}, {{people.lineManager}} has shared your Week 1 KPIs. Please review them, add any comments and acknowledge them in Today › Needs you by {{probation.dueDate}}. Acknowledging means you have discussed and received them. If something needs to change, use Request changes.')], [is('part', P1), is('pendingStep', 'Employee')], { days: 4, workdays: true, repeat: true }),
  workflow('Review form issued', 'formIssued', true, [email(DEFAULT_EMAIL_IDS.formOpen, [employee, superior], [bp])]),
  workflow('Review reminder · first (14 days before)', 'dueBeforeReview', true, reviewSteps(), [isNot('part', P1), isNot('pendingStep', 'Nobody (all steps done)')], { days: 14 }),
  workflow('Review reminder · daily (from 7 days before)', 'dueBeforeReview', true, reviewSteps(), [isNot('part', P1), isNot('pendingStep', 'Nobody (all steps done)')], { days: 7, repeat: true }),
  workflow('Part 3 approval', 'acknowledged', true, [notify([hod], [bp], '{{probation.part}} for {{employee.name}} needs your approval', '{{probation.part}} for {{employee.name}} is in your Approval Items. The Head of Department approves first, then the People Business Partner.')], [is('part', P3)]),
  workflow('Outcome · Confirm', 'outcomeDecided', true, [letter(), email(DEFAULT_EMAIL_IDS.letter, [employee], [superior, bp]), step('createPosting', { eventType: 'Confirmation' })], [is('outcome', 'Confirm')]),
  workflow('Outcome · Extend', 'outcomeDecided', true, [letter(), email(DEFAULT_EMAIL_IDS.letter, [employee], [superior, bp]), step('createPosting', { eventType: 'Probation Extension' })], [is('outcome', 'Extend')]),
  workflow('Outcome · Not confirm', 'outcomeDecided', true, [letter(), email(DEFAULT_EMAIL_IDS.letter, [employee], [superior, bp]), step('startOffboarding', { exitReason: 'Non-confirmation' })], [is('outcome', 'Non-confirmation')]),
  workflow('Letter · review or signature requested', 'letterActionNeeded', true, [notify([pending], [], '{{letter.signingStep}} needed: {{letter.documentName}} for {{employee.name}}', '{{letter.documentName}} for {{employee.name}} is waiting for you to {{letter.signingStep}} it. Open the case in Probation to continue.')]),
  workflow('Letter · sent back for changes', 'letterSentBack', true, [notify([pending], [], '{{letter.documentName}} for {{employee.name}} was sent back', '{{letter.sentBackBy}} sent {{letter.documentName}} back for changes: {{letter.sentBackReason}}. Update the letter and send it round again. Anyone who had signed will sign again.')]),
  workflow('Returned with comments', 'returned', true, [notify([superior], [bp], '{{probation.part}} for {{employee.name}} was returned', 'The approver returned {{probation.part}} with comments. Please update it and resubmit.')]),
  workflow('Low-result alert', 'lowResult', false, [notify([bp], [], 'Low result: {{employee.name}} · Band {{probation.resultBand}}', 'The Line Manager’s assessment of {{employee.name}} scored Band {{probation.resultBand}} on {{probation.part}}. Please follow up with the Line Manager.')]),
  workflow('Suggested outcome overridden', 'outcomeOverridden', false, [notify([bp], [], 'Override flagged: {{employee.name}}', 'The Line Manager chose an outcome that differs from the suggestion for {{employee.name}} ({{probation.part}}).')]),
  workflow('Employee declined to sign', 'declinedToSign', false, [notify([bp], [], '{{employee.name}} declined to sign {{probation.part}}', 'Please confirm the declined signature in Today › Needs you.')]),
];

export const PROBATION_DEFAULTS = { workflows: PROBATION_DEFAULT_WORKFLOWS, emailTemplates: PROBATION_DEFAULT_EMAILS, routings: PROBATION_DEFAULT_ROUTINGS } as const;
