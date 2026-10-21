/** SQL projection leaf. No service imports: leave/read/attendance have an existing runtime cycle. */
import {sql} from 'drizzle-orm';
import {leaveRequest} from '../db/schema';

/** Recorded purpose, shared by the cancellation guard and UI readers. A group ID alone does not
 * distinguish an EL submission from a partial-cancellation split. Use with unaliased leave_request. */
export const emergencyLeaveGroupOriginSql = sql<boolean>`exists (
  select 1 from domain_event el_origin
  where el_origin.tenant_id = ${leaveRequest.tenantId}
    and el_origin.subject_employment_id = ${leaveRequest.employmentId}
    and el_origin.aggregate_type = 'leave-request'
    and el_origin.aggregate_id = ${leaveRequest.parentGroupId}
    and el_origin.event_type = 'leave-request.emergency.submitted'
)`;

/** Ordinary repeated splits remain eligible. A genuine EL child can have a cancelled sibling after
 * HR withdraws that sibling, so that state alone must never bypass the existing EL exclusion. */
export const cancellationSplitGroupSql = sql<boolean>`(
  ${leaveRequest.parentGroupId} is not null and not ${emergencyLeaveGroupOriginSql}
  and exists (select 1 from leave_request s
    where s.tenant_id = ${leaveRequest.tenantId} and s.employment_id = ${leaveRequest.employmentId}
      and s.parent_group_id = ${leaveRequest.parentGroupId} and s.status = 'cancelled')
)`;

