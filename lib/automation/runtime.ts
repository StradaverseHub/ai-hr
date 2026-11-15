/**
 * The shared workflow runner (ADR 2026-11-15-probation-shared-automation, decision 2, build step 4; handoff A1, B4).
 *
 * Given a module's catalogue, its live workflows and one event on one case, the runner decides which workflows run,
 * pins the workflow revision onto a run, executes the steps in order and records what happened. Step effects belong to
 * the module: it injects executors (notify, send email, generate a document, create a posting, start offboarding) and
 * a failure hook. Pure apart from those injected functions and the injected run store, so the same code runs against
 * the in-memory store in tests and the database store in core/automation-runtime.ts.
 *
 * Rules:
 *  - A workflow runs when it is live, its trigger is the event's trigger, it is due (date-based triggers: anchor ± days,
 *    optionally counting Monday to Friday only; with "repeat every morning after that" once per day from the due date)
 *    and its conditions match. A "skip when" that applies records a skipped run.
 *  - One run per workflow + case + event key. The key is the trigger and the event occurrence; a date-based trigger adds
 *    its due date, a repeating one adds today. Running the same event again reports the earlier run instead.
 *  - A run freezes the remaining steps of the pinned revision when it starts. Editing, pausing or retiring the workflow
 *    afterwards never changes a run already started, including one waiting for a document.
 *  - Step conditions are evaluated when the step is reached; a skipped step is recorded.
 *  - Generate a document pauses the run until that document is released; `resumeAutomationRuns` then continues the
 *    frozen remaining steps (handoff B4: emails, postings and the offboarding hand-off run only after the last signature).
 *  - Guardrails: a Generate document step whose template is missing or retired fails the run with a reason, nothing after
 *    it runs and the module's `notifyFailure` hook is called; a Send email step whose template is turned off (or gone) is
 *    skipped and noted; no matching workflow at all is reported to the caller.
 */
import {evaluateAutomationConditions,type AutomationFactValue} from './conditions';
import type {AutomationModule,AutomationModuleCatalogue} from './catalogue';
import {routingRecipients,type Routing,type RoutingFacts} from './routing';
import {addAutomationDays,freezeAutomationWorkflow,type AutomationRecipient,type AutomationStep,type AutomationWorkflow} from './workflow';

export type AutomationRuntimeEvent = {
  trigger: string;
  /** The case the event happened on. */
  subjectId: string;
  /** Tells occurrences of one trigger on one case apart (a part id, an outcome revision). Empty when it happens once. */
  occurrence?: string;
  /** Today in the module's HR calendar (YYYY-MM-DD), from the repository's HR date owner. */
  today: string;
  read: (field: string) => AutomationFactValue;
  /** The date a dated trigger counts from, or null when the case has none. */
  anchor: (anchor: string) => string | null;
  /** The skip-when option that applies to this case now, or null. */
  skipReason: (skipWhen: string) => string | null;
};
export type LiveAutomationWorkflow = {workflow: AutomationWorkflow; revision: number};
export type AutomationRunDecision =
  | {workflowId: string; revision: number; outcome: 'run' | 'skip'; eventKey: string; dueDate: string | null; reason: string}
  | {workflowId: string; revision: number; outcome: 'notDue' | 'noDate' | 'noMatch' | 'notLive'; eventKey: null; dueDate: string | null; reason: string};

export type AutomationRunStatus = 'running' | 'waiting' | 'done' | 'skipped' | 'failed';
export type AutomationRunLogKind = 'started' | 'skipped' | 'stepDone' | 'stepSkipped' | 'stepFailed' | 'waiting' | 'resumed' | 'done' | 'failed';
export type AutomationUnresolvedRecipient = {meantFor: string; reason: string};
export type AutomationRunLogEntry = {
  at: string; kind: AutomationRunLogKind; step: number | null; stepId: string | null; type: string | null; message: string;
  recipients?: string[]; unresolved?: AutomationUnresolvedRecipient[];
};
/** A step not yet executed, with its 0-based position in the pinned revision. */
export type AutomationPendingStep = {index: number; step: AutomationStep};
export type AutomationRun = {
  id: string; module: AutomationModule; workflowId: string; workflowRevision: number; subjectId: string;
  eventKey: string; trigger: string; status: AutomationRunStatus;
  /** Position of the next step in the pinned revision. */
  cursor: number;
  waitingFor: string | null;
  remaining: AutomationPendingStep[];
  log: AutomationRunLogEntry[];
  failure: string | null;
};
export const MAX_RUN_LOG = 200;

export type AutomationStepContext = {run: AutomationRun; step: AutomationStep; index: number; read: (field: string) => AutomationFactValue};
export type AutomationStepOutcome =
  | {status: 'done'; message?: string; recipients?: string[]; unresolved?: AutomationUnresolvedRecipient[]}
  | {status: 'skipped'; reason: string}
  | {status: 'wait'; documentId: string; message?: string}
  | {status: 'failed'; reason: string};
export type AutomationStepExecutor = (context: AutomationStepContext) => Promise<AutomationStepOutcome>;
/**
 * Module-provided effects. Return `failed` for a business failure (it stops the run and calls `notifyFailure`); a thrown
 * error is not caught, so the caller's transaction rolls back with it.
 */
export type AutomationExecutors = {
  notify?: AutomationStepExecutor;
  sendEmail?: AutomationStepExecutor;
  generateDocument?: AutomationStepExecutor;
  createPosting?: AutomationStepExecutor;
  startOffboarding?: AutomationStepExecutor;
  /** Called once when a run fails (for Probation: ask the PBP to check and release by hand). */
  notifyFailure: (run: AutomationRun, reason: string) => Promise<void>;
};
export type AutomationRuntimeGuards = {
  /** State of the email template a Send email step names. */
  emailTemplate?: (step: AutomationStep) => 'active' | 'off' | 'missing';
  /** State of the document template a Generate document step names. */
  documentTemplate?: (step: AutomationStep) => 'available' | 'missing' | 'retired';
};
export type AutomationRunDeps = {executors: AutomationExecutors; guards?: AutomationRuntimeGuards; read: (field: string) => AutomationFactValue; now: () => string};

/** Persists runs. `start` is idempotent on (workflow, subject, event key): an existing run is returned with created false. */
export type AutomationRunStore = {
  start: (run: AutomationRun) => Promise<{run: AutomationRun; created: boolean}>;
  save: (run: AutomationRun, expectedStatus: AutomationRunStatus) => Promise<void>;
  waiting: (module: AutomationModule, subjectId: string, documentId: string) => Promise<AutomationRun[]>;
};

/** For date-based triggers: the first day the workflow runs for this case, or null when the case has no date. */
export function automationDueDate(catalogue: AutomationModuleCatalogue, workflow: AutomationWorkflow, event: Pick<AutomationRuntimeEvent, 'anchor'>): string | null {
  const spec = catalogue.triggers.find(t => t.id === workflow.trigger.event);
  if (!spec?.dated) return null;
  const anchor = event.anchor(spec.dated.anchor);
  return anchor ? addAutomationDays(anchor, spec.dated.direction === 'after' ? workflow.trigger.days : -workflow.trigger.days, workflow.trigger.workdays) : null;
}
/** Idempotency key: one run per workflow, case and key. */
export function automationEventKey(workflow: AutomationWorkflow, event: Pick<AutomationRuntimeEvent, 'trigger' | 'occurrence' | 'today'>, dueDate: string | null): string {
  const base = `${event.trigger}|${event.occurrence ?? ''}`;
  if (!dueDate) return base;
  return workflow.trigger.repeat ? `${base}|${event.today}` : `${base}|${dueDate}`;
}

/** Which workflows run for this event, and why the others do not. Nothing is executed or saved. */
export function decideAutomationRuns(catalogue: AutomationModuleCatalogue, workflows: readonly LiveAutomationWorkflow[], event: AutomationRuntimeEvent): {decisions: AutomationRunDecision[]; matched: boolean} {
  const decisions: AutomationRunDecision[] = [];
  for (const {workflow, revision} of workflows) {
    if (workflow.module !== catalogue.module || workflow.trigger.event !== event.trigger) continue;
    const base = {workflowId: workflow.id, revision};
    if (workflow.status !== 'live') { decisions.push({...base, outcome: 'notLive', eventKey: null, dueDate: null, reason: 'The workflow is not live.'}); continue; }
    const spec = catalogue.triggers.find(t => t.id === workflow.trigger.event);
    const dueDate = spec?.dated ? automationDueDate(catalogue, workflow, event) : null;
    if (spec?.dated && !dueDate) { decisions.push({...base, outcome: 'noDate', eventKey: null, dueDate, reason: 'This case has no date to count from.'}); continue; }
    if (dueDate && event.today < dueDate) { decisions.push({...base, outcome: 'notDue', eventKey: null, dueDate, reason: `Due on ${dueDate}.`}); continue; }
    if (!evaluateAutomationConditions(workflow.conditions, event.read).ok) { decisions.push({...base, outcome: 'noMatch', eventKey: null, dueDate, reason: 'The conditions do not match this case.'}); continue; }
    const eventKey = automationEventKey(workflow, event, dueDate);
    const skip = event.skipReason(workflow.skipWhen);
    decisions.push(skip ? {...base, outcome: 'skip', eventKey, dueDate, reason: `Skipped: ${skip}`} : {...base, outcome: 'run', eventKey, dueDate, reason: 'It runs for this case.'});
  }
  return {decisions, matched: decisions.some(d => d.outcome === 'run' || d.outcome === 'skip')};
}

const bounded = (log: AutomationRunLogEntry[]) => log.length > MAX_RUN_LOG ? log.slice(log.length - MAX_RUN_LOG) : log;
function append(run: AutomationRun, entry: AutomationRunLogEntry): void { run.log = bounded([...run.log, entry]); }

/** A new run with the pinned revision's steps frozen onto it. */
export function newAutomationRun(input: {id: string; workflow: AutomationWorkflow; revision: number; subjectId: string; eventKey: string; skipped: string | null; at: string}): AutomationRun {
  const frozen = freezeAutomationWorkflow(input.workflow);
  const run: AutomationRun = {
    id: input.id, module: frozen.module, workflowId: frozen.id, workflowRevision: input.revision, subjectId: input.subjectId,
    eventKey: input.eventKey, trigger: frozen.trigger.event, status: input.skipped ? 'skipped' : 'running', cursor: 0, waitingFor: null,
    remaining: frozen.steps.map((step, index) => ({index, step})), log: [], failure: null,
  };
  append(run, {at: input.at, kind: input.skipped ? 'skipped' : 'started', step: null, stepId: null, type: null, message: input.skipped ? `“${frozen.name}” (version ${input.revision}): ${input.skipped}` : `“${frozen.name}” (version ${input.revision}) started.`});
  return run;
}

async function fail(run: AutomationRun, deps: AutomationRunDeps, at: AutomationPendingStep | null, reason: string): Promise<AutomationRun> {
  run.status = 'failed'; run.failure = reason; run.waitingFor = null;
  append(run, {at: deps.now(), kind: at ? 'stepFailed' : 'failed', step: at ? at.index + 1 : null, stepId: at?.step.id ?? null, type: at?.step.type ?? null, message: reason});
  await deps.executors.notifyFailure(run, reason);
  return run;
}

/** Executes the run's frozen remaining steps in order until it finishes, waits for a document or fails. */
export async function advanceAutomationRun(current: AutomationRun, deps: AutomationRunDeps): Promise<AutomationRun> {
  const run = structuredClone(current);
  if (run.status !== 'running') return run;
  while (run.remaining.length) {
    const next = run.remaining[0], {step, index} = next, at = deps.now();
    const entry = {at, step: index + 1, stepId: step.id, type: step.type};
    run.remaining = run.remaining.slice(1); run.cursor = index + 1;
    const own = evaluateAutomationConditions(step.conditions, deps.read);
    if (!own.ok) { append(run, {...entry, kind: 'stepSkipped', message: 'Skipped: the step’s conditions do not match this case.'}); continue; }
    if (step.type === 'sendEmail') {
      const state = deps.guards?.emailTemplate?.(step);
      if (state === 'off' || state === 'missing') { append(run, {...entry, kind: 'stepSkipped', message: state === 'off' ? 'Skipped: the email template is turned off.' : 'Skipped: the email template no longer exists.'}); continue; }
    }
    if (step.type === 'generateDocument') {
      const state = deps.guards?.documentTemplate?.(step);
      if (state === 'missing' || state === 'retired') return fail(run, deps, next, state === 'retired' ? 'The document template is retired, so the document was not generated. Nothing after this step ran.' : 'No document template is chosen or it no longer exists, so the document was not generated. Nothing after this step ran.');
    }
    const executor = (deps.executors as Record<string, AutomationStepExecutor | undefined>)[step.type];
    if (!executor || step.type === 'notifyFailure') return fail(run, deps, next, `This module cannot run “${step.type}” steps.`);
    const outcome = await executor({run, step, index, read: deps.read});
    if (outcome.status === 'failed') return fail(run, deps, next, outcome.reason);
    if (outcome.status === 'skipped') { append(run, {...entry, kind: 'stepSkipped', message: `Skipped: ${outcome.reason}`}); continue; }
    if (outcome.status === 'wait') {
      run.status = 'waiting'; run.waitingFor = outcome.documentId;
      append(run, {...entry, kind: 'waiting', message: outcome.message ?? 'Waiting until the document is signed and released.'});
      return run;
    }
    append(run, {...entry, kind: 'stepDone', message: outcome.message ?? 'Done.', ...(outcome.recipients ? {recipients: outcome.recipients} : {}), ...(outcome.unresolved?.length ? {unresolved: outcome.unresolved} : {})});
  }
  run.status = 'done';
  append(run, {at: deps.now(), kind: 'done', step: null, stepId: null, type: null, message: 'Finished.'});
  return run;
}

/** Continues a run waiting for this document with its frozen remaining steps. Any other run is returned unchanged. */
export async function resumeAutomationRun(run: AutomationRun, documentId: string, deps: AutomationRunDeps): Promise<AutomationRun> {
  if (run.status !== 'waiting' || run.waitingFor !== documentId) return run;
  const resumed: AutomationRun = {...structuredClone(run), status: 'running', waitingFor: null};
  append(resumed, {at: deps.now(), kind: 'resumed', step: null, stepId: null, type: null, message: 'The document was released; the remaining steps continue.'});
  return advanceAutomationRun(resumed, deps);
}

export type AutomationEventResult = {
  /** False when no live workflow matched: the module routes the case to a person instead (Probation: the PBP). */
  matched: boolean;
  decisions: AutomationRunDecision[];
  runs: AutomationRun[];
  /** Runs this event already started earlier (idempotency); they are not executed again. */
  alreadyRan: AutomationRun[];
};
/** Decides, records and executes every workflow this event starts. */
export async function runAutomationEvent(input: {
  catalogue: AutomationModuleCatalogue; workflows: readonly LiveAutomationWorkflow[]; event: AutomationRuntimeEvent;
  store: AutomationRunStore; executors: AutomationExecutors; guards?: AutomationRuntimeGuards; now: () => string; newId: () => string;
}): Promise<AutomationEventResult> {
  const {decisions, matched} = decideAutomationRuns(input.catalogue, input.workflows, input.event);
  const runs: AutomationRun[] = [], alreadyRan: AutomationRun[] = [];
  const byId = new Map(input.workflows.map(w => [w.workflow.id, w]));
  for (const decision of decisions) {
    if (decision.outcome !== 'run' && decision.outcome !== 'skip') continue;
    const live = byId.get(decision.workflowId)!;
    const fresh = newAutomationRun({id: input.newId(), workflow: live.workflow, revision: live.revision, subjectId: input.event.subjectId, eventKey: decision.eventKey, skipped: decision.outcome === 'skip' ? decision.reason : null, at: input.now()});
    const started = await input.store.start(fresh);
    if (!started.created) { alreadyRan.push(started.run); continue; }
    if (started.run.status !== 'running') { runs.push(started.run); continue; }
    const advanced = await advanceAutomationRun(started.run, {executors: input.executors, guards: input.guards, read: input.event.read, now: input.now});
    await input.store.save(advanced, 'running');
    runs.push(advanced);
  }
  return {matched, decisions, runs, alreadyRan};
}
/** Resumes every run of this case waiting for the released document. */
export async function resumeAutomationRuns(input: {
  module: AutomationModule; subjectId: string; documentId: string; store: AutomationRunStore; executors: AutomationExecutors;
  guards?: AutomationRuntimeGuards; read: (field: string) => AutomationFactValue; now: () => string;
}): Promise<AutomationRun[]> {
  const out: AutomationRun[] = [];
  for (const run of await input.store.waiting(input.module, input.subjectId, input.documentId)) {
    const resumed = await resumeAutomationRun(run, input.documentId, {executors: input.executors, guards: input.guards, read: input.read, now: input.now});
    if (resumed === run) continue;
    await input.store.save(resumed, 'waiting');
    out.push(resumed);
  }
  return out;
}

/** In-memory store with the database store's semantics, for tests and dry runs. */
export function memoryAutomationRunStore(): AutomationRunStore & {runs: AutomationRun[]} {
  const runs: AutomationRun[] = [];
  return {
    runs,
    async start(run) {
      const existing = runs.find(r => r.workflowId === run.workflowId && r.subjectId === run.subjectId && r.eventKey === run.eventKey);
      if (existing) return {run: structuredClone(existing), created: false};
      runs.push(structuredClone(run));
      return {run: structuredClone(run), created: true};
    },
    async save(run, expectedStatus) {
      const index = runs.findIndex(r => r.id === run.id);
      if (index < 0 || runs[index].status !== expectedStatus) throw new Error('This run changed since it was read.');
      runs[index] = structuredClone(run);
    },
    async waiting(module, subjectId, documentId) {
      return runs.filter(r => r.module === module && r.subjectId === subjectId && r.status === 'waiting' && r.waitingFor === documentId).map(r => structuredClone(r));
    },
  };
}

export type AutomationRecipientContext = {
  /** Module roles (`employee`, `directSuperior`): user ids, or null for a role the module does not know. */
  role: (role: string) => readonly string[] | null;
  facts: RoutingFacts;
  routing: (id: string) => Routing | null;
  groupMembers: (groupId: string) => readonly string[] | null;
  /** True when the named person can still receive work. */
  person: (userId: string) => boolean;
  /** Whoever's step is pending, from the module. */
  pending: () => {userIds: readonly string[]; label: string} | null;
  /** The configured fallback group (Probation default: GBS People Ops). */
  fallback: {groupId: string; members: readonly string[]} | null;
  describe: (recipient: AutomationRecipient) => string;
};
export type AutomationRecipientResolution = {userIds: string[]; unresolved: (AutomationUnresolvedRecipient & {recipient: AutomationRecipient})[]; fallbackUsed: boolean};
/**
 * To/CC recipients → user ids. A routing or group as a recipient reaches EVERYONE in the matched group or list (handoff
 * A3). A recipient that resolves to nobody is recorded with who it was meant for and the fallback group receives it.
 */
export function resolveAutomationRecipients(list: readonly AutomationRecipient[], ctx: AutomationRecipientContext): AutomationRecipientResolution {
  const users: string[] = [], unresolved: AutomationRecipientResolution['unresolved'] = [];
  for (const recipient of list) {
    let found: readonly string[] = [], reason: string | null = null;
    if (recipient.kind === 'role') { const ids = ctx.role(recipient.role); found = ids ?? []; reason = ids === null ? 'This module has no such recipient.' : ids.length ? null : 'Nobody holds this role for the case.'; }
    else if (recipient.kind === 'person') { found = ctx.person(recipient.userId) ? [recipient.userId] : []; reason = found.length ? null : 'This person can no longer be found.'; }
    else if (recipient.kind === 'group') { const members = ctx.groupMembers(recipient.groupId); found = members ?? []; reason = !members ? 'The assignment group no longer exists.' : members.length ? null : 'The assignment group has no members.'; }
    else if (recipient.kind === 'routing') { const routing = ctx.routing(recipient.routingId); if (!routing) reason = 'The routing no longer exists.'; else { const r = routingRecipients(routing, ctx.facts, ctx.groupMembers); found = r.userIds; reason = r.missing; } }
    else { const pending = ctx.pending(); found = pending?.userIds ?? []; reason = found.length ? null : 'Nobody’s step is pending.'; }
    if (found.length) users.push(...found);
    else unresolved.push({recipient, meantFor: ctx.describe(recipient), reason: reason ?? 'Nobody was found.'});
  }
  const fallbackUsed = unresolved.length > 0 && !!ctx.fallback?.members.length;
  if (fallbackUsed) users.push(...ctx.fallback!.members);
  return {userIds: [...new Set(users)], unresolved, fallbackUsed};
}
