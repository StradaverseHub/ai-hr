/**
 * Pending-approvals inbox for the topbar notification bell. Originally a bare COUNT (consultant
 * feedback #11); feedback 1514d366 (3-tab bell) turned it into a LIST API — `listPendingTasks`
 * returns the individual items awaiting THIS user's decision (pending leave from others + leave
 * cancellations + attendance corrections + travel + profile changes + claims + resignations +
 * manager and HR employment reviews), each with a deep-link to the page where the user acts on it.
 * `pendingApprovalsCount` stays as the length of that list, so the dashboard card and every
 * existing caller keep their exact semantics. The viewer's own pending requests are excluded —
 * a task means "things needing your action", not "your own requests in flight".
 *
 * 0110 — a Direct Manager via reporting_line may NOT hold the `manager` platform role, so the old
 * `if (!admin && !manager) return 0` short-circuit hid their review queue. The gate also counts a
 * user who has at least one assigned pending_manager review (resolved via manager_employment_id = the
 * caller's own employment) even without the `manager` role — the exact population this feature targets.
 */
import { isAdmin } from '../lib/authz';
import { APPROVAL_SECTION_ID } from '../lib/approvals-focus';
import type { SessionContext } from '../db/client';
import { listLeaveRequests, listPendingLeaveCancellations } from './read';
import { listAttendanceCorrections } from './attendance';
import { listTravelRequests } from './travel-request';
import { listProfileChangeRequests } from './profile';
import { listPendingClaims } from './claims';
import { listResignationRequests } from './offboarding';
import { listReviews, pendingManagerReviewsFor } from './employment-review';
import { myEmployment } from './read';

/** The per-module task vocabulary — each key maps to an i18n label (notifications.task.*). */
export type PendingTaskKind =
  | 'leave'
  | 'leaveCancellation'
  | 'attendance'
  | 'travel'
  | 'profile'
  | 'claim'
  | 'resignation'
  | 'managerReview'
  | 'hrReview';

/** One item awaiting the viewer's decision — serializable (ISO date) so the client bell can render it. */
export type PendingTaskItem = {
  id: string;
  kind: PendingTaskKind;
  subjectName: string | null;
  /** ISO timestamp of when the request was filed (sorts the Task tab, newest first). */
  createdAt: string;
  /** Where the user acts on it — the matching /approvals section where one exists. */
  linkPath: string;
};

/**
 * Which OPTIONAL-module queues the caller may include (r292).
 *
 * THE CALLER DECIDES, AND THAT IS THE POINT. `listAttendanceCorrections` and `listPendingClaims` are
 * service-gated now (core/module-gate.ts) and throw `ModuleNotEnabledError` for a tenant that declined
 * the pack — so this read model has to know, and the two honest ways to find out have OPPOSITE failure
 * behaviour. `isModuleEnabled` is loud on an infrastructure fault, which is right for a service; the
 * quiet `isModuleEnabledOrFalse` degrades, which is right for a page. This function is reached from
 * `app/layout.tsx` — the ROOT layout, on every authenticated render — where a throw 500s every route in
 * the application, and that file already says so about the notifications gate two lines above its call.
 *
 * So the decision is NOT taken here. `test/module-catalog-drift.test.ts` ratchets the quiet readers to
 * `app/` for exactly this reason, and the correct answer is to honour that boundary rather than to widen
 * its owners set: each caller resolves the two booleans with the form appropriate to where IT sits, and
 * this file stays a plain read model with no entitlement read in it at all.
 *
 * REQUIRED, not optional with a default. A default would be a silent answer to a commercial question —
 * `true` would throw for a declined tenant and `false` would hide real tasks from a paying one — and the
 * next caller would inherit whichever was guessed. Making it a parameter puts the compiler on the hook.
 */
export type InboxModules = { attendance: boolean; claims: boolean };

export async function listPendingTasks(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules,
): Promise<PendingTaskItem[]> {
  const admin = isAdmin(ctx);
  const manager = (ctx.roles ?? []).includes('manager');

  // Review queues — resolved first because a Direct Manager without the `manager` role still has one.
  const me = ctx.personId ? await myEmployment(ctx) : null;
  const managerReviews = me?.employmentId
    ? await pendingManagerReviewsFor(ctx, me.employmentId)
    : [];

  if (!admin && !manager && managerReviews.length === 0) return [];

  const [leave, leaveCancellations, corrections, travel, profileChanges, claims, resignations, hrReviews] = await Promise.all([
    listLeaveRequests(ctx, scopeIds, 200, { status: 'pending' }),
    // Partial Leave Cancellation (ADR-0065): pending cancellation requests need the same manager/admin
    // decision as a leave request, so they belong in the inbox — with the same self-exclusion below.
    listPendingLeaveCancellations(ctx, scopeIds),
    // r292 — THE PENDING-TASK COUNT IS A CORE SURFACE (the dashboard tile and the header badge), so it
    // must survive a tenant that declined the optional packs. `listAttendanceCorrections` and
    // `listPendingClaims` are service-gated now (core/module-gate.ts) and would throw
    // ModuleNotEnabledError here. Skipping the queue is also the honest answer: a customer without
    // Attendance has no corrections awaiting anyone. The `...OrFalse` form is used for the reason its
    // header gives — a resolver outage must cost one queue, not the whole inbox.
    modules.attendance ? listAttendanceCorrections(ctx, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    // ADR-0069 Travel Request: same request→decide workflow, same inbox. An employee CAN self-file a travel
    // request (unlike a correction, which is blocked upstream), so it needs explicit self-exclusion below or
    // the requester's own item would leak into their own task list.
    listTravelRequests(ctx, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(ctx, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    modules.claims ? listPendingClaims(ctx) : Promise.resolve([]),
    // Resignations are HR-decided (the service requires admin), so only admins carry them in the inbox.
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
  // Self-exclusion for travel (see note above).
  const actionableTravel = travel.filter(
    (r) => ctx.personId == null || r.personId !== ctx.personId,
  );

  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const items: PendingTaskItem[] = [
    ...actionableLeave.map((r) => ({
      id: r.id,
      kind: 'leave' as const,
      subjectName: r.employee,
      createdAt: iso(r.appliedOn),
      linkPath: `/approvals#${APPROVAL_SECTION_ID.leave}`,
    })),
    ...actionableCancellations.map((r) => ({
      id: r.id,
      kind: 'leaveCancellation' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: `/approvals#${APPROVAL_SECTION_ID.leaveCancellation}`,
    })),
    ...corrections.map((r) => ({
      id: r.id,
      kind: 'attendance' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...actionableTravel.map((r) => ({
      id: r.id,
      kind: 'travel' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...profileChanges.map((r) => ({
      id: r.id,
      kind: 'profile' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...claims.map((r) => ({
      id: r.id,
      kind: 'claim' as const,
      subjectName: r.claimantName ?? null,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...resignations.map((r) => ({
      id: r.id,
      kind: 'resignation' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...managerReviews.map((r) => ({
      id: r.id,
      kind: 'managerReview' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
    ...hrReviews.map((r) => ({
      id: r.id,
      kind: 'hrReview' as const,
      subjectName: r.employee,
      createdAt: iso(r.createdAt),
      linkPath: '/approvals',
    })),
  ];
  // Newest first — the Task tab shows the most recent request at the top.
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function pendingApprovalsCount(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules,
): Promise<number> {
  return (await listPendingTasks(ctx, scopeIds, modules)).length;
}
