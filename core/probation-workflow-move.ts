/**
 * "Move to shared workflows" (lane G2, migration 5757): the explicit, per-tenant, idempotent and audited administrator
 * action that moves notify-only Probation workflows onto the shared engine. Authorized on the server for the Probation
 * configure permission (app.automation_can_configure('probation')), in one transaction:
 *  1. reads the latest published version of every notify-only workflow of the tenant (bounded) and the moves already made;
 *  2. converts each one whose mapping is proven exact (lib/automation/probation-legacy.ts) and checks it as the shared
 *     builder would (catalogue, references, Probation step settings);
 *  3. hands every converted workflow to app.probation_workflow_move, which saves them Live, marks every version of each
 *     moved definition so the old engine stops firing it (no case is ever notified twice) and audits both, set-based.
 * The rest stay on the old engine and are listed with the reason. Running it again moves nothing twice.
 */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {automationReferencesTx} from './automation-builder';
import {automationWorkflowProblems} from '../lib/automation/workflow';
import {probationStepParamProblems} from '../lib/automation/email';
import {PROBATION_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/probation';
import {convertProbationLegacyWorkflow} from '../lib/automation/probation-legacy';
import type {ProbationWorkflow} from '../lib/probation-workflow';

export const MAX_MOVED_WORKFLOWS = 200;
export type ProbationWorkflowMoveResult = {
  moved: {definitionId: string; workflowId: string; name: string; companyName: string}[];
  kept: {definitionId: string; name: string; companyName: string; reason: string}[];
  alreadyMoved: number;
};

/** The shared workflow a definition key of a company moves to: the same id every time (idempotent). */
export function movedWorkflowId(tenantId: string, companyId: string, definitionKey: string): string {
  const h = createHash('sha256').update(`probation-legacy-workflow:${tenantId}:${companyId}:${definitionKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function moveProbationWorkflowsToShared(ctx: SessionContext, input: {reason: string}): Promise<ProbationWorkflowMoveResult> {
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500) throw new AutomationError('invalid', 'Give a reason of 3 to 500 characters.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const [allowed] = await tx.execute<{ok: boolean}>(sql`select app.automation_can_configure('probation') as ok`);
    if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
    // The latest published version of each definition key, per company, with its company's name (one bounded read).
    const definitions = await tx.execute<{id: string; companyId: string; key: string; companyName: string; data: ProbationWorkflow}>(sql`
      select distinct on (b.company_id, b.definition_key) b.id, b.company_id as "companyId", b.definition_key as key, coalesce(co.legal_name, '') as "companyName", b.data
      from probation_builder_definition b join company co on co.id = b.company_id and co.tenant_id = b.tenant_id
      where b.tenant_id = app.current_tenant_id() and b.kind = 'workflow' and b.state = 'published'
      order by b.company_id, b.definition_key, b.version desc limit ${MAX_MOVED_WORKFLOWS + 1}`);
    if (definitions.length > MAX_MOVED_WORKFLOWS) throw new AutomationError('invalid', `Move at most ${MAX_MOVED_WORKFLOWS} workflows at a time.`);
    const moves = new Set((await tx.execute<{definitionId: string}>(sql`select definition_id as "definitionId" from app.probation_workflow_moves()`)).map(r => r.definitionId));
    // Converted workflows only notify: they name no routing, group, person or email template.
    const refs = await automationReferencesTx(tx, []);
    const result: ProbationWorkflowMoveResult = {moved: [], kept: [], alreadyMoved: 0};
    const items: {definitionId: string; workflow: object}[] = [];
    for (const d of definitions) {
      if (moves.has(d.id)) { result.alreadyMoved++; continue; }
      const workflowId = movedWorkflowId(ctx.tenantId, d.companyId, d.key);
      const converted = convertProbationLegacyWorkflow(d.data, {workflowId, companyId: d.companyId});
      if (!converted.ok) { result.kept.push({definitionId: d.id, name: d.data.name, companyName: d.companyName, reason: converted.reason}); continue; }
      const problems = [...automationWorkflowProblems(converted.workflow, PROBATION_AUTOMATION_CATALOGUE, refs), ...probationStepParamProblems(converted.workflow, {emailTemplates: [], letterTemplateIds: null})];
      if (problems.length) { result.kept.push({definitionId: d.id, name: d.data.name, companyName: d.companyName, reason: problems[0]}); continue; }
      items.push({definitionId: d.id, workflow: converted.workflow});
      result.moved.push({definitionId: d.id, workflowId, name: converted.workflow.name, companyName: d.companyName});
    }
    if (items.length) {
      const [row] = await tx.execute<{data: {moved: string[]}}>(sql`select app.probation_workflow_move(${JSON.stringify(items)}::jsonb, ${reason}) as data`);
      const done = new Set(row.data.moved);
      // A definition another administrator moved a moment ago is reported as already moved, not twice.
      result.alreadyMoved += result.moved.filter(m => !done.has(m.definitionId)).length;
      result.moved = result.moved.filter(m => done.has(m.definitionId));
    }
    return result;
  });
}
