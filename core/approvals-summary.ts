/**
 * Approval summary — DECIDED status counts (feedback 2dec6406 — "Internal Approval Task Navigation Panel").
 *
 * The one cross-module approvals READ file for the summary cards, following the core/approvals-inbox.ts
 * precedent. decidedStatusCounts returns { approved, rejected, cancelled } ONLY — Pending is NEVER computed
 * in SQL: every pending figure (panel badge, Pending card, section heading, page-header total) comes from
 * the SAME in-memory lists the approvals page already loads, so those numbers agree by construction and
 * cannot diverge from a count(*) behind the loaders' row caps.
 *
 * One grouped count query per table (the feedbackStatusCounts pattern — core/feedback.ts). Scoping mirrors
 * each PENDING list loader exactly, so a card always describes the same population as its badge:
 *   - leave / cancellations / corrections / profile changes filter by the company scope like their
 *     loaders; claims and resignations are plain RLS with NO company filter (their loaders take none).
 *   - cancellations EXCLUDE rows requested by the viewer (their pending list self-excludes); leave,
 *     claims, corrections and profile changes INCLUDE the viewer's own rows (their lists render them,
 *     just with disabled actions).
 * Status mapping per category:
 *   - leave: native approved / rejected / cancelled.
 *   - leave cancellation, replacement leave, profile changes: approved / rejected only → cancelled
 *     renders a dash.
 *   - corrections: split Attendance vs Overtime by the ONE shared isOvertimeCorrection predicate;
 *     approved / rejected only.
 *   - claim: 'paid' folds into approved (a paid claim was approved first); has a real cancelled bucket.
 *   - resignation: accepted → approved, withdrawn → cancelled.
 *   - managerReviews / hrReviews: NO decided counts at all — review outcomes are confirm/extend/terminate
 *     (reviewStatusEnum pending_manager/pending_hr/completed/cancelled), so all three cards show a dash and
 *     Pending comes from the same in-memory queue as the badge.
 * Read-only — no DomainEvent (counting mutates nothing).
 *
 * b833a077 (r362) — TRAVEL IS NO LONGER A CATEGORY HERE. My Travel was removed completely, so `travelCounts`,
 * the `case 'travel'` and travel's summand inside the 'all' aggregate are gone with it, and the 'all'
 * decided totals on /approvals drop by whatever travel used to contribute. The travel_request rows are
 * kept for audit; nothing in the product counts or shows them.
 */
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isAdmin } from '../lib/authz';
import { isOvertimeCorrection } from '../lib/approvals-bulk';
import type { ApprovalCategory } from '../lib/approvals-categories';
import {
  attendanceCorrection,
  claimRequest,
  employment,
  leaveCancellationRequest,
  leaveRequest,
  profileChangeRequest,
  replacementLeaveRequest,
  resignationRequest,
} from '../db/schema';

/** null = this category has no such bucket → the card renders a dash. */
export type DecidedStatusCounts = {
  approved: number | null;
  rejected: number | null;
  cancelled: number | null;
};

const NONE: DecidedStatusCounts = { approved: null, rejected: null, cancelled: null };

const count = sql<number>`count(*)::int`;

const companyScope = (scopeIds: string[] | undefined): SQL | undefined =>
  scopeIds && scopeIds.length ? inArray(employment.companyId, scopeIds) : undefined;

/** Self-exclusion for the categories whose pending lists exclude the viewer's own requests. */
const notMine = (ctx: SessionContext): SQL | undefined =>
  ctx.personId ? ne(employment.personId, ctx.personId) : undefined;

const toMap = (rows: { status: string; count: number }[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + r.count);
  return m;
};

async function leaveCounts(tx: Tx, scopeIds: string[] | undefined): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: leaveRequest.status, count })
    .from(leaveRequest)
    .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
    .where(companyScope(scopeIds))
    .groupBy(leaveRequest.status);
  const m = toMap(rows);
  return { approved: m.get('approved') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: m.get('cancelled') ?? 0 };
}

async function cancellationCounts(
  tx: Tx,
  ctx: SessionContext,
  scopeIds: string[] | undefined,
): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: leaveCancellationRequest.status, count })
    .from(leaveCancellationRequest)
    .innerJoin(employment, eq(employment.id, leaveCancellationRequest.employmentId))
    .where(and(companyScope(scopeIds), notMine(ctx)))
    .groupBy(leaveCancellationRequest.status);
  const m = toMap(rows);
  return { approved: m.get('approved') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: null };
}

/** Both correction sub-types in ONE grouped query; the caller picks the bucket(s) it needs. The group key
 *  and the JS classification both flow through the single shared isOvertimeCorrection predicate. */
async function correctionCounts(
  tx: Tx,
  scopeIds: string[] | undefined,
): Promise<{ attendance: DecidedStatusCounts; overtime: DecidedStatusCounts }> {
  const rows = await tx
    .select({
      status: attendanceCorrection.status,
      // A representative value per (status, has-OT) group: null for the non-OT group, non-null for the OT
      // group — so the shared predicate classifies the GROUP exactly as it classifies a row.
      requestedOtMinutes: sql<number | null>`max(${attendanceCorrection.requestedOtMinutes})`,
      count,
    })
    .from(attendanceCorrection)
    .innerJoin(employment, eq(employment.id, attendanceCorrection.employmentId))
    .where(companyScope(scopeIds))
    .groupBy(attendanceCorrection.status, sql`(${attendanceCorrection.requestedOtMinutes} is not null)`);
  const pick = (ot: boolean): DecidedStatusCounts => {
    const m = toMap(rows.filter((r) => isOvertimeCorrection(r) === ot));
    return { approved: m.get('approved') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: null };
  };
  return { attendance: pick(false), overtime: pick(true) };
}

async function claimCounts(tx: Tx): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: claimRequest.status, count })
    .from(claimRequest)
    .groupBy(claimRequest.status);
  const m = toMap(rows);
  return {
    approved: (m.get('approved') ?? 0) + (m.get('paid') ?? 0),
    rejected: m.get('rejected') ?? 0,
    cancelled: m.get('cancelled') ?? 0,
  };
}

async function profileChangeCounts(
  tx: Tx,
  scopeIds: string[] | undefined,
): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: profileChangeRequest.status, count })
    .from(profileChangeRequest)
    .innerJoin(employment, eq(employment.id, profileChangeRequest.employmentId))
    .where(companyScope(scopeIds))
    .groupBy(profileChangeRequest.status);
  const m = toMap(rows);
  return { approved: m.get('approved') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: null };
}

/**
 * 5ff7daff — replacement leave. approved / rejected only (the table has no cancelled state), scoped by
 * company exactly like its pending list, and INCLUDING the viewer's own rows for the same reason the leave
 * bucket does: that queue renders them, just with the buttons replaced by "Your request".
 */
async function replacementLeaveCounts(
  tx: Tx,
  scopeIds: string[] | undefined,
): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: replacementLeaveRequest.status, count })
    .from(replacementLeaveRequest)
    .innerJoin(employment, eq(employment.id, replacementLeaveRequest.employmentId))
    .where(companyScope(scopeIds))
    .groupBy(replacementLeaveRequest.status);
  const m = toMap(rows);
  return { approved: m.get('approved') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: null };
}

async function resignationCounts(tx: Tx): Promise<DecidedStatusCounts> {
  const rows = await tx
    .select({ status: resignationRequest.status, count })
    .from(resignationRequest)
    .groupBy(resignationRequest.status);
  const m = toMap(rows);
  return { approved: m.get('accepted') ?? 0, rejected: m.get('rejected') ?? 0, cancelled: m.get('withdrawn') ?? 0 };
}

/**
 * The three DECIDED buckets for one selected category (or the 'all' view: decided buckets summed across
 * every category the viewer can access — admin-only queues contribute only for an admin). RLS (withTenant)
 * remains the row-visibility authority: an admin counts org-wide, a manager only their reporting line.
 */
export async function decidedStatusCounts(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  category: ApprovalCategory,
): Promise<DecidedStatusCounts> {
  return withTenant(ctx, async (tx) => {
    switch (category) {
      case 'leave':
        return leaveCounts(tx, scopeIds);
      case 'leaveCancellation':
        return cancellationCounts(tx, ctx, scopeIds);
      case 'replacementLeave':
        return replacementLeaveCounts(tx, scopeIds);
      case 'attendance':
        return (await correctionCounts(tx, scopeIds)).attendance;
      case 'overtime':
        return (await correctionCounts(tx, scopeIds)).overtime;
      case 'claim':
        return claimCounts(tx);
      case 'profileChanges':
        return profileChangeCounts(tx, scopeIds);
      case 'resignations':
        return resignationCounts(tx);
      case 'managerReviews':
      case 'hrReviews':
      case 'rewards':
        return NONE;
      case 'all': {
        const admin = isAdmin(ctx);
        const parts: DecidedStatusCounts[] = [
          await leaveCounts(tx, scopeIds),
          await cancellationCounts(tx, ctx, scopeIds),
          await replacementLeaveCounts(tx, scopeIds),
          ...(Object.values(await correctionCounts(tx, scopeIds)) as DecidedStatusCounts[]),
          await claimCounts(tx),
          ...(admin ? [await profileChangeCounts(tx, scopeIds), await resignationCounts(tx)] : []),
        ];
        return parts.reduce<DecidedStatusCounts>(
          (acc, p) => ({
            approved: (acc.approved ?? 0) + (p.approved ?? 0),
            rejected: (acc.rejected ?? 0) + (p.rejected ?? 0),
            cancelled: (acc.cancelled ?? 0) + (p.cancelled ?? 0),
          }),
          { approved: 0, rejected: 0, cancelled: 0 },
        );
      }
    }
  });
}
