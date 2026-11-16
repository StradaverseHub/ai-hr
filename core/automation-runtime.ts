/**
 * Thin database service for the shared workflow runner (lib/automation/runtime.ts; migration 5748).
 *
 * Every function takes the caller's transaction: a module runs its workflows inside the same transaction as the command
 * that raised the event (decide an outcome, release a letter), so authorization, the transition, the run and its audit
 * commit together. Workflows are read through app.automation_runner_workflows and runs written through
 * app.automation_run_start / app.automation_run_save, which check app.automation_can_run(module, subject). The module
 * injects its step executors and guards; this file owns no module behaviour. Bounded: at most 200 live workflows per
 * trigger and 50 waiting runs per document.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {AutomationError} from './automation-store';
import {automationCatalogue} from '../lib/automation/catalogues';
import type {AutomationModule} from '../lib/automation/catalogue';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import type {AutomationFactAliases,AutomationFactValue} from '../lib/automation/conditions';
import {resumeAutomationRuns,runAutomationEvent,type AutomationEventResult,type AutomationExecutors,type AutomationPendingStep,type AutomationRun,type AutomationRunLogEntry,type AutomationRunStatus,type AutomationRunStore,type AutomationRuntimeEvent,type AutomationRuntimeGuards,type LiveAutomationWorkflow} from '../lib/automation/runtime';

type RunRow = {
  id: string; module: AutomationModule; workflow_id: string; workflow_revision: number; subject_id: string; event_key: string; trigger_event: string;
  status: AutomationRunStatus; step_cursor: number; waiting_for: string | null; remaining_steps: AutomationPendingStep[]; log: AutomationRunLogEntry[]; failure: string | null;
  started_at?: string; updated_at?: string;
};
export function automationRunFromRow(row: RunRow): AutomationRun {
  return {id: row.id, module: row.module, workflowId: row.workflow_id, workflowRevision: row.workflow_revision, subjectId: row.subject_id, eventKey: row.event_key, trigger: row.trigger_event, status: row.status, cursor: row.step_cursor, waitingFor: row.waiting_for, remaining: row.remaining_steps, log: row.log, failure: row.failure};
}
function mapRunError(e: unknown): never {
  const state = pgSqlState(e);
  if (state === '42501') throw new AutomationError('forbidden', 'This workflow runner is not permitted here.');
  if (state === '40001') throw new AutomationError('conflict', 'This run changed since it was read.');
  if (state === '22023') throw new AutomationError('invalid', e instanceof Error ? e.message : 'The run was refused.');
  throw e;
}
const guarded = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (e) { return mapRunError(e); } };

/** The run store backed by migration 5748, bound to one transaction. */
export function sqlAutomationRunStore(tx: Tx): AutomationRunStore {
  return {
    start: run => guarded(async () => {
      const [row] = await tx.execute<{result: {created: boolean; run: RunRow}}>(sql`select app.automation_run_start(${run.id}::uuid, ${run.module}, ${run.workflowId}::uuid, ${run.workflowRevision}, ${run.subjectId}::uuid, ${run.eventKey}, ${run.trigger}, ${run.status}, ${JSON.stringify(run.remaining)}::jsonb, ${JSON.stringify(run.log)}::jsonb) as result`);
      return {created: row.result.created, run: automationRunFromRow(row.result.run)};
    }),
    save: (run, expectedStatus) => guarded(async () => {
      await tx.execute(sql`select app.automation_run_save(${run.id}::uuid, ${expectedStatus}, ${run.status}, ${run.cursor}, ${run.waitingFor}::uuid, ${JSON.stringify(run.remaining)}::jsonb, ${JSON.stringify(run.log)}::jsonb, ${run.failure})`);
    }),
    waiting: (module, subjectId, documentId) => guarded(async () => {
      const rows = await tx.execute<{run: RunRow}>(sql`select r as run from app.automation_runner_waiting(${module}, ${subjectId}::uuid, ${documentId}::uuid) r`);
      return rows.map(r => automationRunFromRow(r.run));
    }),
  };
}

/** Live workflows of a module for one trigger, latest revision, readable by the runner for this case. */
export async function liveAutomationWorkflowsTx(tx: Tx, module: AutomationModule, trigger: string, subjectId: string): Promise<LiveAutomationWorkflow[]> {
  return guarded(async () => {
    const rows = await tx.execute<{workflow_id: string; revision: number; required: boolean; definition: Omit<AutomationWorkflow, 'status' | 'required'>}>(sql`select workflow_id, revision, required, definition from app.automation_runner_workflows(${module}, ${trigger}, ${subjectId}::uuid)`);
    return rows.map(r => ({revision: r.revision, workflow: {...r.definition, id: r.workflow_id, module, status: 'live' as const, required: r.required}}));
  });
}

/**
 * Runs every live workflow of `module` that this event starts, in the caller's transaction.
 * `result.matched === false` means no workflow matched: the module must route the case to a person (Probation: the PBP).
 */
export async function runAutomationEventTx(tx: Tx, input: {module: AutomationModule; event: AutomationRuntimeEvent; executors: AutomationExecutors; guards?: AutomationRuntimeGuards; now?: () => string}): Promise<AutomationEventResult> {
  const catalogue = automationCatalogue(input.module);
  if (!catalogue) throw new AutomationError('invalid', 'This module does not use the shared builders yet.');
  if (!catalogue.triggers.some(t => t.id === input.event.trigger)) throw new AutomationError('invalid', 'Unknown trigger for this module.');
  const workflows = await liveAutomationWorkflowsTx(tx, input.module, input.event.trigger, input.event.subjectId);
  return runAutomationEvent({catalogue, workflows, event: input.event, store: sqlAutomationRunStore(tx), executors: input.executors, guards: input.guards, now: input.now ?? (() => new Date().toISOString()), newId: randomUUID});
}

/** After a document is released: continues every run of the case waiting for it, with each run's frozen remaining steps. */
export async function resumeAutomationRunsTx(tx: Tx, input: {module: AutomationModule; subjectId: string; documentId: string; executors: AutomationExecutors; guards?: AutomationRuntimeGuards; read: (field: string) => AutomationFactValue; aliases?: AutomationFactAliases; now?: () => string}): Promise<AutomationRun[]> {
  return resumeAutomationRuns({module: input.module, subjectId: input.subjectId, documentId: input.documentId, store: sqlAutomationRunStore(tx), executors: input.executors, guards: input.guards, read: input.read, aliases: input.aliases, now: input.now ?? (() => new Date().toISOString())});
}

/** Case activity: the runs of one case the reader may see (row security: configurers and people with case access). */
export async function automationRunsForSubjectTx(tx: Tx, module: AutomationModule, subjectId: string): Promise<AutomationRun[]> {
  const rows = await tx.execute<RunRow>(sql`
    select id, module, workflow_id, workflow_revision, subject_id, event_key, trigger_event, status, step_cursor, waiting_for, remaining_steps, log, failure
    from automation_run where tenant_id = app.current_tenant_id() and module = ${module} and subject_id = ${subjectId}::uuid
    order by started_at, id limit 200`);
  return rows.map(automationRunFromRow);
}
