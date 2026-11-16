/**
 * Probation on the shared workflow runner (ADR 2026-11-15-probation-shared-automation, decision 4 and build step 4;
 * handoff A1, B4; migrations 5748, 5753).
 *
 * The module raises catalogue events (lib/automation/catalogues/probation.ts) in the transaction of the command that
 * caused them; lib/automation/runtime.ts decides, freezes and runs the live workflows; this file supplies the case
 * facts, recipients and the step effects:
 *  - Generate a document: the step names a letter template KEY (letter templates are per company, workflows tenant
 *    wide). It resolves to this case's company's latest published version of that key; a key the company has not
 *    published (or retired) fails the run with the guardrail, and the PBP is asked to check and release by hand.
 *    The run then waits for that letter's release (resumeProbationOutcomeTx).
 *  - Create posting: a Personnel posting (core/personnel-posting.ts) approved by the case's pinned "who approves
 *    Personnel postings" group (default GBS People Ops). Only approval writes the movement.
 *  - Start offboarding: one company-initiated exit case per probation case (the existing idempotent hand-off).
 *  - Notify / Send email: an in-app notice through the existing Probation notification transport AND a real email,
 *    recorded as a durable intent in the same transaction (core/automation-email-delivery.ts, migration 5754) and sent
 *    later by the existing out-of-band delivery worker. To and CC stay apart in the email; a routing or group reaches
 *    everyone matched; a recipient nobody resolves for is recorded and the fallback group receives the message (To).
 *    Send email renders the shared email template (subject and body); a template turned off is skipped and noted.
 *  - A failed run asks the PBP to check and release by hand (the outcome's failure, shown on the case).
 * Organisation conditions and routings use ids (labels shown in the builder). Condition values saved earlier as names
 * still match through the runner's aliases (one-off read-time compatibility).
 */
import type {EmailBodyDoc} from '../lib/email-body/doc';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {randomUUID} from 'node:crypto';
import {runAutomationEventTx,resumeAutomationRunsTx,liveAutomationWorkflowsTx,sqlAutomationRunStore} from './automation-runtime';
import {pgSqlState} from '../lib/db-error';
import {newAutomationRun,resolveAutomationRecipients,type AutomationExecutors,type AutomationRun,type AutomationRuntimeGuards,type AutomationStepContext,type AutomationStepOutcome} from '../lib/automation/runtime';
import {conditionFieldsForTrigger} from '../lib/automation/catalogue';
import {PROBATION_AUTOMATION_CATALOGUE,PROBATION_PART_LABELS} from '../lib/automation/catalogues/probation';
import {fillAutomationMergeFields,automationEmailBodyDoc} from '../lib/automation/email';
import {prepareProbationEmailAssetSource} from './automation-email-asset-proof';
import type {AutomationFactValue} from '../lib/automation/conditions';
import type {AutomationRecipient,AutomationStep} from '../lib/automation/workflow';
import type {Routing} from '../lib/automation/routing';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

/** The notify-only engine's fill: a known merge field always replaces its token, an empty value with nothing. */
function fillLegacyMergeFields(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (token, key: string) => key in values ? values[key] ?? '' : token);
}
/** For a step moved from the notify-only engine, its six words come from where that engine's notices took them. */
function legacyMergeValues(merge: Record<string, string>, audience: {words: Record<string, string | null>}): Record<string, string> {
  const w = audience.words;
  return {...merge, 'employee.name': w.employeeName ?? '', 'employee.id': w.employeeCode ?? '', 'org.company': w.companyName ?? '', 'probation.endDate': w.endOn ?? '', 'probation.partNumber': w.part ?? '', 'probation.partDueOn': w.dueOn ?? ''};
}

type Holders = {employee?: string | null; lm?: string | null; hod?: string | null; pbp?: string | null};
export type ProbationAutomationContext = {
  holders: Holders;
  org: {businessGroupId: string | null; businessGroupName: string | null; businessGroupCompanyId: string | null; companyId: string; companyName: string | null; departmentId: string | null; departmentName: string | null; jobTitle: string | null};
  people: Partial<Record<'employee' | 'lm' | 'hod' | 'pbp', string>>;
  employeeCode: string | null;
  fallbackGroupId: string | null; postingApproverGroupId: string | null;
  routings: Routing[]; groups: {id: string; members: string[]}[];
  emailTemplates: {id: string; name: string; active: boolean; retired: boolean; subject: string; body: string;bodyDoc?:EmailBodyDoc|null; cc: AutomationRecipient[];revision?:number;assetCount?:number}[];
};
/** The case as the adapter needs it (a subset of ProbationCaseView.record). */
export type ProbationAutomationCase = {
  id: string; companyId: string; startOn: string; originalEndOn?: string; endOn: string; planMonths?: number; gradeAtStart: string; extensionCount: number; state: string;
  facts?: {employeeName?: string | null};
};
/** What the event knows about the part, outcome, score and letter. Undefined fields are not supplied by the trigger. */
export type ProbationEventFacts = {
  partId?: string | null; partType?: 1 | 2 | 3 | null; dueOn?: string | null;
  outcome?: {id: string; revision: number; outcome: string; extensionMonths?: number | null} | null;
  resultBand?: number | null; overridden?: boolean | null; pendingStep?: string | null;
  /** Overdue summary: how many cases of this PBP have an overdue review part. */
  overdueCount?: number | null;
  letter?: {name?: string | null; signingStep?: string | null; sentBackBy?: string | null; sentBackReason?: string | null} | null;
};
type Effects = {postingId: string | null; handoffId: string | null; documentId: string | null};
/**
 * G2 (migration 5757): who the notify-only engine would reach on this case and part, and the words its notices carry
 * (app.probation_legacy_audience): the case's holders by role, the pending parties by role and the notice words.
 */
export type ProbationLegacyAudience = {holders: Record<string, string[]>; pending: Record<string, string[]>; words: Record<string, string | null>};
const NO_AUDIENCE: ProbationLegacyAudience = {holders: {}, pending: {}, words: {}};
/** The catalogue's legacy-exact roles: the case's holders and "whoever's step is pending" narrowed to one role. */
const LEGACY_ROLES: Record<string, ['holders' | 'pending', string]> = {
  caseHod: ['holders', 'hod'], casePbp: ['holders', 'pbp'], caseGbs: ['holders', 'gbs'],
  pendingEmployee: ['pending', 'employee'], pendingLm: ['pending', 'lm'], pendingHod: ['pending', 'hod'], pendingPbp: ['pending', 'pbp'], pendingGbs: ['pending', 'gbs'],
};
export async function probationLegacyAudienceTx(tx: Tx, caseId: string, partId: string | null): Promise<ProbationLegacyAudience> {
  const [row] = await tx.execute<{data: ProbationLegacyAudience}>(sql`select app.probation_legacy_audience(${caseId}::uuid, ${partId}::uuid) as data`);
  return row?.data ?? NO_AUDIENCE;
}

const OUTCOME_LABEL: Record<string, string> = {confirm: 'Confirm', extend: 'Extend', not_confirm: 'Non-confirmation', other: 'Other'};
const text = (value: unknown) => typeof value === 'string' ? value : '';

export async function probationAutomationContextTx(tx: Tx, caseId: string): Promise<ProbationAutomationContext> {
  const [row] = await tx.execute<{data: ProbationAutomationContext}>(sql`select app.probation_automation_context(${caseId}::uuid) as data`);
  return row.data;
}

/** Extension the outcome adds: months, new end date and the extension's number. */
function extensionFacts(record: ProbationAutomationCase, outcome: ProbationEventFacts['outcome']) {
  if (outcome?.outcome !== 'extend' || (outcome.extensionMonths !== 3 && outcome.extensionMonths !== 6)) return null;
  const start = addDaysIso(record.endOn, 1);
  return {months: outcome.extensionMonths, start, endOn: addDaysIso(addCalendarMonths(start, outcome.extensionMonths), -1), number: record.extensionCount + 1};
}

/** Condition facts. Organisation fields answer with ids; their names are aliases (conditions saved before W5). */
export function probationFactReader(trigger: string, record: ProbationAutomationCase, context: ProbationAutomationContext, facts: ProbationEventFacts) {
  const supplied = new Set(conditionFieldsForTrigger(PROBATION_AUTOMATION_CATALOGUE, trigger).map(f => f.id));
  const values: Record<string, AutomationFactValue> = {
    part: facts.partType ? PROBATION_PART_LABELS[facts.partType - 1] : null,
    outcome: facts.outcome ? OUTCOME_LABEL[facts.outcome.outcome] ?? null : null,
    reviewPlan: record.planMonths ? `${record.planMonths} months` : null,
    businessGroup: context.org.businessGroupId, company: context.org.companyId, department: context.org.departmentId,
    jobGrade: record.gradeAtStart ?? null, extensionsUsed: String(record.extensionCount ?? 0),
    resultBand: facts.resultBand ? String(facts.resultBand) : null,
    suggestionOverridden: facts.overridden === undefined || facts.overridden === null ? null : facts.overridden ? 'Yes' : 'No',
    pendingStep: facts.pendingStep ?? null,
  };
  const names: Record<string, (string | null)[]> = {
    businessGroup: [context.org.businessGroupName, context.org.businessGroupCompanyId],
    company: [context.org.companyName], department: [context.org.departmentName],
  };
  return {
    read: (field: string): AutomationFactValue => supplied.has(field) && field in values ? values[field] : undefined,
    aliases: (field: string): readonly string[] => (names[field] ?? []).filter((v): v is string => !!v),
  };
}

/** Merge values for Send email (catalogue merge fields). */
export function probationMergeValues(record: ProbationAutomationCase, context: ProbationAutomationContext, facts: ProbationEventFacts, audience: ProbationLegacyAudience = NO_AUDIENCE): Record<string, string> {
  const name = context.people.employee ?? record.facts?.employeeName ?? '';
  const extension = extensionFacts(record, facts.outcome);
  return {
    'employee.name': name, 'employee.id': context.employeeCode ?? '', 'employee.firstName': name.split(/\s+/)[0] ?? '',
    'employee.jobTitle': context.org.jobTitle ?? '', 'employee.grade': record.gradeAtStart ?? '',
    'org.businessGroup': context.org.businessGroupName ?? '', 'org.company': context.org.companyName ?? '', 'org.department': context.org.departmentName ?? '',
    'people.lineManager': context.people.lm ?? '', 'people.hod': context.people.hod ?? '', 'people.pbp': context.people.pbp ?? '',
    'probation.startDate': record.startOn, 'probation.originalEndDate': record.originalEndOn ?? record.endOn, 'probation.endDate': record.endOn,
    'probation.reviewPlan': record.planMonths ? `${record.planMonths} months` : '',
    'probation.part': facts.partType ? PROBATION_PART_LABELS[facts.partType - 1] : '', 'probation.dueDate': facts.dueOn ?? '',
    'probation.outcome': facts.outcome ? OUTCOME_LABEL[facts.outcome.outcome] ?? '' : '',
    'probation.confirmationDate': facts.outcome?.outcome === 'confirm' ? record.endOn : '',
    'probation.extensionLength': extension ? `${extension.months} months` : '', 'probation.newEndDate': extension?.endOn ?? '',
    'probation.extensionNumber': extension ? String(extension.number) : '',
    'probation.resultBand': facts.resultBand ? String(facts.resultBand) : '',
    // G2: the notify-only engine's {{part}} and {{dueOn}} exactly as its notices carried them.
    'probation.partNumber': audience.words.part ?? '', 'probation.partDueOn': audience.words.dueOn ?? '',
    'probation.overdueCount': facts.overdueCount === undefined || facts.overdueCount === null ? '' : String(facts.overdueCount),
    'letter.documentName': facts.letter?.name ?? '', 'letter.signingStep': facts.letter?.signingStep ?? '',
    'letter.sentBackBy': facts.letter?.sentBackBy ?? '', 'letter.sentBackReason': facts.letter?.sentBackReason ?? '',
    'case.link': `/lifecycle/probation/${record.id}`, today: todayInKualaLumpur(),
  };
}

/** I6: named people in these recipient lists who are active users of this tenant (bounded; the runner's authority). */
export async function probationActivePeopleTx(tx: Tx, caseId: string, lists: readonly (readonly AutomationRecipient[])[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(lists.flat().flatMap(r => r.kind === 'person' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.userId) ? [r.userId] : []))].slice(0, 500);
  if (!ids.length) return new Set();
  const rows = await tx.execute<{id: string}>(sql`select u.id from app.probation_automation_active_users(${caseId}::uuid, ${`{${ids.join(',')}}`}::uuid[]) as u(id)`);
  return new Set(rows.map(r => r.id));
}
function recipientsFor(list: readonly AutomationRecipient[], context: ProbationAutomationContext, facts: ProbationEventFacts, pending: string[] | null, withFallback = true, audience: ProbationLegacyAudience = NO_AUDIENCE, active: ReadonlySet<string> = new Set()) {
  const groups = new Map(context.groups.map(g => [g.id, g.members])), routings = new Map(context.routings.map(r => [r.id, r]));
  const fallback = withFallback && context.fallbackGroupId ? {groupId: context.fallbackGroupId, members: groups.get(context.fallbackGroupId) ?? []} : null;
  return resolveAutomationRecipients(list, {
    role: role => role === 'employee' ? (context.holders.employee ? [context.holders.employee] : []) : role === 'directSuperior' ? (context.holders.lm ? [context.holders.lm] : [])
      : LEGACY_ROLES[role] ? [...(audience[LEGACY_ROLES[role][0]][LEGACY_ROLES[role][1]] ?? [])] : null,
    // W5: a business group is the business unit (Personnel v2 mapping, the PBP rule) or its group company (builder options).
    facts: {businessGroup: [context.org.businessGroupId, context.org.businessGroupCompanyId].filter((v): v is string => !!v), company: context.org.companyId, department: context.org.departmentId, jobTitle: context.org.jobTitle},
    routing: id => routings.get(id) ?? null, groupMembers: id => groups.get(id) ?? null,
    // I6: a named person counts only while they are an active user of this tenant; otherwise the fallback group receives it.
    person: userId => active.has(userId),
    pending: () => pending?.length ? {userIds: pending, label: facts.pendingStep ?? 'Pending step'} : null,
    fallback,
    describe: r => r.kind === 'role' ? (r.role === 'employee' ? 'The employee' : r.role === 'directSuperior' ? 'Their Direct Superior' : PROBATION_AUTOMATION_CATALOGUE.recipients.find(x => x.id === r.role)?.label ?? r.role) : r.kind === 'routing' ? `The routing “${routings.get(r.routingId)?.name ?? 'removed routing'}”` : r.kind === 'group' ? `The assignment group ${r.groupId}` : r.kind === 'person' ? 'A named person' : 'Whoever’s step is pending',
  });
}
/**
 * The email's own To and CC (F1): To = the To recipients plus, when any recipient resolved to nobody, the fallback group;
 * CC = the CC recipients who are not already in To.
 */
export function probationEmailAddressees(to: readonly AutomationRecipient[], cc: readonly AutomationRecipient[], context: ProbationAutomationContext, facts: ProbationEventFacts, pending: string[] | null, audience: ProbationLegacyAudience = NO_AUDIENCE, fallback = true, active: ReadonlySet<string> = new Set()) {
  // A step moved from the notify-only engine (`legacy: true`, G2) drops a recipient nobody resolves for, exactly as that
  // engine did: no fallback group, nothing recorded as unresolved.
  const resolved = recipientsFor([...to, ...cc], context, facts, pending, fallback, audience, active);
  const all = fallback ? resolved : {...resolved, unresolved: []};
  const toIds = recipientsFor(to, context, facts, pending, false, audience, active).userIds, ccIds = recipientsFor(cc, context, facts, pending, false, audience, active).userIds;
  const fallbackMembers = all.fallbackUsed && context.fallbackGroupId ? context.groups.find(g => g.id === context.fallbackGroupId)?.members ?? [] : [];
  const toAll = [...new Set([...toIds, ...fallbackMembers])];
  return {all, to: toAll, cc: ccIds.filter(id => !toAll.includes(id))};
}

/** Latest published-or-retired version of each letter template key for the company (bounded). */
async function letterVersionsTx(tx: Tx, companyId: string): Promise<Map<string, {id: string; state: string}>> {
  const rows = await tx.execute<{key: string; id: string; state: string}>(sql`
    select distinct on (definition_key) definition_key as key, id, state from probation_builder_definition
    where tenant_id = app.current_tenant_id() and company_id = ${companyId}::uuid and kind = 'template' and state in ('published','retired')
    order by definition_key, version desc limit 500`);
  return new Map(rows.map(r => [r.key, {id: r.id, state: r.state}]));
}

type ExecutorInput = {
  ctx: SessionContext; trigger: string; record: ProbationAutomationCase; context: ProbationAutomationContext; facts: ProbationEventFacts;
  letters: Map<string, {id: string; state: string}>; pending: string[] | null; effects: Effects; audience: ProbationLegacyAudience;
  /** True only when resuming after the outcome's letter was signed, released and filed (resumeProbationOutcomeTx). */
  released?: boolean;
};
const NOT_RELEASED = 'This step needs the signed, released letter, and the workflow has no Generate document step before it, so nothing was posted or started.';
function probationRuntime(tx: Tx, input: ExecutorInput): {executors: AutomationExecutors; guards: AutomationRuntimeGuards} {
  const {ctx, record, context, facts, effects} = input;
  const templates = new Map(context.emailTemplates.map(t => [t.id, t]));
  const merge = probationMergeValues(record, context, facts, input.audience);
  // The email keeps {{case.link}} as a token: the private sender makes it an absolute link for its installation.
  const emailMerge = {...merge, 'case.link': ''};
  /** In-app notice (5753) and the durable email intent (5754), in this transaction. */
  const deliver = async (run: AutomationRun, step: AutomationStep, to: readonly AutomationRecipient[], cc: readonly AutomationRecipient[], subject: string, body: string,bodyDoc?:EmailBodyDoc|null,template?:ProbationAutomationContext['emailTemplates'][number]) => {
    const active = await probationActivePeopleTx(tx, record.id, [to, cc]);
    const addressees = probationEmailAddressees(to, cc, context, facts, input.pending, input.audience, step.params.legacy !== true, active), resolved = addressees.all;
    if (!resolved.userIds.length) return {resolved, email: null};
    const key = run.id + ':' + step.id;
    await tx.execute(sql`select app.probation_automation_notify(${record.id}::uuid, ${facts.partId ?? null}::uuid, ${key}, ${input.trigger}, ${`{${resolved.userIds.join(',')}}`}::uuid[])`);
    const {queueAutomationEmailTx} = await import('./automation-email-delivery');
    const subjectLine=fillAutomationMergeFields(subject, merge).replace(/\s+/g, ' ').trim() || 'Probation update',message=fillAutomationMergeFields(body, emailMerge).replace(/\{\{\s*case\.link\s*\}\}/g, '{{case.link}}');
    let richBody:import('../lib/automation-email-content').AutomationRichEmailBody|undefined=bodyDoc?{doc:bodyDoc,values:emailMerge}:undefined;
    if(template?.assetCount){
      const hold='Set up shared email attachment verification before continuing this template. No email was sent without its files.';
      if(!template.revision)return {resolved,email:null,assetHold:hold};
      const source={...(richBody??{doc:automationEmailBodyDoc({body,module:'probation'}),values:emailMerge}),sourceTemplate:{id:template.id,revision:template.revision}};
      const admitted=await prepareProbationEmailAssetSource(tx,ctx,{subjectId:record.id,key,to:addressees.to,cc:addressees.cc,subject:subjectLine,body:message,richBody:source});
      if(!admitted)return {resolved,email:null,assetHold:hold};
      richBody=admitted;
    }
    const email = await queueAutomationEmailTx(tx, {module: 'probation', subjectId: record.id, key, to: addressees.to, cc: addressees.cc,
      subject:subjectLine,body:message,...(richBody?{richBody}:{})});
    return {resolved, email};
  };
  const unresolvedOf = (resolved: ReturnType<typeof recipientsFor>, email: {unreachable: string[]} | null) => [
    ...resolved.unresolved.map(u => ({meantFor: u.meantFor, reason: u.reason})),
    ...(email?.unreachable.length ? [{meantFor: `${email.unreachable.length} ${email.unreachable.length === 1 ? 'person' : 'people'} by email`, reason: 'No sign-in email is recorded, so they get the in-app notice only.'}] : []),
  ];
  const sent = (email: {queued: number; to: string[]; cc: string[]} | null) => email?.queued ? ` Email queued for ${email.to.length + email.cc.length} ${email.to.length + email.cc.length === 1 ? 'person' : 'people'}.` : email ? ' No email was queued: nobody has a sign-in email, or it was queued before.' : '';
  const executors: AutomationExecutors = {
    notify: async ({run, step}: AutomationStepContext): Promise<AutomationStepOutcome> => {
      // G2: a step moved from the notify-only engine fills empty merge values with nothing, as that engine did.
      const legacy = step.params.legacy === true;
      const words = legacy ? legacyMergeValues(merge, input.audience) : merge;
      const subject = legacy ? fillLegacyMergeFields(text(step.params.subject), words) : text(step.params.subject);
      const {resolved, email} = await deliver(run, step, step.to, step.cc, subject, legacy ? fillLegacyMergeFields(text(step.params.body), words) : text(step.params.body));
      // G2: a step moved from the notify-only engine sends nothing when nobody it names is involved, as before.
      if (!resolved.userIds.length && step.params.legacy === true) return {status: 'skipped', reason: 'nobody this step names is involved at this point.'};
      if (!resolved.userIds.length) return {status: 'failed', reason: 'Nobody could be notified, and the fallback group has no members.'};
      return {status: 'done', message: `Notified: ${fillAutomationMergeFields(subject, merge)}.${sent(email)}`, recipients: resolved.userIds, unresolved: unresolvedOf(resolved, email)};
    },
    sendEmail: async ({run, step}) => {
      const template = templates.get(text(step.params.emailTemplateId));
      if (!template) return {status: 'skipped', reason: 'the email template no longer exists.'};
      const {resolved, email,assetHold} = await deliver(run, step, step.to, [...step.cc, ...template.cc], template.subject, template.body,template.bodyDoc,template);
      if(assetHold)return {status:'failed',reason:assetHold};
      if (!resolved.userIds.length) return {status: 'failed', reason: 'Nobody could receive the email, and the fallback group has no members.'};
      return {status: 'done', message: `Sent “${fillAutomationMergeFields(template.subject, merge)}” in AI-HR.${sent(email)}`, recipients: resolved.userIds, unresolved: unresolvedOf(resolved, email)};
    },
    generateDocument: async ({step}) => {
      const outcome = facts.outcome;
      if (!outcome) return {status: 'failed', reason: 'A letter can only be generated for a decided outcome.'};
      const version = input.letters.get(text(step.params.letterTemplateId));
      if (!version || version.state !== 'published') return {status: 'failed', reason: 'This company has no published version of the chosen letter template.'};
      try {
        const {prepareProbationLetterTx} = await import('./probation-letter');
        const prepared = await tx.transaction(scope => prepareProbationLetterTx(scope, ctx, {outcomeId: outcome.id, templateId: version.id, revision: outcome.revision, edits: {}}));
        effects.documentId = prepared.documentId;
        return {status: 'wait', documentId: prepared.documentId, message: 'The letter is prepared and waits for its signatures and release.'};
      } catch (error) {
        return {status: 'failed', reason: `The letter could not be prepared: ${error instanceof Error && error.name === 'ProbationError' ? error.message : 'the letter source or template needs review.'}`};
      }
    },
    createPosting: async ({step}) => {
      // I7 (handoff B4 guardrail): a posting only follows a released letter. A workflow without a Generate document step
      // before it stops here; the PBP is asked to check the case and release by hand, and nothing is posted.
      if (!input.released) return {status: 'failed', reason: NOT_RELEASED};
      const outcome = facts.outcome, kind = text(step.params.eventType);
      const eventType = kind === 'Confirmation' ? 'confirmation' as const : kind === 'Probation Extension' ? 'probationExtension' as const : null;
      if (!outcome || !eventType || (eventType === 'confirmation') !== (outcome.outcome === 'confirm') || eventType === 'probationExtension' && outcome.outcome !== 'extend')
        return {status: 'failed', reason: 'The posting does not match the decided outcome.'};
      if (!context.postingApproverGroupId) return {status: 'failed', reason: 'No group is set to approve Personnel postings.'};
      if (eventType === 'probationExtension' && !extensionFacts(record, outcome)) return {status: 'failed', reason: 'The approved extension length is missing.'};
      const posting = await createProbationOutcomePostingTx(tx, record, outcome, context.postingApproverGroupId);
      effects.postingId = posting.id;
      return {status: 'done', message: `Personnel posting PP-${posting.number} created; it waits for approval.`};
    },
    startOffboarding: async () => {
      if (!input.released) return {status: 'failed', reason: NOT_RELEASED};
      if (facts.outcome?.outcome !== 'not_confirm') return {status: 'failed', reason: 'Only a Non-confirmation outcome starts offboarding.'};
      const {createProbationOffboardingTx} = await import('../packs/lifecycle/service');
      effects.handoffId = await createProbationOffboardingTx(tx, ctx, record.id);
      return {status: 'done', message: 'The offboarding case is started.'};
    },
    notifyFailure: async (_run, reason) => {
      if (!facts.outcome) return;
      await tx.execute(sql`select app.probation_outcome_failure(${facts.outcome.id}::uuid, ${`A workflow step could not finish: ${reason} Check the case and release by hand.`.slice(0, 1000)})`);
    },
  };
  const guards: AutomationRuntimeGuards = {
    emailTemplate: step => { const t = templates.get(text(step.params.emailTemplateId)); return !t || t.retired ? 'missing' : t.active ? 'active' : 'off'; },
    documentTemplate: step => { const v = input.letters.get(text(step.params.letterTemplateId)); return !v ? 'missing' : v.state === 'retired' ? 'retired' : 'available'; },
  };
  return {executors, guards};
}
/**
 * The Personnel posting of a released Confirm or Extend outcome (decision 4), for the shared workflow's Create posting
 * step and for the default path when no workflow matched (I1) alike: the same proposed values, approver group and
 * idempotency key (the outcome id), so the outcome never writes the movement itself; only the posting's approval does.
 */
export async function createProbationOutcomePostingTx(tx: Tx, record: ProbationAutomationCase, outcome: {id: string; outcome: string; extensionMonths?: number | null}, approverGroupId: string): Promise<{id: string; number: number}> {
  const eventType = outcome.outcome === 'confirm' ? 'confirmation' as const : outcome.outcome === 'extend' ? 'probationExtension' as const : null;
  const extension = extensionFacts(record, {revision: 0, ...outcome});
  if (!eventType || eventType === 'probationExtension' && !extension) throw new Error('A Personnel posting needs a Confirm outcome or an approved extension length.');
  const {createPersonnelPostingTx} = await import('./personnel-posting');
  return createPersonnelPostingTx(tx, {source: 'probation', sourceRef: record.id, employmentId: await employmentOf(tx, record.id), eventType,
    proposed: eventType === 'confirmation' ? {effectiveDate: record.endOn, remarks: 'Probation outcome: Confirm'} : {effectiveDate: extension!.start, endDate: extension!.endOn, remarks: 'Probation outcome: Extend'},
    approverGroupId, idempotencyKey: outcome.id});
}
async function employmentOf(tx: Tx, caseId: string): Promise<string> {
  const [row] = await tx.execute<{id: string}>(sql`select employment_id as id from probation_case where id = ${caseId}::uuid and tenant_id = app.current_tenant_id()`);
  return row.id;
}

/**
 * Raises one Probation catalogue event on one case in the caller's transaction. `matched` is false when no live workflow
 * matched (the caller then routes the case to a person). Skip when: caseClosed and noPbp.
 */
export async function emitProbationEventTx(tx: Tx, ctx: SessionContext, input: {trigger: string; occurrence?: string; record: ProbationAutomationCase; facts: ProbationEventFacts; pending?: string[] | null; anchors?: Record<string, string | null>; today?: string}) {
  const context = await probationAutomationContextTx(tx, input.record.id);
  const letters = input.trigger === 'outcomeDecided' ? await letterVersionsTx(tx, input.record.companyId) : new Map<string, {id: string; state: string}>();
  const effects: Effects = {postingId: null, handoffId: null, documentId: null};
  const {read, aliases} = probationFactReader(input.trigger, input.record, context, input.facts);
  const audience = await probationLegacyAudienceTx(tx, input.record.id, input.facts.partId ?? null);
  const {executors, guards} = probationRuntime(tx, {ctx, trigger: input.trigger, record: input.record, context, facts: input.facts, letters, pending: input.pending ?? null, effects, audience});
  const result = await runAutomationEventTx(tx, {module: 'probation', executors, guards, event: {
    trigger: input.trigger, subjectId: input.record.id, occurrence: input.occurrence ?? '', today: input.today ?? todayInKualaLumpur(), read, aliases,
    anchor: anchor => input.anchors?.[anchor] ?? null,
    skipReason: skip => skip === 'caseClosed' && ['confirmed', 'not_confirmed', 'withdrawn'].includes(input.record.state) ? 'the case is already closed.' : skip === 'noPbp' && !context.holders.pbp ? 'no People Business Partner is found for the case.' : null,
  }});
  return {...result, effects};
}

/** "The probation outcome is decided" (Part 3 recorded). One run per workflow and outcome revision. */
export function runProbationOutcomeDecidedTx(tx: Tx, ctx: SessionContext, input: {record: ProbationAutomationCase; partId: string; dueOn: string | null; outcome: {id: string; revision: number; outcome: string; extensionMonths?: number | null}; resultBand: number | null; overridden: boolean | null}) {
  return emitProbationEventTx(tx, ctx, {trigger: 'outcomeDecided', occurrence: `${input.outcome.id}:${input.outcome.revision}`, record: input.record,
    facts: {partId: input.partId, partType: 3, dueOn: input.dueOn, outcome: input.outcome, resultBand: input.resultBand, overridden: input.overridden}});
}

export type ProbationOutcomeAutomation = {runs: number; waiting: number; failed: number; postingId: string | null; handoffId: string | null};
export async function probationOutcomeAutomationTx(tx: Tx, outcomeId: string): Promise<ProbationOutcomeAutomation> {
  const [row] = await tx.execute<{data: ProbationOutcomeAutomation}>(sql`select app.probation_outcome_automation(${outcomeId}::uuid) as data`);
  return {runs: Number(row.data.runs), waiting: Number(row.data.waiting), failed: Number(row.data.failed), postingId: row.data.postingId ?? null, handoffId: row.data.handoffId ?? null};
}

/** After the letter is released and filed: continues the frozen remaining steps of every run waiting for it. */
export async function resumeProbationOutcomeTx(tx: Tx, ctx: SessionContext, input: {record: ProbationAutomationCase; partId: string; outcome: {id: string; revision: number; outcome: string; extensionMonths?: number | null}; documentId: string}) {
  const context = await probationAutomationContextTx(tx, input.record.id);
  const effects: Effects = {postingId: null, handoffId: null, documentId: input.documentId};
  const facts: ProbationEventFacts = {partId: input.partId, partType: 3, outcome: input.outcome};
  const {read, aliases} = probationFactReader('outcomeDecided', input.record, context, facts);
  const audience = await probationLegacyAudienceTx(tx, input.record.id, input.partId);
  const {executors, guards} = probationRuntime(tx, {ctx, trigger: 'outcomeDecided', record: input.record, context, facts, letters: new Map(), pending: null, effects, audience, released: true});
  const runs = await resumeAutomationRunsTx(tx, {module: 'probation', subjectId: input.record.id, documentId: input.documentId, executors, guards, read, aliases});
  return {runs, effects};
}

/** The case as the runner reads it, from storage (row security applies to the caller). */
export async function probationAutomationCaseTx(tx: Tx, caseId: string): Promise<ProbationAutomationCase | null> {
  const [row] = await tx.execute<{data: ProbationAutomationCase}>(sql`select data from probation_case where id = ${caseId}::uuid and tenant_id = app.current_tenant_id()`);
  return row?.data ?? null;
}
/** Probation triggers that have at least one live shared workflow (one bounded read per trigger). */
export async function liveProbationTriggersTx(tx: Tx, caseId: string, triggers: readonly string[]): Promise<Set<string>> {
  const live = new Set<string>();
  // The caller must be able to run this case's workflows (the storage runner or someone with case access); a signer
  // acting without case access raises no events.
  const [allowed] = await tx.execute<{ok: boolean}>(sql`select app.automation_can_run('probation', ${caseId}::uuid) as ok`);
  if (allowed?.ok !== true) return live;
  for (const trigger of triggers) {
    const [row] = await tx.execute<{n: number}>(sql`select count(*)::int as n from app.automation_runner_workflows('probation', ${trigger}, ${caseId}::uuid)`);
    if (row?.n) live.add(trigger);
  }
  return live;
}
/**
 * Raises catalogue events after a Probation command or sweep step (W3). Only triggers with a live workflow do any work;
 * each runs in its own savepoint so a workflow problem never undoes the command that raised it (the run records it).
 */
export async function emitProbationEventsSafelyTx(tx: Tx, ctx: SessionContext, caseId: string, events: {trigger: string; occurrence: string; facts: ProbationEventFacts; pending?: string[] | null; anchors?: Record<string, string | null>; today?: string}[], knownLive?: Set<string>): Promise<void> {
  if (!events.length || knownLive && !events.some(e => knownLive.has(e.trigger))) return;
  // Nested transactions (driver savepoints): a database error inside one is rolled back to its savepoint and does not
  // doom the caller's transaction, which a plain SQL savepoint cannot promise with this driver.
  let live: ReadonlySet<string> = new Set(), record: ProbationAutomationCase | null = null;
  try {
    [live, record] = await tx.transaction(async scope => {
      const triggers = knownLive ?? await liveProbationTriggersTx(scope, caseId, [...new Set(events.map(e => e.trigger))]);
      return [triggers, triggers.size ? await probationAutomationCaseTx(scope, caseId) : null] as const;
    });
  } catch (error) {
    for (const event of events.slice(0, 20)) await recordProbationEventFailureTx(tx, caseId, event, error);
    return;
  }
  if (record) for (const event of events) if (live.has(event.trigger)) {
    try { await tx.transaction(scope => emitProbationEventTx(scope, ctx, {...event, record})); }
    catch (error) { await recordProbationEventFailureTx(tx, caseId, event, error); }
  }
}
/** The error's class only (never its message, which may carry data): e.g. `AutomationError`, `database 40001`. */
export function automationErrorClass(error: unknown): string {
  const state = pgSqlState(error);
  if (state) return `database ${state}`;
  return error instanceof Error ? (error.name || error.constructor?.name || 'Error').slice(0, 60) : typeof error;
}
/**
 * I6: an event that could not be processed is no longer dropped silently. Each live workflow of its trigger records one
 * failed run (key `failed|trigger|occurrence|day`, so a repeat on the same day is not recorded twice) with the error's
 * class; the case History shows it. Recording is best effort in its own savepoint: it never fails the command.
 */
async function recordProbationEventFailureTx(tx: Tx, caseId: string, event: {trigger: string; occurrence: string; today?: string}, error: unknown): Promise<void> {
  try {
    await tx.transaction(async scope => {
      const at = new Date().toISOString(), day = event.today ?? todayInKualaLumpur(), store = sqlAutomationRunStore(scope);
      const reason = `This event could not be processed (${automationErrorClass(error)}). No step ran for it; check the case by hand.`;
      for (const live of (await liveAutomationWorkflowsTx(scope, 'probation', event.trigger, caseId)).slice(0, 20)) {
        const run = newAutomationRun({id: randomUUID(), workflow: live.workflow, revision: live.revision, subjectId: caseId, eventKey: `failed|${event.trigger}|${event.occurrence}|${day}`.slice(0, 300), skipped: null, at});
        const started = await store.start(run);
        if (!started.created) continue;
        await store.save({...started.run, status: 'failed', failure: reason, log: [...started.run.log, {at, kind: 'failed', step: null, stepId: null, type: null, message: reason}]}, 'running');
      }
    });
  } catch { /* Best effort: recording the failure never fails the command that raised the event. */ }
}
const PENDING_LABEL: Record<string, string> = {lm: 'Line Manager', employee: 'Employee', hod: 'HOD', pbp: 'PBP'};
/** "Pending step" condition value and the users holding it, from a signing document's current pending steps. */
export function probationPendingStep(steps: readonly {role: string; holderId: string | null}[]): {label: string; users: string[]} {
  if (!steps.length) return {label: 'Nobody (all steps done)', users: []};
  return {label: PENDING_LABEL[steps[0].role] ?? steps[0].role, users: [...new Set(steps.flatMap(s => s.holderId ? [s.holderId] : []))]};
}
/**
 * What a Notify step would send on this case for this event, without sending it (G2): the people, subject and body,
 * through the same recipients and merge values as the runner. Used to prove a moved workflow reaches the same people
 * with the same words as the notify-only engine (test/probation-legacy-conversion-db.test.ts).
 */
export async function probationNotifyPreviewTx(tx: Tx, input: {record: ProbationAutomationCase; step: AutomationStep; facts: ProbationEventFacts; pending?: string[] | null}) {
  const context = await probationAutomationContextTx(tx, input.record.id);
  const audience = await probationLegacyAudienceTx(tx, input.record.id, input.facts.partId ?? null);
  const merge = probationMergeValues(input.record, context, input.facts, audience);
  const legacy = input.step.params.legacy === true, words = legacy ? legacyMergeValues(merge, audience) : merge;
  const fill = (value: string) => legacy ? fillLegacyMergeFields(value, words) : fillAutomationMergeFields(value, words);
  const active = await probationActivePeopleTx(tx, input.record.id, [input.step.to, input.step.cc]);
  const addressees = probationEmailAddressees(input.step.to, input.step.cc, context, input.facts, input.pending ?? null, audience, !legacy, active);
  return {userIds: [...addressees.all.userIds].sort(), subject: fill(text(input.step.params.subject)), body: fill(text(input.step.params.body))};
}

/** One shared workflow run on a case, as the case History shows it (I5). Recipients are counts, never names. */
export type ProbationAutomationHistoryRun = {
  id: string; trigger: string; triggerLabel: string; status: 'running' | 'waiting' | 'done' | 'skipped' | 'failed';
  startedAt: string; updatedAt: string; failure: string | null;
  entries: {at: string; kind: string; message: string; recipients: number; unresolved: {meantFor: string; reason: string}[]}[];
};
export const MAX_HISTORY_RUNS = 50, MAX_HISTORY_ENTRIES = 30;
/**
 * I5: the shared automation run log of one case (runs, skipped steps with their reason, failures, recipients nobody
 * resolved for and the fallback), newest first and bounded (50 runs, the last 30 entries each). Readable only by
 * someone who can see the case: the case access rule is checked first (app.automation_run_subject_access), then the
 * rows are read under the run table's own row security.
 */
export async function probationAutomationHistoryTx(tx: Tx, caseId: string): Promise<ProbationAutomationHistoryRun[]> {
  const [allowed] = await tx.execute<{ok: boolean}>(sql`select app.automation_run_subject_access('probation', ${caseId}::uuid) as ok`);
  if (allowed?.ok !== true) return [];
  const rows = await tx.execute<{id: string; trigger: string; status: ProbationAutomationHistoryRun['status']; started: string; updated: string; failure: string | null; log: {at: string; kind: string; message: string; recipients?: string[]; unresolved?: {meantFor: string; reason: string}[]}[]}>(sql`
    select id, trigger_event as trigger, status, started_at::text as started, updated_at::text as updated, failure,
      (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from jsonb_array_elements(log) with ordinality x(e, n) where n > jsonb_array_length(log) - ${MAX_HISTORY_ENTRIES}) as log
    from automation_run where tenant_id = app.current_tenant_id() and module = 'probation' and subject_id = ${caseId}::uuid
    order by started_at desc, id limit ${MAX_HISTORY_RUNS}`);
  const labels = new Map(PROBATION_AUTOMATION_CATALOGUE.triggers.map(t => [t.id, t.label]));
  return rows.map(r => ({id: r.id, trigger: r.trigger, triggerLabel: labels.get(r.trigger) ?? r.trigger, status: r.status, startedAt: r.started, updatedAt: r.updated, failure: r.failure,
    entries: (Array.isArray(r.log) ? r.log : []).map(e => ({at: text(e.at), kind: text(e.kind), message: text(e.message).slice(0, 1000), recipients: Array.isArray(e.recipients) ? e.recipients.length : 0,
      unresolved: (Array.isArray(e.unresolved) ? e.unresolved : []).slice(0, 20).map(u => ({meantFor: text(u.meantFor).slice(0, 300), reason: text(u.reason).slice(0, 300)}))}))}));
}
