/**
 * Recruitment slice 18 review — an application that leaves 'active' (rejected or archived, one at a time or from the "Suggested to
 * archive" list, hired by a move, or by a recorded offer decision) frees what it had booked: its FUTURE interviews that are not yet
 * cancelled are cancelled in the same transaction, recording the person who closed the application and when, exactly as
 * cancelInterview records it. Interviews already held stay as they are (their feedback is history). A cancelled interview frees its
 * meeting room (5219's exclusion constraint ignores cancelled interviews).
 *
 * One set-based UPDATE for every application closed by the statement before it, and one INSERT of domain events (appendEvents).
 * Callers: ./data archiveApplicationsTx and moveApplicationTx, ./offers recordOfferDecision. Reached from outside the pack ONLY
 * through ./service. The hiring manager may close an application but does not operate the job: 5219 lets the job's reviewers update
 * an interview for exactly this (its guard admits only cancelling a future interview of an application that is no longer active).
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvents } from '../../db/events';
import { RecruitmentError, isUuid } from './model';

export async function cancelFutureInterviewsTx(tx: Tx, s: SessionContext, applicationIds: readonly string[]): Promise<number> {
  if (!applicationIds.length) return 0;
  if (!s.userId) throw new RecruitmentError('forbidden');
  if (!applicationIds.every(isUuid)) throw new RecruitmentError('invalid_input');
  const cancelled = await tx.execute<{ id: string; company_id: string; application_id: string }>(sql`
    update recruitment_interview set cancelled_at = now(), cancelled_by_user_id = ${s.userId}::uuid, updated_at = now(), updated_by_user_id = ${s.userId}::uuid
    where tenant_id = ${s.tenantId}::uuid and application_id = any(${`{${[...new Set(applicationIds)].join(',')}}`}::uuid[])
      and cancelled_at is null and starts_at > now()
    returning id, company_id, application_id`);
  await appendEvents(tx, cancelled.map((r) => ({
    tenantId: s.tenantId, aggregateType: 'recruitment-interview', aggregateId: r.id, eventType: 'recruitment-interview.cancelled', actor: actorOf(s),
    payload: { companyId: r.company_id, applicationId: r.application_id, reason: 'application_closed' },
  })));
  return cancelled.length;
}
