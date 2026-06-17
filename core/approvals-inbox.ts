/**
 * Pending-approvals count for the topbar notification bell (consultant feedback #11): the number of
 * items awaiting THIS user's decision (pending leave from others + attendance corrections + profile
 * changes + claims). The viewer's own pending leave is excluded — the badge means "things needing your
 * action", not "your own requests in flight". Only managers/admins have a queue; everyone else gets 0
 * with no queries. Links to the /approvals inbox, which lists the same items.
 */
import { isAdmin } from '../lib/authz';
import type { SessionContext } from '../db/client';
import { listLeaveRequests } from './read';
import { listAttendanceCorrections } from './attendance';
import { listProfileChangeRequests } from './profile';
import { listPendingClaims } from './claims';

export async function pendingApprovalsCount(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
): Promise<number> {
  const admin = isAdmin(ctx);
  const manager = (ctx.roles ?? []).includes('manager');
  if (!admin && !manager) return 0;

  const [leave, corrections, profileChanges, claims] = await Promise.all([
    listLeaveRequests(ctx, scopeIds),
    listAttendanceCorrections(ctx, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(ctx, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    listPendingClaims(ctx),
  ]);

  const actionableLeave = leave.filter(
    (r) => r.status === 'pending' && (ctx.personId == null || r.personId !== ctx.personId),
  );
  return actionableLeave.length + corrections.length + profileChanges.length + claims.length;
}
