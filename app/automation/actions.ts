'use server';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {
  AutomationError,automationBuilderAccess,automationPeopleNames,conditionFieldsForTrigger,dryRunAutomationWorkflow,
  installAutomationDefaults,listAutomationRoutings,automationAssignmentGroups,resolveRoutingRow,
  saveAutomationEmailTemplate,saveAutomationRouting,saveAutomationWorkflow,searchAutomationPeople,
  type AutomationDryRun,type AutomationEmailTemplate,type AutomationRecipient,type AutomationWorkflow,type Routing,
} from '@/packs/automation/service';
import {contractConfigurationDirectory} from '@/packs/contracts/service';
import {probationCase,probationSummaryRows,moveProbationWorkflowsToShared} from '@/packs/probation/service';
import {resignationConfigurationCases,resignationWorkflowDryRun,installResignationDefaults} from '@/packs/lifecycle/resignation/service';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {PROBATION_DEFAULTS} from './probation-defaults';
import type {ActionResult,DryRunEventFacts} from './types';

async function execute<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try { const result = await work(); revalidatePath('/automation', 'layout'); return { ok: true, result }; }
  catch (error) {
    if (error instanceof AutomationError) return { ok: false, code: error.code, detail: error.message, problems: [...error.problems] };
    if (error instanceof Error && ['ProbationError','ResignationJourneyError','ResignationError'].includes(error.name)) return { ok: false, code: 'review', detail: error.message };
    return { ok: false, code: 'unavailable' };
  }
}
async function probationConfigurer() {
  const ctx = await requireScopedLifecycleModule();
  if (!(await automationBuilderAccess(ctx)).probation) throw new AutomationError('forbidden', 'You cannot configure this.');
  return ctx;
}

/** Saves a workflow. The store refuses Live with problems, Probation step settings included. */
export async function saveWorkflowAction(input: { workflow: AutomationWorkflow; expectedRevision: number; reason: string }) {
  return execute(async () => saveAutomationWorkflow(await requireScopedLifecycleModule(), input));
}

export async function saveEmailTemplateAction(input: { template: AutomationEmailTemplate; retired: boolean; expectedRevision: number; reason: string }) {
  return execute(async () => saveAutomationEmailTemplate(await requireScopedLifecycleModule(), input));
}

export async function saveRoutingAction(input: { routing: Routing; retired: boolean; expectedRevision: number; reason: string }) {
  return execute(async () => saveAutomationRouting(await requireScopedLifecycleModule(), input));
}

export async function searchPeopleAction(query: string) {
  return execute(async () => searchAutomationPeople(await requireScopedLifecycleModule(), String(query ?? '')));
}

/** Installs the 16 Probation workflows, 4 email templates and 2 empty routings the prototype ships, Paused. Never run automatically. */
export async function installProbationDefaultsAction() {
  return execute(async () => installAutomationDefaults(await probationConfigurer(), PROBATION_DEFAULTS));
}

/**
 * "Move to shared workflows" (G2): moves every notify-only Probation workflow whose conversion is proven exact onto the
 * shared engine, stops the old definitions firing and lists the rest with the reason. The service authorizes again.
 */
export async function moveProbationWorkflowsAction(input: { reason: string }) {
  return execute(async () => moveProbationWorkflowsToShared(await probationConfigurer(), { reason: String(input?.reason ?? '') }));
}

/** Probation cases the viewer may open, for the dry run's test case. At most 20. */
export async function searchProbationCasesAction(search: string) {
  return execute(async () => {
    const ctx = await probationConfigurer();
    const page = await probationSummaryRows(ctx, { search: String(search ?? '').slice(0, 100), limit: 20 });
    return page.rows.map(row => ({ id: row.id, name: row.employeeName, detail: [row.employeeCode, row.businessGroup, row.department].filter(Boolean).join(' · ') }));
  });
}

const PART_TYPE: Record<string, number> = { 'Part 1 · Week 1 Success Plan': 1, 'Part 2 · Mid-Probation Review': 2, 'Part 3 · Final Confirmation Review': 3 };
const CLOSED = new Set(['confirmed', 'not_confirmed', 'withdrawn']);

/**
 * Dry run against a real Probation case the viewer may open. Case facts come from the Probation service (which checks
 * case access); the event facts are the tester's "what if". Nothing is sent or saved.
 */
export async function dryRunWorkflowAction(input: { workflow: AutomationWorkflow; caseId: string; event: DryRunEventFacts }) {
  return execute(async (): Promise<{ employeeName: string; run: AutomationDryRun }> => {
    const ctx = await probationConfigurer();
    if (input.workflow.module !== 'probation') throw new AutomationError('invalid', 'Dry runs are available for Probation workflows.');
    const view = await probationCase(ctx, input.caseId), record = view.record, facts = record.facts;
    const [routings, groups] = await Promise.all([listAutomationRoutings(ctx), automationAssignmentGroups(ctx)]);
    const routingById = new Map(routings.filter(r => !r.retired).map(r => [r.routing.id, r.routing])), groupName = new Map(groups.map(g => [g.id, g.name]));
    const recipients = input.workflow.steps.flatMap(s => [...s.to, ...s.cc]);
    const personIds = [...recipients.flatMap(r => r.kind === 'person' ? [r.userId] : []), ...[...routingById.values()].flatMap(r => r.rows.flatMap(row => row.assignTo.kind === 'people' ? row.assignTo.userIds : []))];
    const names = new Map((await automationPeopleNames(ctx, personIds)).map(p => [p.id, p.name]));
    const holderName = (userId: string | null) => userId ? view.holderNames[userId] ?? names.get(userId) ?? null : null;
    const available = new Set(conditionFieldsForTrigger(PROBATION_AUTOMATION_CATALOGUE, input.workflow.trigger.event).map(f => f.id));
    const values: Record<string, string | null> = {
      part: input.event.part || null, outcome: input.event.outcome || null, resultBand: input.event.resultBand || null,
      suggestionOverridden: input.event.suggestionOverridden || null, pendingStep: input.event.pendingStep || null,
      reviewPlan: record.planMonths ? `${record.planMonths} months` : null, businessGroup: facts.businessGroup, company: facts.companyName,
      department: facts.department, jobGrade: record.gradeAtStart || facts.grade || null, extensionsUsed: String(record.extensionCount ?? 0),
    };
    const part = [...record.parts].filter(p => p.type === PART_TYPE[input.event.part]).sort((a, b) => b.cycle - a.cycle)[0];
    const role = (holder: 'employee' | 'lm' | 'hod' | 'pbp', missing: string) => { const name = holder === 'employee' ? facts.employeeName : holderName(facts.holders[holder]); return name ? { names: [name], missing: null } : { names: [], missing }; };
    const resolve = (recipient: AutomationRecipient): { names: string[]; missing: string | null } => {
      if (recipient.kind === 'role') return recipient.role === 'employee' ? role('employee', 'The employee cannot be found.') : role('lm', 'No Direct Superior is recorded for this case.');
      if (recipient.kind === 'group') return { names: [`Everyone in “${groupName.get(recipient.groupId) ?? 'a removed group'}”`], missing: groupName.has(recipient.groupId) ? null : 'A chosen assignment group no longer exists.' };
      if (recipient.kind === 'person') { const name = names.get(recipient.userId); return name ? { names: [name], missing: null } : { names: [], missing: 'A chosen person can no longer be found.' }; }
      if (recipient.kind === 'pending') {
        const step = input.event.pendingStep;
        return step === 'Employee' ? role('employee', 'The employee cannot be found.') : step === 'Line Manager' ? role('lm', 'No Direct Superior is recorded for this case.')
          : step === 'HOD' ? role('hod', 'No Head of Department is found for this case.') : step === 'PBP' ? role('pbp', 'No People Business Partner is found for this case.') : { names: [], missing: 'Nobody’s step is pending.' };
      }
      const routing = routingById.get(recipient.routingId);
      if (!routing) return { names: [], missing: 'A chosen routing no longer exists.' };
      const match = resolveRoutingRow(routing, { businessGroup: facts.businessGroupId, company: facts.companyId, department: facts.departmentId, jobTitle: facts.title });
      if (!match) return { names: [], missing: `No row of “${routing.name}” matches this employee.` };
      if (match.row.assignTo.kind === 'group') return { names: [`Everyone in “${groupName.get(match.row.assignTo.groupId) ?? 'a removed group'}” (via ${routing.name})`], missing: null };
      const people = match.row.assignTo.userIds.flatMap(id => names.get(id) ? [`${names.get(id)} (via ${routing.name})`] : []);
      return people.length ? { names: people, missing: null } : { names: [], missing: `“${routing.name}” names nobody for this employee.` };
    };
    const run = dryRunAutomationWorkflow(input.workflow, PROBATION_AUTOMATION_CATALOGUE, {
      read: field => available.has(field) ? values[field] ?? null : undefined,
      anchor: anchor => anchor === 'startDate' ? record.startOn : anchor === 'reviewDueDate' ? part?.dueOn ?? null : anchor === 'kpiOverdueDate' ? record.milestones?.kpiOverdueOn ?? null : null,
      skipReason: skip => skip === 'caseClosed' && CLOSED.has(record.state) ? 'the case is already closed.' : skip === 'noPbp' && !facts.holders.pbp ? 'no People Business Partner is found for the case.' : null,
      resolve,
    });
    return { employeeName: facts.employeeName, run };
  });
}

/** Offboarding dry runs use the same current case authority as the journey; no effects are executed. */
export async function searchOffboardingCasesAction(search:string){
 return execute(async()=>{const rows=await resignationConfigurationCases(await requireScopedLifecycleModule(),{search:String(search??'').slice(0,100),limit:20});return rows.map(row=>({id:row.id,name:row.employeeName,detail:[row.employeeCode,row.number].filter(Boolean).join(' · ')}));});
}
export async function dryRunOffboardingWorkflowAction(input:{workflow:AutomationWorkflow;caseId:string}){
 return execute(async()=>resignationWorkflowDryRun(await requireScopedLifecycleModule(),input));
}

/** Explicit, idempotent setup. New defaults remain Draft until a configurer reviews and activates them. */
export async function installOffboardingDefaultsAction(){return execute(async()=>installResignationDefaults(await requireScopedLifecycleModule()));}
/** Selected-company Contract reviewer search, behind the module owner's exact authority. */
export async function searchContractReviewersAction(input:{companyId:string;query:string;selectedUserIds:string[]}){return execute(async()=>contractConfigurationDirectory(await requireScopedLifecycleModule(),input));}
