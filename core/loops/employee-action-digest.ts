import { sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { appendEvent } from '../../db/events';
import { workerModule } from '../agent-registry/controls';
import { isModuleEnabled } from '../entitlements';
import { assertNotificationSweepConnection, type NotificationSweepConnection } from '../notice-projection';
import type { LoopRunResult } from './run';
import type { LoopId } from './types';

/** The nightly sweep sends one digest per employment and HR day, using only cases freshly checked by that sweep. */
export async function queueEmployeeLoopDigests(
 ctx: SessionContext,
 connection: NotificationSweepConnection,
 input: { principalId: string; today: string; generation: number; runs: readonly LoopRunResult[] },
): Promise<number> {
 if (ctx.userId || ctx.agent) throw Error('Employee loop digest requires a maintenance context.');
 if (!isModuleEnabled(ctx, 'notifications')) return 0;
 const runIds = input.runs.flatMap(run => run.status === 'ran' && run.companies > 0 ? [run.runId] : []);
 if (!runIds.length) return 0;

 return connection.withTenant(ctx, async tx => {
  await assertNotificationSweepConnection(tx);
  // Match appendEvent's lock order. The AI lock also serializes a second sweep's idempotency check.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:' + ctx.tenantId},0))`);
  const [state] = await tx.execute<{ generation: number | null }>(sql`select app.ai_centre_assert_running(${input.generation}::integer) as generation`);
  if (state?.generation == null) return 0;

  const rows = await tx.execute<{ employment_id: string; company_id: string; worker_id: LoopId; id: string }>(sql`
   SELECT c.employment_id, c.company_id, c.worker_id, c.id
   FROM public.teras_loop_case c
   JOIN public.teras_loop_run r ON r.tenant_id=c.tenant_id AND r.worker_id=c.worker_id AND r.company_id=c.company_id AND r.run_id=c.checked_run_id
   JOIN public.teras_worker_control w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id AND w.enabled
    AND w.changed_by_user_id=r.sponsor_user_id AND w.changed_at<=r.started_at
   JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
   WHERE c.tenant_id=${ctx.tenantId}::uuid AND c.state='open' AND c.recipient='employee'
    AND r.status='ran' AND r.run_id IN (${sql.join(runIds.map(id => sql`${id}::uuid`), sql`, `)})
    AND c.worker_id IN ('loop_missed_clock_outs','loop_missing_employee_data','loop_document_expiry')
    AND e.hired_on<=${input.today}::date AND (e.terminated_on IS NULL OR e.terminated_on>=${input.today}::date)
    AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.tenant_id=e.tenant_id AND u.person_id=e.person_id AND NOT app.login_blocked(u.id))
    AND NOT EXISTS (SELECT 1 FROM public.teras_loop_pause p WHERE p.tenant_id=c.tenant_id AND p.company_id=c.company_id AND p.worker_id=c.worker_id AND p.paused)
    AND NOT EXISTS (SELECT 1 FROM public.teras_loop_level l WHERE l.tenant_id=c.tenant_id AND l.company_id=c.company_id AND l.worker_id=c.worker_id AND l.level=0)
    AND NOT EXISTS (SELECT 1 FROM public.domain_event d WHERE d.tenant_id=c.tenant_id
     AND d.aggregate_type='teras-loop-employee-digest' AND d.aggregate_id=c.employment_id
     AND d.event_type='teras-loop.employee-digest-queued' AND d.payload->>'day'=${input.today})
   ORDER BY c.employment_id,c.id
  `);
  const casesByEmployment = new Map<string, string[]>();
  for (const row of rows) {
   if (!isModuleEnabled(ctx, workerModule(row.worker_id), row.company_id)) continue;
   const cases = casesByEmployment.get(row.employment_id);
   if (cases) cases.push(row.id);
   else casesByEmployment.set(row.employment_id, [row.id]);
  }
  for (const [employmentId, caseIds] of casesByEmployment) {
   await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'teras-loop-employee-digest',
    aggregateId: employmentId,
    eventType: 'teras-loop.employee-digest-queued',
    actor: { type: 'agent', id: input.principalId },
    subjectEmploymentId: employmentId,
    payload: { day: input.today, caseIds },
   });
  }
  return casesByEmployment.size;
 });
}
