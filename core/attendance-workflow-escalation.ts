/**
 * Board daa76ed4 — nightly Escalation Approval runner for Attendance routing version 4 (migration 5141).
 *
 * The SQL owner `app.attendance_workflow_escalate` decides everything under the decision guard's lock order: the
 * level must still be pending, not the final level, undecided, not already escalated and due on `today`. It never
 * approves or rejects. This runner only pages due requests through the partial index in bounded keyset batches,
 * one short transaction per batch (a savepoint per request), and appends the escalation event the notification
 * registry projects to the next level's participants. Re-running the same day, or two runners at once, gives one
 * escalation per level: the unique (request, level) row and the row locks make the second attempt a no-op.
 *
 * Runs inside scripts/review-sweep.ts with the no-login system context; any signed-in caller is refused by SQL.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';

export const ATTENDANCE_ESCALATION_EVENT = 'attendance-workflow.stage.escalated';
export const ATTENDANCE_ESCALATION_BATCH_SIZE = 50;
/** 200 batches × 50 = 10,000 escalations per tenant per night; anything left is reported as capped and runs next night. */
export const ATTENDANCE_ESCALATION_MAX_BATCHES = 200;

export type AttendanceEscalationSweepResult = { escalated: number; examined: number; failed: number; batches: number; cappedOut: boolean };
type EscalationRecord = {
  escalationId: string; workflowRequestId: string; correctionId: string; employmentId: string;
  fromStageIndex: number; toStageIndex: number; escalateAfterDays: number; stageReachedAt: string; dueOn: string; escalatedAt: string;
  fromParticipants: unknown[]; partialDecisions: unknown[]; nextParticipants: { employmentId?: string | null; kind?: string }[];
};

export async function sweepAttendanceWorkflowEscalations(
  ctx: SessionContext,
  opts: { today?: string; batchSize?: number; maxBatches?: number } = {},
): Promise<AttendanceEscalationSweepResult> {
  const today = opts.today ?? todayInKualaLumpur();
  const batchSize = opts.batchSize ?? ATTENDANCE_ESCALATION_BATCH_SIZE, maxBatches = opts.maxBatches ?? ATTENDANCE_ESCALATION_MAX_BATCHES;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 || !Number.isInteger(maxBatches) || maxBatches < 1)
    throw new Error('Invalid attendance escalation sweep options.');
  if (ctx.userId) throw new Error('Attendance escalation runs only in the scheduled system context.');
  const result: AttendanceEscalationSweepResult = { escalated: 0, examined: 0, failed: 0, batches: 0, cappedOut: false };
  let after: { on: string; id: string } | null = null;
  while (result.batches < maxBatches) {
    const page: { last: { on: string; id: string } | null; size: number } = await withTenant(ctx, async tx => {
      const due = await tx.execute<{ id: string; escalate_on: string }>(sql`select id,escalate_on::text as escalate_on from app.attendance_workflow_escalation_due(${today}::date,${after?.on ?? null}::date,${after?.id ?? null}::uuid,${batchSize})`);
      for (const row of due) {
        result.examined++;
        try {
          await tx.transaction(async item => {
            const [outcome] = await item.execute<{ result: EscalationRecord | null }>(sql`select app.attendance_workflow_escalate(${row.id}::uuid,${today}::date) as result`);
            const record = outcome?.result;
            if (!record) return;
            await appendEvent(item, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: record.correctionId, eventType: ATTENDANCE_ESCALATION_EVENT,
              actor: actorOf(ctx), subjectEmploymentId: record.employmentId, payload: { ...record, reason: 'no_decision_within_period' } });
            result.escalated++;
          });
        } catch (error) {
          result.failed++;
          console.error(`  Attendance escalation failed for request ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const tail = due.at(-1);
      return { last: tail ? { on: tail.escalate_on, id: tail.id } : null, size: due.length };
    });
    result.batches++;
    if (page.size < batchSize || !page.last) return result;
    after = page.last;
  }
  result.cappedOut = true;
  return result;
}
