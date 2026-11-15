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
 *  - Notify / Send email: the existing Probation notification transport (in-app); Send email renders the shared email
 *    template, and a template turned off is skipped and noted by the runner.
 *  - A failed run asks the PBP to check and release by hand (the outcome's failure, shown on the case).
 * Organisation conditions and routings use ids (labels shown in the builder). Condition values saved earlier as names
 * still match through the runner's aliases (one-off read-time compatibility).
 */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {runAutomationEventTx,resumeAutomationRunsTx} from './automation-runtime';
import {resolveAutomationRecipients,type AutomationExecutors,type AutomationRun,type AutomationRuntimeGuards,type AutomationStepContext,type AutomationStepOutcome} from '../lib/automation/runtime';
import {conditionFieldsForTrigger} from '../lib/automation/catalogue';
import {PROBATION_AUTOMATION_CATALOGUE,PROBATION_PART_LABELS} from '../lib/automation/catalogues/probation';
import {fillAutomationMergeFields} from '../lib/automation/email';
import type {AutomationFactValue} from '../lib/automation/conditions';
import type {AutomationRecipient,AutomationStep} from '../lib/automation/workflow';
import type {Routing} from '../lib/automation/routing';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

type Holders = {employee?: string | null; lm?: string | null; hod?: string | null; pbp?: string | null};
export type ProbationAutomationContext = {
  holders: Holders;
  org: {businessGroupId: string | null; businessGroupName: string | null; businessGroupCompanyId: string | null; companyId: string; companyName: string | null; departmentId: string | null; departmentName: string | null; jobTitle: string | null};
  people: Partial<Record<'employee' | 'lm' | 'hod' | 'pbp', string>>;
  employeeCode: string | null;
  fallbackGroupId: string | null; postingApproverGroupId: string | null;
  routings: Routing[]; groups: {id: string; members: string[]}[];
  emailTemplates: {id: string; name: string; active: boolean; retired: boolean; subject: string; body: string; cc: AutomationRecipient[]}[];
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
  letter?: {name?: string | null; signingStep?: string | null; sentBackBy?: string | null; sentBackReason?: string | null} | null;
};
type Effects = {postingId: string | null; handoffId: string | null; documentId: string | null};

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
export function probationMergeValues(record: ProbationAutomationCase, context: ProbationAutomationContext, facts: ProbationEventFacts): Record<string, string> {
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
    'letter.documentName': facts.letter?.name ?? '', 'letter.signingStep': facts.letter?.signingStep ?? '',
    'letter.sentBackBy': facts.letter?.sentBackBy ?? '', 'letter.sentBackReason': facts.letter?.sentBackReason ?? '',
    'case.link': `/lifecycle/probation/${record.id}`, today: todayInKualaLumpur(),
  };
}

function recipientsFor(list: readonly AutomationRecipient[], context: ProbationAutomationContext, facts: ProbationEventFacts, pending: string[] | null) {
  const groups = new Map(context.groups.map(g => [g.id, g.members])), routings = new Map(context.routings.map(r => [r.id, r]));
  const fallback = context.fallbackGroupId ? {groupId: context.fallbackGroupId, members: groups.get(context.fallbackGroupId) ?? []} : null;
  return resolveAutomationRecipients(list, {
    role: role => role === 'employee' ? (context.holders.employee ? [context.holders.employee] : []) : role === 'directSuperior' ? (context.holders.lm ? [context.holders.lm] : []) : null,
    // W5: a business group is the business unit (Personnel v2 mapping, the PBP rule) or its group company (builder options).
    facts: {businessGroup: [context.org.businessGroupId, context.org.businessGroupCompanyId].filter((v): v is string => !!v), company: context.org.companyId, department: context.org.departmentId, jobTitle: context.org.jobTitle},
    routing: id => routings.get(id) ?? null, groupMembers: id => groups.get(id) ?? null,
    person: userId => /^[0-9a-f-]{36}$/i.test(userId),
    pending: () => pending?.length ? {userIds: pending, label: facts.pendingStep ?? 'Pending step'} : null,
    fallback,
    describe: r => r.kind === 'role' ? (r.role === 'employee' ? 'The employee' : 'Their Direct Superior') : r.kind === 'routing' ? `The routing “${routings.get(r.routingId)?.name ?? 'removed routing'}”` : r.kind === 'group' ? `The assignment group ${r.groupId}` : r.kind === 'person' ? 'A named person' : 'Whoever’s step is pending',
  });
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
  letters: Map<string, {id: string; state: string}>; pending: string[] | null; effects: Effects;
};
function probationRuntime(tx: Tx, input: ExecutorInput): {executors: AutomationExecutors; guards: AutomationRuntimeGuards} {
  const {ctx, record, context, facts, effects} = input;
  const templates = new Map(context.emailTemplates.map(t => [t.id, t]));
  const deliver = async (run: AutomationRun, step: AutomationStep, list: readonly AutomationRecipient[]) => {
    const resolved = recipientsFor(list, context, facts, input.pending);
    if (resolved.userIds.length) await tx.execute(sql`select app.probation_automation_notify(${record.id}::uuid, ${facts.partId ?? null}::uuid, ${run.id + ':' + step.id}, ${input.trigger}, ${`{${resolved.userIds.join(',')}}`}::uuid[])`);
    return resolved;
  };
  const executors: AutomationExecutors = {
    notify: async ({run, step}: AutomationStepContext): Promise<AutomationStepOutcome> => {
      const resolved = await deliver(run, step, [...step.to, ...step.cc]);
      if (!resolved.userIds.length) return {status: 'failed', reason: 'Nobody could be notified, and the fallback group has no members.'};
      return {status: 'done', message: `Notified: ${fillAutomationMergeFields(text(step.params.subject), probationMergeValues(record, context, facts))}`, recipients: resolved.userIds, unresolved: resolved.unresolved.map(u => ({meantFor: u.meantFor, reason: u.reason}))};
    },
    sendEmail: async ({run, step}) => {
      const template = templates.get(text(step.params.emailTemplateId));
      if (!template) return {status: 'skipped', reason: 'the email template no longer exists.'};
      const resolved = await deliver(run, step, [...step.to, ...step.cc, ...template.cc]);
      if (!resolved.userIds.length) return {status: 'failed', reason: 'Nobody could receive the email, and the fallback group has no members.'};
      return {status: 'done', message: `Sent “${fillAutomationMergeFields(template.subject, probationMergeValues(record, context, facts))}” through the Probation notifications.`, recipients: resolved.userIds, unresolved: resolved.unresolved.map(u => ({meantFor: u.meantFor, reason: u.reason}))};
    },
    generateDocument: async ({step}) => {
      const outcome = facts.outcome;
      if (!outcome) return {status: 'failed', reason: 'A letter can only be generated for a decided outcome.'};
      const version = input.letters.get(text(step.params.letterTemplateId));
      if (!version || version.state !== 'published') return {status: 'failed', reason: 'This company has no published version of the chosen letter template.'};
      await tx.execute(sql`savepoint probation_automation_letter`);
      try {
        const {prepareProbationLetterTx} = await import('./probation-letter');
        const prepared = await prepareProbationLetterTx(tx, ctx, {outcomeId: outcome.id, templateId: version.id, revision: outcome.revision, edits: {}});
        await tx.execute(sql`release savepoint probation_automation_letter`);
        effects.documentId = prepared.documentId;
        return {status: 'wait', documentId: prepared.documentId, message: 'The letter is prepared and waits for its signatures and release.'};
      } catch (error) {
        await tx.execute(sql`rollback to savepoint probation_automation_letter`);await tx.execute(sql`release savepoint probation_automation_letter`);
        return {status: 'failed', reason: `The letter could not be prepared: ${error instanceof Error && error.name === 'ProbationError' ? error.message : 'the letter source or template needs review.'}`};
      }
    },
    createPosting: async ({step}) => {
      const outcome = facts.outcome, kind = text(step.params.eventType);
      const eventType = kind === 'Confirmation' ? 'confirmation' as const : kind === 'Probation Extension' ? 'probationExtension' as const : null;
      if (!outcome || !eventType || (eventType === 'confirmation') !== (outcome.outcome === 'confirm') || eventType === 'probationExtension' && outcome.outcome !== 'extend')
        return {status: 'failed', reason: 'The posting does not match the decided outcome.'};
      if (!context.postingApproverGroupId) return {status: 'failed', reason: 'No group is set to approve Personnel postings.'};
      const extension = extensionFacts(record, outcome);
      if (eventType === 'probationExtension' && !extension) return {status: 'failed', reason: 'The approved extension length is missing.'};
      const {createPersonnelPostingTx} = await import('./personnel-posting');
      const posting = await createPersonnelPostingTx(tx, {source: 'probation', sourceRef: record.id, employmentId: await employmentOf(tx, record.id), eventType,
        proposed: eventType === 'confirmation' ? {effectiveDate: record.endOn, remarks: 'Probation outcome: Confirm'} : {effectiveDate: extension!.start, endDate: extension!.endOn, remarks: 'Probation outcome: Extend'},
        approverGroupId: context.postingApproverGroupId, idempotencyKey: outcome.id});
      effects.postingId = posting.id;
      return {status: 'done', message: `Personnel posting PP-${posting.number} created; it waits for approval.`};
    },
    startOffboarding: async () => {
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
  const {executors, guards} = probationRuntime(tx, {ctx, trigger: input.trigger, record: input.record, context, facts: input.facts, letters, pending: input.pending ?? null, effects});
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
  const {executors, guards} = probationRuntime(tx, {ctx, trigger: 'outcomeDecided', record: input.record, context, facts, letters: new Map(), pending: null, effects});
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
  await tx.execute(sql`savepoint probation_events`);
  try {
    const live = knownLive ?? await liveProbationTriggersTx(tx, caseId, [...new Set(events.map(e => e.trigger))]);
    const record = live.size ? await probationAutomationCaseTx(tx, caseId) : null;
    if (record) for (const event of events) if (live.has(event.trigger)) {
      await tx.execute(sql`savepoint probation_event`);
      try { await emitProbationEventTx(tx, ctx, {...event, record}); await tx.execute(sql`release savepoint probation_event`); }
      catch { await tx.execute(sql`rollback to savepoint probation_event`); await tx.execute(sql`release savepoint probation_event`); }
    }
    await tx.execute(sql`release savepoint probation_events`);
  } catch { await tx.execute(sql`rollback to savepoint probation_events`); await tx.execute(sql`release savepoint probation_events`); }
}
const PENDING_LABEL: Record<string, string> = {lm: 'Line Manager', employee: 'Employee', hod: 'HOD', pbp: 'PBP'};
/** "Pending step" condition value and the users holding it, from a signing document's current pending steps. */
export function probationPendingStep(steps: readonly {role: string; holderId: string | null}[]): {label: string; users: string[]} {
  if (!steps.length) return {label: 'Nobody (all steps done)', users: []};
  return {label: PENDING_LABEL[steps[0].role] ?? steps[0].role, users: [...new Set(steps.flatMap(s => s.holderId ? [s.holderId] : []))]};
}
