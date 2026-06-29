/**
 * Pending-approvals count for the topbar notification bell (consultant feedback #11): the number of
 * items awaiting THIS user's decision (pending leave from others + attendance corrections + profile
 * changes + claims + resignations + employment reviews). The viewer's own pending leave is excluded — the
 * badge means "things needing your action", not "your own requests in flight". Links to /approvals.
 *
 * 0110 — a Direct Manager via reporting_line may NOT hold the `manager` platform role, so the old
 * `if (!admin && !manager) return 0` short-circuit hid their review queue. The gate now also counts a
 * user who has at least one assigned pending_manager review (resolved via manager_employment_id = the
 * caller's own employment) even without the `manager` role — the exact population this feature targets.
 */
import { isAdmin } from '../lib/authz';
import type { SessionContext } from '../db/client';
import { listLeaveRequests, listPendingLeaveCancellations } from './read';
import { listAttendanceCorrections } from './attendance';
import { listProfileChangeRequests } from './profile';
import { listPendingClaims } from './claims';
import { listResignationRequests } from './offboarding';
import { listReviews, pendingManagerReviewsFor } from './employment-review';
import { myEmployment } from './read';

export async function pendingApprovalsCount(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
): Promise<number> {
  const admin = isAdmin(ctx);
  const manager = (ctx.roles ?? []).includes('manager');

  // Review queues — resolved first because a Direct Manager without the `manager` role still has one.
  const me = ctx.personId ? await myEmployment(ctx) : null;
  const managerReviews = me?.employmentId
    ? await pendingManagerReviewsFor(ctx, me.employmentId)
    : [];

  if (!admin && !manager && managerReviews.length === 0) return 0;

  const [leave, leaveCancellations, corrections, profileChanges, claims, resignations, hrReviews] = await Promise.all([
    listLeaveRequests(ctx, scopeIds),
    // Partial Leave Cancellation (ADR-0065): pending cancellation requests need the same manager/admin
    // decision as a leave request, so they belong in the badge — with the same self-exclusion below.
    listPendingLeaveCancellations(ctx, scopeIds),
    listAttendanceCorrections(ctx, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(ctx, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    listPendingClaims(ctx),
    // Resignations are HR-decided (the service requires admin), so only admins carry them in the badge.
    admin ? listResignationRequests(ctx, { status: 'pending' }) : Promise.resolve([]),
    // HR stage of reviews — admin-only decision.
    admin ? listReviews(ctx, { status: 'pending_hr' }) : Promise.resolve([]),
  ]);

  const actionableLeave = leave.filter(
    (r) => r.status === 'pending' && (ctx.personId == null || r.personId !== ctx.personId),
  );
  // Self-exclusion: an employee's own cancellation request is not "awaiting your action".
  const actionableCancellations = leaveCancellations.filter(
    (r) => ctx.personId == null || r.personId !== ctx.personId,
  );
  return (
    actionableLeave.length +
    actionableCancellations.length +
    corrections.length +
    profileChanges.length +
    claims.length +
    resignations.length +
    managerReviews.length +
    hrReviews.length
  );
}
