import { eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { employment, leaveRequestDate, person } from '../db/schema';
import type { leaveRequestDateBreakdown } from './read';

type LeaveDateBreakdown = Awaited<ReturnType<typeof leaveRequestDateBreakdown>>[number];

function readDateBreakdowns(tx: Tx, leaveRequestIds: string[]) {
  return tx
    .select({
      requestId: leaveRequestDate.leaveRequestId,
      id: leaveRequestDate.id,
      leaveDate: leaveRequestDate.leaveDate,
      days: leaveRequestDate.days,
      status: leaveRequestDate.status,
      rejectReason: leaveRequestDate.rejectReason,
      decidedAt: leaveRequestDate.decidedAt,
      decidedBy: person.fullName,
    })
    .from(leaveRequestDate)
    .leftJoin(employment, eq(employment.id, leaveRequestDate.decidedByEmploymentId))
    .leftJoin(person, eq(person.id, employment.personId))
    .where(inArray(leaveRequestDate.leaveRequestId, leaveRequestIds))
    .orderBy(leaveRequestDate.leaveRequestId, leaveRequestDate.leaveDate);
}

/** One row-secured query for the bounded set of leave requests visible in Approvals. */
export async function approvalLeaveDateBreakdowns(ctx: SessionContext, leaveRequestIds: readonly string[]) {
  const byRequest = new Map<string, LeaveDateBreakdown[]>();
  if (!leaveRequestIds.length) return byRequest;
  const rows = await withTenant(ctx, tx => readDateBreakdowns(tx, [...new Set(leaveRequestIds)]));
  for (const { requestId, ...date } of rows) {
    const dates = byRequest.get(requestId);
    if (dates) dates.push(date);
    else byRequest.set(requestId, [date]);
  }
  return byRequest;
}
