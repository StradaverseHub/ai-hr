/**
 * r302 (board 6c9802c9) — MY LEAVE: the reads behind the employee's own leave dashboard.
 *
 * Three things live here and nowhere else, and each is a CONSUMER of an owner that already exists:
 *
 *   1. `myLeaveDashboard` — every figure on the dashboard, per LEAVE YEAR, from `leaveEntitlementBreakdown`
 *      (the owner of per-cycle figures) and, for the cycle in force today, "You can apply for" from
 *      `leaveTypeApplySummary` (the owner of the figure the Apply popup shows and the submit guard checks —
 *      test/r75-leave-apply-available.test.ts pins popup = guard). NOTHING IS COMPUTED HERE: every number is a
 *      PICK off one of those two results, gated by the leave type's ESS view exactly as the page's old grid
 *      (`deriveBalanceRow`) and the Apply popup (`leaveApplySummaryAction`) gated them.
 *   2. `ownLeaveApprovalTrails` / `ownLeaveCancellations` — the display NAMES of the people who decide the
 *      caller's OWN requests, through migration 0472's SECURITY DEFINER functions (person RLS hides them from
 *      an employee; verified in test/r302-my-leave-approver-names.test.ts). Names only, owned requests only.
 *   3. `ownLeaveRejectionReasons` — the whole-request reject reason, which exists only on the
 *      `leave-request.rejected` event (core/leave.ts finalizeLeaveRejection). Read under RLS: domain_event is
 *      subject-scoped (0037), so an employee reads their own events and nobody else's.
 *
 * ── WHICH DATE A LEAVE YEAR'S FIGURES ARE READ AT, AND WHY IT IS THE CYCLE'S LAST DAY ─────────────────────────
 * The build note said "asOf = today for the current leave year". That contradicts the plan the reporter
 * approved — "You can apply for … is the Balance less what is already pending. It is the same figure the Apply
 * Leave form checks against" — for the commonest employee there is: one with APPROVED leave later this year.
 * An approval debits the ledger dated on the leave's START (core/leave.ts finalizeLeaveApproval,
 * `effectiveOn: req.startDate`), and the submit guard sums the whole ledger. Read at today, that debit is
 * outside the window: Taken 0, Balance 14, while the form checks 11 — the page and the form disagree by
 * exactly the booked days. Read at the cycle's last day, the same employee reads Taken 3, Balance 11, and
 * Balance − Pending = You can apply for. test/r302-my-leave-dashboard.test.ts proves both halves. Nothing is
 * forecast by this: the ledger holds only rows already posted (earned accrual posts on its run date, a year
 * opening on the cycle's first day), so a later date adds booked leave, never unearned entitlement.
 *
 * ── WHAT CAN STILL MAKE THE TWO DIFFER (reported, not fixed here) ─────────────────────────────────────────────
 * The submit guard (`availableLeaveBalance`) has no date bound at all. A ledger row dated AFTER this cycle — a
 * next year's grant generated early (production had 2027 and 2028 opened ahead; see `leaveCycleEnd`'s header
 * in core/leave.ts) — counts toward "You can apply for" and not toward this year's Balance. The page prints
 * the guard's own figure rather than a re-derivation, so it is always what the form will accept.
 *
 * ── THE LEAVE YEAR ──────────────────────────────────────────────────────────────────────────────────────────
 * The selector offers the current calendar year and every EARLIER year the employee has ledger rows in. No
 * future year: nothing is forecast. Each card resolves its own cycle (`resolveLeaveYearCycle`: a per-type
 * a2a/c2c override, else the company cycle): for the current year, the cycle in force TODAY; for an earlier
 * year, the cycle that STARTS in that year. An anniversary cycle therefore shows its own dates on its card.
 */
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company, domainEvent, employment, leaveLedger, leaveType } from '../db/schema';
import {
  earnedCycleStart,
  isEarnedAccrualType,
  leaveCycleEnd,
  leaveTypeApplySummary,
  resolveLeaveYearCycle,
} from './leave';
import { leaveBalances, leaveEntitlementBreakdown, listLeaveRequestsPage, type LeaveEntitlementBreakdown } from './read';
import { balanceStoryTypeId, type SharedLeaveBalanceInfo } from '../lib/shared-leave-balance';
import { PRIMARY_CODES, SECONDARY_GROUPS, resolveSecondaryGroup } from '../lib/leave-groups';
import type { EntitlementStatus } from '../lib/entitlement-status';

/** One leave type's card on the dashboard. Every figure is null when HR has hidden it (ESS view) or nothing
 *  could be read — the card renders an em dash, never a number the employee was not meant to see. */
export type MyLeaveCard = {
  leaveTypeId: string;
  leaveType: string;
  code: string | null;
  color: string | null;
  icon: string | null;
  placement: 'primary' | 'secondary';
  /** `isEarnedAccrualType` — the "This is our Annual Leave" type. Only this card gets the ring. */
  annualLeave: boolean;
  cycleStart: string;
  cycleEnd: string;
  /** The date the figures were read at — the cycle's last day (see the header). */
  asOf: string;
  /** The cycle contains today. Only then is "You can apply for" shown: it is a figure about applying now. */
  isCurrentCycle: boolean;
  /** Full-year entitlement (`eligibleDays`). */
  entitlement: number | null;
  /** Granted/earned in the cycle so far (`currentYearEntitlement`). */
  earnedSoFar: number | null;
  /** Debited in the cycle, approved leave later in the cycle included (`takenThisCycle`). */
  taken: number | null;
  /** Current cycle: the submit guard's reservation (`leaveTypeApplySummary.pending`, unpaid days excluded).
   *  An earlier year: the breakdown's pending approval for that year. */
  pending: number | null;
  /** Ledger balance at the cycle's end, gross of pending (`leaveEntitlementBreakdown.balance`). */
  balance: number | null;
  /** Current cycle only: `leaveTypeApplySummary.available` — the Apply popup's figure, verbatim. */
  canApplyFor: number | null;
  /** Current cycle only: Replacement Leave's unused credit expiring soon, when Leave Credit is live. */
  expiringSoon: number | null;
  /** The type has an entitlement table (for anybody). Without one, no Entitlement / Earned so far lines. */
  hasEntitlement: boolean;
  /** No entitlement table, nothing granted, carried or adjusted in the cycle — e.g. Unpaid Leave: the card
   *  shows how much has been taken and nothing else. */
  takenOnly: boolean;
  entitlementStatus: EntitlementStatus;
  sharedBalance: SharedLeaveBalanceInfo | null;
  essView: Record<string, boolean>;
  /** The breakdown the figures were picked from, for the card's Details side-sheet. */
  breakdown: LeaveEntitlementBreakdown | null;
};

export type MyLeaveDashboard = {
  today: string;
  currentYear: number;
  selectedYear: number;
  /** Newest first. Always contains the current year. */
  years: number[];
  /** Ordered: Primary before Secondary (placement is ORDER now, not location); Hidden never present. */
  cards: MyLeaveCard[];
};

const primaryRank = (code: string | null) => {
  const i = code ? (PRIMARY_CODES as readonly string[]).indexOf(code.toUpperCase()) : -1;
  return i === -1 ? PRIMARY_CODES.length : i;
};

/** The leave years the selector offers: this calendar year, and every earlier year the employee has ledger
 *  rows in. Never a future year. RLS scopes the ledger to what the caller may see. */
export function leaveYearsFor(ctx: SessionContext, employmentId: string, today: string): Promise<number[]> {
  const currentYear = Number(today.slice(0, 4));
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ y: sql<number>`extract(year from ${leaveLedger.effectiveOn})::int` })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.employmentId, employmentId), lt(leaveLedger.effectiveOn, `${currentYear}-01-01`)));
    const earlier = rows.map((r) => Number(r.y)).filter((y) => Number.isInteger(y) && y < currentYear);
    return [currentYear, ...[...new Set(earlier)].sort((a, b) => b - a)];
  });
}

/** A `?leaveYear=` value narrowed to one of the offered years; anything else is the current year. */
export function resolveSelectedLeaveYear(raw: string | undefined, years: readonly number[], currentYear: number): number {
  if (raw == null || !/^\d{4}$/.test(raw)) return currentYear;
  const y = Number(raw);
  return years.includes(y) ? y : currentYear;
}

export async function myLeaveDashboard(
  ctx: SessionContext,
  employmentId: string,
  opts: { today: string; year?: string; locale?: string },
): Promise<MyLeaveDashboard> {
  const { today, locale } = opts;
  const currentYear = Number(today.slice(0, 4));
  const years = await leaveYearsFor(ctx, employmentId, today);
  const selectedYear = resolveSelectedLeaveYear(opts.year, years, currentYear);

  // The same type list the page has always read: visible, not archived, eligible-or-active, pooled (r209).
  const balances = (await leaveBalances(ctx, employmentId, locale, { includeArchived: false })).filter(
    (b) => b.placement !== 'hidden',
  );
  if (balances.length === 0) return { today, currentYear, selectedYear, years, cards: [] };

  const storyIds = [...new Set(balances.map((b) => balanceStoryTypeId(b)))];
  const { hiredOn, companyCycle, overrides } = await withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ hiredOn: employment.hiredOn, leaveCycle: company.leaveCycle })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, employmentId))
      .limit(1);
    const types = await tx
      .select({ id: leaveType.id, yearCycleOverride: leaveType.yearCycleOverride })
      .from(leaveType)
      .where(inArray(leaveType.id, storyIds));
    return {
      hiredOn: emp?.hiredOn ?? null,
      companyCycle: emp?.leaveCycle ?? null,
      overrides: new Map(types.map((t) => [t.id, t.yearCycleOverride])),
    };
  });
  if (hiredOn == null) return { today, currentYear, selectedYear, years, cards: [] };

  const cards = await Promise.all(
    balances.map(async (b): Promise<MyLeaveCard> => {
      const storyId = balanceStoryTypeId(b);
      const cycle = resolveLeaveYearCycle(overrides.get(storyId), companyCycle);
      const cycleStart =
        selectedYear === currentYear
          ? earnedCycleStart(hiredOn, today, cycle)
          : earnedCycleStart(hiredOn, `${selectedYear}-12-31`, cycle);
      const cycleEnd = leaveCycleEnd(cycleStart);
      const asOf = cycleEnd;
      const isCurrentCycle = cycleStart <= today && today <= cycleEnd;
      const [bd, apply] = await Promise.all([
        leaveEntitlementBreakdown(ctx, employmentId, storyId, asOf, locale),
        isCurrentCycle ? leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: b.leaveTypeId }) : Promise.resolve(null),
      ]);
      const view = b.essView as Record<string, boolean>;
      const shows = (k: string) => view[k] !== false;
      const hasEntitlement = bd != null && bd.entitlementStatus !== 'no_entitlement_table';
      const takenOnly =
        bd != null && !hasEntitlement && bd.eligibleDays === 0 && bd.totalEntitlement <= 0;
      return {
        leaveTypeId: b.leaveTypeId,
        leaveType: b.leaveType,
        code: b.code,
        color: b.color,
        icon: b.icon,
        placement: b.placement === 'primary' ? 'primary' : 'secondary',
        annualLeave: isEarnedAccrualType(b),
        cycleStart,
        cycleEnd,
        asOf,
        isCurrentCycle,
        entitlement: bd && hasEntitlement && shows('eligible') ? bd.eligibleDays : null,
        earnedSoFar: bd && hasEntitlement && shows('ytdEntitled') ? bd.currentYearEntitlement : null,
        taken: bd && shows('taken') ? bd.takenThisCycle : null,
        pending:
          bd && !takenOnly && shows('pendingApproval') ? (apply ? apply.pending : bd.pendingApproval) : null,
        // Gated on Available AND Taken, as deriveBalanceRow gates the grid's Balance: the two together would
        // otherwise let a hidden figure be recovered by subtraction.
        balance: bd && !takenOnly && shows('available') && shows('taken') ? bd.balance : null,
        canApplyFor: apply && !takenOnly && shows('available') ? apply.available : null,
        expiringSoon: apply && shows('available') ? apply.expiringSoon : null,
        hasEntitlement,
        takenOnly,
        entitlementStatus: bd ? bd.entitlementStatus : 'not_configured',
        sharedBalance: b.sharedBalance ?? null,
        essView: view,
        breakdown: bd,
      };
    }),
  );

  const groupRank = (c: MyLeaveCard) => (SECONDARY_GROUPS as readonly string[]).indexOf(resolveSecondaryGroup(c.code));
  cards.sort(
    (a, b) =>
      (a.placement === 'primary' ? 0 : 1) - (b.placement === 'primary' ? 0 : 1) ||
      (a.placement === 'primary' ? primaryRank(a.code) - primaryRank(b.code) : groupRank(a) - groupRank(b)) ||
      a.leaveType.localeCompare(b.leaveType, locale, { sensitivity: 'base' }),
  );
  return { today, currentYear, selectedYear, years, cards };
}

// ── Names on the caller's own requests (migration 0472) ─────────────────────────────────────────────────────

export type OwnApprovalStep = {
  stepIndex: number;
  kind: string;
  /** Who a still-PENDING step is routed to, when it names one person. Null for role kinds and decided steps. */
  approverName: string | null;
  /** Named any-one alternates of a pending step. */
  alternateNames: string[];
  status: string;
  decidedByName: string | null;
  decidedAt: Date | null;
};

export type OwnApprovalTrail = {
  leaveRequestId: string;
  status: string;
  decidedByName: string | null;
  decidedAt: Date | null;
  /** A pending request with no step rows (a single-level chain): the direct manager it waits for. */
  singleLevelApproverName: string | null;
  steps: OwnApprovalStep[];
};

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** De-duplicated, shape-checked ids: a malformed id is dropped rather than failing the uuid[] cast. */
const uuidList = (ids: readonly string[]) => [...new Set(ids)].filter((id) => UUID_RE.test(id));

/** Approval trail with display names, for requests the CALLER OWNS. Any other id is simply absent. */
export function ownLeaveApprovalTrails(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, OwnApprovalTrail>> {
  const ids = uuidList(leaveRequestIds);
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, OwnApprovalTrail>();
    if (ids.length === 0) return out;
    const res = (await tx.execute(
      sql`SELECT * FROM app.own_leave_request_approvals(${`{${ids.join(',')}}`}::uuid[]) ORDER BY leave_request_id, step_index NULLS FIRST`,
    )) as unknown as {
      leave_request_id: string;
      step_index: number | null;
      approver_kind: string | null;
      approver_name: string | null;
      alternate_names: string[] | null;
      status: string;
      decided_by_name: string | null;
      decided_at: Date | string | null;
    }[];
    for (const r of res) {
      if (r.step_index == null) {
        out.set(r.leave_request_id, {
          leaveRequestId: r.leave_request_id,
          status: r.status,
          decidedByName: r.decided_by_name,
          decidedAt: toDate(r.decided_at),
          singleLevelApproverName: r.approver_name,
          steps: out.get(r.leave_request_id)?.steps ?? [],
        });
      }
    }
    for (const r of res) {
      if (r.step_index == null) continue;
      out.get(r.leave_request_id)?.steps.push({
        stepIndex: Number(r.step_index),
        kind: r.approver_kind ?? '',
        approverName: r.approver_name,
        alternateNames: r.alternate_names ?? [],
        status: r.status,
        decidedByName: r.decided_by_name,
        decidedAt: toDate(r.decided_at),
      });
    }
    return out;
  });
}

export type OwnCancellation = {
  cancelledAt: Date | null;
  cancelledByName: string | null;
  automatic: boolean;
  requestedAt: Date | null;
  reason: string | null;
};

/** Who cancelled the caller's OWN cancelled requests, and when. Any other id is simply absent. */
export function ownLeaveCancellations(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, OwnCancellation>> {
  const ids = uuidList(leaveRequestIds);
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, OwnCancellation>();
    if (ids.length === 0) return out;
    const res = (await tx.execute(
      sql`SELECT * FROM app.own_leave_request_cancellations(${`{${ids.join(',')}}`}::uuid[])`,
    )) as unknown as {
      leave_request_id: string;
      cancelled_at: Date | string | null;
      cancelled_by_name: string | null;
      cancelled_automatically: boolean;
      requested_at: Date | string | null;
      reason: string | null;
    }[];
    for (const r of res) {
      out.set(r.leave_request_id, {
        cancelledAt: toDate(r.cancelled_at),
        cancelledByName: r.cancelled_by_name,
        automatic: r.cancelled_automatically === true,
        requestedAt: toDate(r.requested_at),
        reason: r.reason,
      });
    }
    return out;
  });
}

/** The whole-request reject reason, off the `leave-request.rejected` event (the only place it is stored).
 *  Read under RLS — domain_event is subject-scoped (0037). Newest event per request wins. */
export function ownLeaveRejectionReasons(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = uuidList(leaveRequestIds);
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({
        aggregateId: domainEvent.aggregateId,
        reason: sql<string | null>`${domainEvent.payload} ->> 'rejectReason'`,
        sequence: domainEvent.sequence,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.aggregateType, 'leave-request'),
          eq(domainEvent.eventType, 'leave-request.rejected'),
          inArray(domainEvent.aggregateId, ids),
          isNotNull(domainEvent.payload),
        ),
      )
      .orderBy(domainEvent.sequence);
    for (const r of rows) {
      const reason = r.reason?.trim();
      if (reason) out.set(r.aggregateId, reason);
    }
    return out;
  });
}

// ── Upcoming Leave ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Approved and pending leave from today onwards, soonest first — the plan's "Upcoming Leave", which reverses
 * 11876072's removal of the side panel's upcoming list at the reporter's request (as a page section now, not a
 * panel line). "From today onwards" is OVERLAP: a leave that started yesterday and ends tomorrow is still
 * upcoming for the part not yet taken. The history read's own statuses filter and date window, not a second
 * query shape. Never called with an empty id list — an empty `employmentIds` applies no narrowing at all.
 */
export async function myUpcomingLeave(ctx: SessionContext, employmentIds: readonly string[], today: string) {
  if (employmentIds.length === 0) return [];
  const { rows } = await listLeaveRequestsPage(ctx, {
    employmentIds: [...employmentIds],
    statuses: ['pending', 'approved'],
    from: today,
    sort: 'start',
    dir: 'asc',
    limit: 50,
    offset: 0,
  });
  return rows;
}
