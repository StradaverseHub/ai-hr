/**
 * Shared automation definition store (ADR docs/adr/2026-11-15-probation-shared-automation.md; migration 5740).
 *
 * Reads run under row security (only people who can configure the module see its workflows). Saves go through
 * app.automation_workflow_save / app.automation_routing_save, which own authority, tenancy, revision order, retirement
 * and bounds. Before the call this service checks meaning against the module catalogue: a workflow may be saved Paused
 * with problems (the editor saves as people work), but never saved Live with problems (handoff A1). Routings must be
 * valid to save, because approvals and recipients resolve through them. Everything for one save runs in one
 * transaction; each read is bounded and set-based.
 */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {withScopedLifecycleTenant} from './module-gate';
import {automationCatalogue} from '../lib/automation/catalogues';
import {AUTOMATION_MODULES,type AutomationModule} from '../lib/automation/catalogue';
import {automationMergeWarnings,automationWorkflowProblems,type AutomationReferences,type AutomationWorkflow} from '../lib/automation/workflow';
import {routingProblems,type Routing,type RoutingRow} from '../lib/automation/routing';
import {probationStepParamProblems} from '../lib/automation/email';

export class AutomationError extends Error {
  constructor(public readonly code: 'forbidden' | 'invalid' | 'conflict' | 'not_found', message: string, public readonly problems: readonly string[] = []) { super(message); this.name = 'AutomationError'; }
}
export const MAX_LISTED_WORKFLOWS = 500;
export const MAX_LISTED_ROUTINGS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredAutomationWorkflow = { workflow: AutomationWorkflow; revision: number; savedAt: string; savedBy: string };
export type StoredAutomationRouting = { routing: Routing; revision: number; retired: boolean; savedAt: string };
type WorkflowRow = { workflowId: string; revision: number; module: AutomationModule; status: AutomationWorkflow['status']; required: boolean; definition: Omit<AutomationWorkflow, 'status' | 'required'>; savedAt: string; savedBy: string };

function stored(row: WorkflowRow): StoredAutomationWorkflow {
  return { workflow: { ...row.definition, id: row.workflowId, module: row.module, status: row.status, required: row.required }, revision: row.revision, savedAt: row.savedAt, savedBy: row.savedBy };
}
function mapDatabaseError(e: unknown): never {
  const state = pgSqlState(e), message = e instanceof Error ? e.message : 'The save was refused.';
  if (state === '42501') throw new AutomationError('forbidden', 'You cannot configure this.');
  if (state === '40001') throw new AutomationError('conflict', 'This changed since you opened it. Reload before saving.');
  if (state === '22023') throw new AutomationError('invalid', message);
  throw e;
}

/** Latest revision of every workflow the user may configure, optionally for one module. Bounded. */
export async function listAutomationWorkflows(ctx: SessionContext, filter: { module?: AutomationModule } = {}): Promise<StoredAutomationWorkflow[]> {
  if (filter.module && !AUTOMATION_MODULES.includes(filter.module)) throw new AutomationError('invalid', 'Unknown module.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const rows = await tx.execute<WorkflowRow>(sql`
      select distinct on (workflow_id) workflow_id as "workflowId", revision, module, status, required, definition, saved_at as "savedAt", saved_by as "savedBy"
      from automation_workflow_version
      where tenant_id = app.current_tenant_id() and (${filter.module ?? null}::text is null or module = ${filter.module ?? null}::text)
      order by workflow_id, revision desc
      limit ${MAX_LISTED_WORKFLOWS}`);
    return rows.map(stored).sort((a, b) => a.workflow.name.localeCompare(b.workflow.name) || a.workflow.id.localeCompare(b.workflow.id));
  });
}

/** One revision exactly as saved: the frozen copy a run pins. */
export async function automationWorkflowRevision(ctx: SessionContext, workflowId: string, revision: number): Promise<StoredAutomationWorkflow> {
  if (!UUID.test(workflowId) || !Number.isInteger(revision) || revision < 1) throw new AutomationError('invalid', 'Unknown workflow revision.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const [row] = await tx.execute<WorkflowRow>(sql`
      select workflow_id as "workflowId", revision, module, status, required, definition, saved_at as "savedAt", saved_by as "savedBy"
      from automation_workflow_version where tenant_id = app.current_tenant_id() and workflow_id = ${workflowId}::uuid and revision = ${revision}`);
    if (!row) throw new AutomationError('not_found', 'This workflow revision is not available.');
    return stored(row);
  });
}

async function references(tx: Tx, people: readonly string[]): Promise<AutomationReferences> {
  // Three bounded statements, one after another on the transaction's connection.
  const routingRows = await tx.execute<{ id: string; retired: boolean }>(sql`select distinct on (routing_id) routing_id as id, retired from automation_routing_version where tenant_id = app.current_tenant_id() order by routing_id, revision desc limit ${MAX_LISTED_ROUTINGS}`);
  const groupRows = await tx.execute<{ id: string }>(sql`select group_id as id from app.automation_assignment_groups()`);
  const personRows = people.length ? await tx.execute<{ id: string }>(sql`select u.id from app.automation_active_users(${`{${people.join(',')}}`}::uuid[]) as u(id)`) : [];
  const routings = new Set(routingRows.filter(r => !r.retired).map(r => r.id)), groups = new Set(groupRows.map(r => r.id)), persons = new Set(personRows.map(r => r.id));
  return { routingExists: id => routings.has(id), groupExists: id => groups.has(id), personExists: id => persons.has(id) };
}

/** Saves the next revision. Returns the revision with any problems (Paused only) and merge-field warnings. */
export async function saveAutomationWorkflow(ctx: SessionContext, input: { workflow: AutomationWorkflow; expectedRevision: number; reason: string }): Promise<{ revision: number; problems: string[]; warnings: string[] }> {
  const { workflow } = input, catalogue = automationCatalogue(workflow.module);
  if (!catalogue) throw new AutomationError('invalid', 'This module does not use the shared builders yet.');
  if (!UUID.test(workflow.id)) throw new AutomationError('invalid', 'Unknown workflow.');
  const people = [...new Set([...workflow.steps.flatMap(s => [...s.to, ...s.cc])].flatMap(r => r.kind === 'person' ? [r.userId] : []))].filter(id => UUID.test(id));
  return withScopedLifecycleTenant(ctx, async tx => {
    // Authority first, so someone who cannot configure the module learns nothing from the catalogue checks.
    const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.automation_can_configure(${workflow.module}) as ok`);
    if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
    const problems = workflow.status === 'retired' ? [] : automationWorkflowProblems(workflow, catalogue, await references(tx, people));
    // Module step settings (which email template, letter, posting event) are checked here too, in the same
    // transaction, so every caller is held to "no Live with problems", not only the builder screen.
    if (workflow.module === 'probation' && workflow.status !== 'retired') {
      const templates = await tx.execute<{ id: string; name: string; active: boolean; retired: boolean }>(sql`
        select distinct on (template_id) template_id as id, name, active, retired from automation_email_template_version
        where tenant_id = app.current_tenant_id() and module = 'probation' order by template_id, revision desc limit 500`);
      problems.push(...probationStepParamProblems(workflow, { emailTemplates: templates, letterTemplateIds: null }));
    }
    if (workflow.status === 'live' && problems.length) throw new AutomationError('invalid', `Fix ${problems.length === 1 ? 'the problem' : `the ${problems.length} problems`} before making it live.`, problems);
    const { status, required, ...definition } = workflow;
    try {
      const [row] = await tx.execute<{ revision: number }>(sql`select app.automation_workflow_save(${workflow.id}::uuid, ${workflow.module}, ${status}, ${required}, ${JSON.stringify(definition)}::jsonb, ${input.expectedRevision}, ${input.reason}) as revision`);
      return { revision: row.revision, problems, warnings: automationMergeWarnings(workflow, catalogue) };
    } catch (e) { mapDatabaseError(e); }
  });
}

/** Latest revision of every routing, retired ones included so the builder can explain a missing reference. */
export async function listAutomationRoutings(ctx: SessionContext): Promise<StoredAutomationRouting[]> {
  return withScopedLifecycleTenant(ctx, async tx => {
    const rows = await tx.execute<{ routingId: string; revision: number; name: string; rows: RoutingRow[]; retired: boolean; savedAt: string }>(sql`
      select distinct on (routing_id) routing_id as "routingId", revision, name, routing_rows as rows, retired, saved_at as "savedAt"
      from automation_routing_version where tenant_id = app.current_tenant_id() order by routing_id, revision desc limit ${MAX_LISTED_ROUTINGS}`);
    return rows.map(r => ({ routing: { id: r.routingId, name: r.name, rows: r.rows }, revision: r.revision, retired: r.retired, savedAt: r.savedAt }))
      .sort((a, b) => a.routing.name.localeCompare(b.routing.name) || a.routing.id.localeCompare(b.routing.id));
  });
}

export async function saveAutomationRouting(ctx: SessionContext, input: { routing: Routing; retired: boolean; expectedRevision: number; reason: string }): Promise<{ revision: number }> {
  if (!UUID.test(input.routing.id)) throw new AutomationError('invalid', 'Unknown routing.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.automation_can_configure_any() as ok`);
    if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
    if (!input.retired) {
      const groups = new Set((await tx.execute<{ id: string }>(sql`select group_id as id from app.automation_assignment_groups()`)).map(r => r.id));
      const problems = routingProblems(input.routing, id => groups.has(id));
      if (problems.length) throw new AutomationError('invalid', 'Fix the routing before saving it.', problems);
    }
    try {
      const [row] = await tx.execute<{ revision: number }>(sql`select app.automation_routing_save(${input.routing.id}::uuid, ${input.routing.name}, ${JSON.stringify(input.routing.rows)}::jsonb, ${input.retired}, ${input.expectedRevision}, ${input.reason}) as revision`);
      return { revision: row.revision };
    } catch (e) { mapDatabaseError(e); }
  });
}
