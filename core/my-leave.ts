/**
 * r302 (board 6c9802c9) — MY LEAVE: the reads behind the employee's own leave dashboard.
 *
 * Three things live here and nowhere else, and each is a CONSUMER of an owner that already exists:
 *
 *   1. `myLeaveDashboard` — every figure on the dashboard, per LEAVE YEAR, from `leaveEntitlementBreakdown`
 *      (the owner of per-cycle figures) and, for the cycle in force today, Pending, Balance and "You can apply
 *      for" from `leaveTypeApplySummary` (the owner of the figures the Apply popup shows and the submit guard
 *      checks — test/r75-leave-apply-available.test.ts pins popup = guard). NOTHING IS COMPUTED HERE: every
 *      number is a PICK off one of those two results, gated by the leave type's ESS view exactly as the page's
 *      old grid (`deriveBalanceRow`) and the Apply popup (`leaveApplySummaryAction`) gated them. The one read
 *      of its own is the itemisation of ledger rows dated after the leave year (see below).
 *   2. `ownLeaveApprovalTrails` / `ownLeaveCancellations` — the display NAMES of the people who decide the
 *      caller's OWN requests, through migration 0472's SECURITY DEFINER functions (person RLS hides them from
 *      an employee; verified in test/r302-my-leave-approver-names.test.ts). Names only, owned requests only.
 *      A row split off by a partial cancellation reads its ROOT request's trail and per-date outcome (fix pass).
 *   3. `ownLeaveRejections` — the reject reason, which exists only on the `leave-request.rejected` event
 *      (core/leave.ts finalizeLeaveRejection): the approver's words for a whole-request rejection, or each
 *      rejected date with its own reason for a per-date one. Read under RLS: domain_event is subject-scoped
 *      (0037), so an employee reads their own events and nobody else's.
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
 * ── LEDGER ROWS DATED AFTER THIS LEAVE YEAR (r302 fix pass, verifier defect 1) ───────────────────────────────
 * The submit guard (`availableLeaveBalance`) has no date bound at all. A ledger row dated AFTER this cycle — leave
 * approved for next January (its debit is dated on its start), or next year's grant generated early (production
 * had 2027 and 2028 opened ahead; see `leaveCycleEnd`'s header in core/leave.ts) — counts toward what the form
 * checks and not toward this year's own balance. Printing this year's balance as Balance beside the form's
 * available made "Balance − Pending = You can apply for" false on screen (14 − 0 beside 12; 14 − 0 beside 28).
 * DECISION: for the current leave year, Entitlement / Earned so far / Taken stay THIS leave year's; Pending,
 * Balance and You can apply for are the Apply form's (`leaveTypeApplySummary`: pending, balance, available), so
 * Balance − Pending = You can apply for = the popup, always. When that Balance differs from this leave year's own,
 * `balanceIncludesLater` says why, from the ROWS dated after the leave year's end — granted (non-debit rows added)
 * and booked (debits, net of their reversals) — or, when those rows do not itemise into exactly the difference,
 * that the Balance includes other entries dated after this leave year. Earlier years are unchanged: their own
 * breakdown, no Apply figure, no line.
 *
 * ── THE LEAVE YEAR ──────────────────────────────────────────────────────────────────────────────────────────
 * The selector offers the current calendar year and every EARLIER year the employee has ledger rows in. No
 * future year: nothing is forecast. Each card resolves its own cycle (`resolveLeaveYearCycle`: a per-type
 * a2a/c2c override, else the company cycle): for the current year, the cycle in force TODAY; for year Y, the
 * cycle (currentYear − Y) cycles BEFORE that one. r302 fix pass (verifier defect 6) — this replaced "the cycle
 * that STARTS in year Y", under which an October–September type showed the same cycle for this year and last
 * year (the cycle in force today started last October) and could never show the one before. Counting back from
 * today's cycle, two selections never show the same cycle and none is skipped. A calendar cycle is unaffected
 * (Y's cycle IS the calendar year Y). An anniversary cycle shows its own dates on its card.
 */
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { company, domainEvent, employment, leaveLedger, leaveRequest, leaveRequestDate, leaveType } from '../db/schema';
// Leave services through the pack facade (ADR-0080 D9), never the pack's implementation modules directly.
import {
  earnedCycleStart,
  isEarnedAccrualType,
  leaveCycleEnd,
  leaveTypeApplySummary,
  resolveLeaveYearCycle,
} from '../packs/leave/service';
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
  /** leave_type.role — what the type IS (65f466e2), so a screen can ask the role rather than a code. */
  role: string | null;
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
  /** Granted/earned in the cycle so far, through the leave type's Rounding Method
   *  (`currentYearEntitlementRounded`). r335 (6af80f5d): it follows the Employee Balances grid on purpose —
   *  the same person opening My Leave and being shown their own row on HR's screen must not be given two
   *  different numbers for one question. The card's Balance is unchanged and still exact. */
  earnedSoFar: number | null;
  /** Debited in the cycle, approved leave later in the cycle included (`takenThisCycle`). */
  taken: number | null;
  /** Current cycle: the submit guard's reservation (`leaveTypeApplySummary.pending`, unpaid days excluded).
   *  An earlier year: the breakdown's pending approval for that year. */
  pending: number | null;
  /** Gross of pending. Current cycle: the Apply form's balance (`leaveTypeApplySummary.balance` — the whole
   *  ledger, so Balance − Pending = You can apply for). An earlier year: the ledger balance at the cycle's end
   *  (`leaveEntitlementBreakdown.balance`). */
  balance: number | null;
  /** Current cycle only: `leaveTypeApplySummary.available` — the Apply popup's figure, verbatim. */
  canApplyFor: number | null;
  /** What is left to use — the ring's third arc. Current cycle: You can apply for. An earlier year: that
   *  year's available at its end (`leaveEntitlementBreakdown.totalAvailable`). */
  remaining: number | null;
  /** Current cycle only, and only when Balance differs from this leave year's own balance: the ledger rows
   *  dated after this leave year, itemised (see the header). Null otherwise. */
  balanceIncludesLater: BalanceIncludesLater | null;
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
  /** The breakdown the figures were picked from, for the card's Details side-sheet. For the current cycle its
   *  Pending Approval and Available are the CARD's (the Apply form's pending and available — r302 fix pass,
   *  verifier defect 2: a part-unpaid pending request read Pending 5 / You can apply for 0 on the card and
   *  Pending Approval 8 / Available −3 in its own Details). */
  breakdown: LeaveEntitlementBreakdown | null;
};

/**
 * What a current-cycle Balance includes beyond this leave year: ledger rows dated after the cycle's end.
 * `granted` — non-debit rows that add days (a grant or credit); `booked` — debits net of their reversals (leave
 * approved for those dates). `itemised` is false when those two do not account for exactly the difference
 * between the Balance and this leave year's own balance (a row that is neither, or a debit reversal larger than
 * its debits): the screen then says only that the Balance includes other entries dated after this leave year.
 * `span` — 'next' when every such row falls in the next leave year, else 'later'.
 */
export type BalanceIncludesLater = { span: 'next' | 'later'; granted: number; booked: number; itemised: boolean };

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The ledger rows of one type dated after `cycleEnd`, itemised against `difference` (see BalanceIncludesLater). */
function ledgerAfterCycle(
  ctx: SessionContext,
  employmentId: string,
  leaveTypeId: string,
  cycleEnd: string,
  difference: number,
): Promise<BalanceIncludesLater> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({
        granted: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} <> 'debit' and ${leaveLedger.days} > 0), 0)`,
        other: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} <> 'debit' and ${leaveLedger.days} < 0), 0)`,
        debits: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'debit'), 0)`,
        last: sql<string | null>`max(${leaveLedger.effectiveOn})::text`,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.employmentId, employmentId),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          gt(leaveLedger.effectiveOn, cycleEnd),
        ),
      );
    // `|| 0` turns a -0 (no debits, negated) into 0.
    const granted = round2(Number(r?.granted ?? 0)) || 0;
    const booked = round2(-Number(r?.debits ?? 0)) || 0;
    const other = round2(Number(r?.other ?? 0)) || 0;
    const nextCycleEnd = leaveCycleEnd(dayAfter(cycleEnd));
    return {
      span: r?.last && r.last > nextCycleEnd ? 'later' : 'next',
      granted,
      booked,
      itemised: other === 0 && booked >= 0 && granted >= 0 && round2(granted - booked) === round2(difference),
    };
  });
}

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

/**
 * ⚠️ `leaveYearsFor` WAS HERE AND d272834b DELETED IT, which is worth a line because deleting a working
 * function usually is not the answer.
 *
 * It offered "this calendar year, plus every earlier year the employee has LEDGER ROWS in" — the ledger
 * with no notion of leave type at all — and it was called from exactly one place: `myLeaveDashboard`'s
 * early exit when the balance list comes back empty. Once the balance read gates on eligibility, an empty
 * list means this employee has no leave type whatsoever, so a year built from their remaining ledger rows
 * can only be a year justified by a card they must not see. On the reporting account those rows are the
 * Maternity accruals on 55 employments: the selector would have gone on offering 2025 for a card the same
 * change had just removed, which is the reported leak in a smaller control.
 *
 * It is DELETED rather than left exported and uncalled because it answers, correctly, the question this
 * screen has deliberately stopped asking. A future reader reaching for it would be reintroducing the leak
 * by picking the obvious helper. The reading that survives is `offeredLeaveYears` below, which derives the
 * years from the cycles of the types that actually DREW A CARD.
 */

/**
 * r302 hand-fix (second verification, defect 3) — the selections the dashboard offers: the current year, and
 * currentYear − N for every N such that some card's type has ledger rows in the cycle N cycles before the one in
 * force today (earnedCycleStart stepped back a day at a time — the mapping myLeaveDashboard renders with). For a
 * January–December type this is exactly the calendar years with rows. Never a future year.
 */
async function offeredLeaveYears(
  ctx: SessionContext,
  employmentId: string,
  today: string,
  hiredOn: string,
  cycleByType: Map<string, string | null | undefined>,
): Promise<number[]> {
  const currentYear = Number(today.slice(0, 4));
  const typeIds = [...cycleByType.keys()];
  if (typeIds.length === 0) return [currentYear];
  const rows = await withTenant(ctx, (tx) =>
    tx
      .selectDistinct({ typeId: leaveLedger.leaveTypeId, d: leaveLedger.effectiveOn })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.employmentId, employmentId), inArray(leaveLedger.leaveTypeId, typeIds), lt(leaveLedger.effectiveOn, today))),
  );
  const backs = new Set<number>();
  for (const typeId of typeIds) {
    const cycle = cycleByType.get(typeId);
    const dates = rows.filter((r) => r.typeId === typeId).map((r) => String(r.d)).sort().reverse();
    let cs = earnedCycleStart(hiredOn, today, cycle);
    let back = 0;
    for (const d of dates) {
      while (d < cs && back < MAX_CYCLES_BACK) {
        const prev = earnedCycleStart(hiredOn, dayBefore(cs), cycle);
        if (prev >= cs) break; // no progress: never loop on a cycle the helper cannot step back from
        cs = prev;
        back++;
      }
      // A cycle that ended before the employee joined is never offered: its card is not shown (myLeaveDashboard).
      if (d >= cs && back >= 1 && leaveCycleEnd(cs) >= hiredOn) backs.add(back);
    }
  }
  return [currentYear, ...[...backs].sort((a, b) => a - b).map((n) => currentYear - n)];
}

/** Bounds offeredLeaveYears' walk back (a century of leave years). */
const MAX_CYCLES_BACK = 100;

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

  // The same type list the page has always read: visible, not archived, pooled (r209) — and, since
  // d272834b, ELIGIBLE. That last word is the whole of the reported defect: this dashboard asked
  // `leaveBalances` for rows and filtered them on `placement` alone, so a leave type whose eligibility
  // says it is not this employee's still drew a card whenever the ledger held a row for it. The gate is
  // not repeated here — it is `leaveBalances`'s own `includeIneligible` (default: gated), the SAME
  // `isProfileEligible` the apply dropdown has always used, so the card and the dropdown can no longer
  // disagree about whether a type is this person's.
  const balances = (await leaveBalances(ctx, employmentId, locale, { includeArchived: false })).filter(
    (b) => b.placement !== 'hidden',
  );
  if (balances.length === 0) {
    // d272834b — NO YEAR BUT THIS ONE. An empty list here means the employee has no leave type at all:
    // the eligible-but-inactive tail adds a row for every active type they ARE eligible for, so nothing
    // survives only when nothing applies to them. Offering 2025 because the ledger holds a Maternity
    // accrual they were never eligible for would put the removed card's history back in the year
    // selector, which is the same leak in a smaller control. The helper that used to be called here
    // (`leaveYearsFor`) was deleted rather than left uncalled — see the note where it stood.
    return { today, currentYear, selectedYear: currentYear, years: [currentYear], cards: [] };
  }

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
  if (hiredOn == null) {
    return { today, currentYear, selectedYear: currentYear, years: [currentYear], cards: [] };
  }
  const cycleByType = new Map(storyIds.map((id) => [id, resolveLeaveYearCycle(overrides.get(id), companyCycle)]));
  // r302 hand-fix (second verification, defect 3) — the selector offers exactly the selections whose cycles hold
  // rows, under the SAME year → cycle mapping the cards use (N years back = N cycles back from today's), so every
  // cycle with rows is reachable and no offered year maps to an empty cycle for want of a calendar-year match.
  const years = await offeredLeaveYears(ctx, employmentId, today, hiredOn, cycleByType);
  const selectedYear = resolveSelectedLeaveYear(opts.year, years, currentYear);

  const maybeCards = await Promise.all(
    balances.map(async (b): Promise<MyLeaveCard | null> => {
      const storyId = balanceStoryTypeId(b);
      const cycle = cycleByType.get(storyId);
      // The cycle in force today, then one cycle back per year before the current one (see the header): the day
      // before a cycle opens belongs to the cycle before it, so this can neither repeat a cycle nor skip one.
      let cycleStart = earnedCycleStart(hiredOn, today, cycle);
      for (let back = currentYear - selectedYear; back > 0; back--) {
        cycleStart = earnedCycleStart(hiredOn, dayBefore(cycleStart), cycle);
      }
      const cycleEnd = leaveCycleEnd(cycleStart);
      // r302 hand-fix (defect 3b) — a leave year that ended before the employee joined is not theirs to show.
      if (cycleEnd < hiredOn) return null;
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
      // Gated on Available AND Taken, as deriveBalanceRow gates the grid's Balance: the two together would
      // otherwise let a hidden figure be recovered by subtraction.
      const balanceShown = bd != null && !takenOnly && shows('available') && shows('taken');
      const balanceIncludesLater =
        balanceShown && apply && round2(apply.balance) !== round2(bd!.balance)
          ? await ledgerAfterCycle(ctx, employmentId, storyId, cycleEnd, apply.balance - bd!.balance)
          : null;
      return {
        leaveTypeId: b.leaveTypeId,
        leaveType: b.leaveType,
        code: b.code,
        color: b.color,
        icon: b.icon,
        role: b.role,
        placement: b.placement === 'primary' ? 'primary' : 'secondary',
        annualLeave: isEarnedAccrualType(b),
        cycleStart,
        cycleEnd,
        asOf,
        isCurrentCycle,
        entitlement: bd && hasEntitlement && shows('eligible') ? bd.eligibleDays : null,
        // r335 (6af80f5d): the ROUNDED figure, exactly as deriveBalanceRow's `ytdEntitled` picks it. The ESS
        // gate is unchanged — `ytdEntitled` is a STORED ess_view_config key and was deliberately not renamed.
        earnedSoFar: bd && hasEntitlement && shows('ytdEntitled') ? bd.currentYearEntitlementRounded : null,
        taken: bd && shows('taken') ? bd.takenThisCycle : null,
        pending:
          bd && !takenOnly && shows('pendingApproval') ? (apply ? apply.pending : bd.pendingApproval) : null,
        balance: balanceShown ? (apply ? apply.balance : bd!.balance) : null,
        canApplyFor: apply && !takenOnly && shows('available') ? apply.available : null,
        remaining: bd && !takenOnly && shows('available') ? (apply ? apply.available : bd.totalAvailable) : null,
        balanceIncludesLater,
        expiringSoon: apply && shows('available') ? apply.expiringSoon : null,
        hasEntitlement,
        takenOnly,
        entitlementStatus: bd ? bd.entitlementStatus : 'not_configured',
        sharedBalance: b.sharedBalance ?? null,
        essView: view,
        // r302 hand-fix (second verification, defect 2) — the Details column must ADD UP: this leave year's Total −
        // Taken − Pending − Forfeited = its Available. Pending is the Apply form's (unpaid days excluded, as the card);
        // Available is this year's balance less it. Where the card's Balance also counts rows dated after this leave
        // year, the two Availables differ by exactly what `balanceIncludesLater` itemises, and the panel prints that
        // line under its column (MyLeaveDashboard passes it) rather than a figure its own lines cannot reach.
        breakdown: bd && apply ? { ...bd, pendingApproval: apply.pending, totalAvailable: round2(bd.balance - apply.pending) } : bd,
      };
    }),
  );
  const cards = maybeCards.filter((c): c is MyLeaveCard => c != null);

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

/** The application's per-date outcome (mixed outcomes only), dates ascending: the approval event's approved and
 *  rejected dates, with the approved dates since GIVEN BACK moved to `cancelled` (r302 hand-fix — see
 *  currentPerDateOutcomes). `cancelled` is present only when a day was given back. */
export type OwnPerDateOutcome = { approved: string[]; rejected: { date: string; reason: string | null }[]; cancelled?: string[] };

export type OwnApprovalTrail = {
  leaveRequestId: string;
  /** The ROW's own status (a split survivor is 'approved' even when its root row was cancelled). */
  status: string;
  decidedByName: string | null;
  decidedAt: Date | null;
  /** A pending request with no step rows (a single-level chain): the direct manager it waits for. */
  singleLevelApproverName: string | null;
  steps: OwnApprovalStep[];
  /**
   * r302 fix pass (verifier defect 3) — WHOSE approval this is.
   *   'own'        the row is the request that was decided (never split off another);
   *   'root'       the row was split off an approved request by a partial cancellation — the decision, the
   *                chain and the per-date outcome above are the ROOT request's (leave-request.split →
   *                splitFromRequestId, followed back as core/toil.ts consumptionRootRequestIdTx follows it);
   *   'unrecorded' the row was split before r299 recorded the lineage: only the row's own decider is known, so
   *                there are no steps — never a partial chain presented as the chain.
   */
  lineage: 'own' | 'root' | 'unrecorded';
  /** 'root' lineage: when the application was submitted (the root request's creation), not the split. */
  submittedAt: Date | null;
  /** r302 fix pass (verifier defect 4) — the application's per-date outcome, from its root's approval event;
   *  null when the approval was not a mixed per-date outcome (or the lineage is unrecorded). */
  perDateOutcome: OwnPerDateOutcome | null;
};

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** De-duplicated, shape-checked ids: a malformed id is dropped rather than failing the uuid[] cast. */
const uuidList = (ids: readonly string[]) => [...new Set(ids)].filter((id) => UUID_RE.test(id));

/** A split chain is one hop per cancellation; the bound only stops a loop that trusts data to terminate. */
const MAX_SPLIT_HOPS = 64;

/**
 * For each id, the request it descends from through partial-cancellation splits: itself when it was never split
 * off another row, the root request's id when every hop recorded `splitFromRequestId`, and NULL when any hop did
 * not (a split before r299) or the chain did not end. Batched per hop; read under RLS (domain_event is
 * subject-scoped), so it can only ever name rows the caller could already see — and nothing is returned for a
 * row unless migration 0472 also answers for it (ownLeaveApprovalTrails).
 */
async function splitRootsTx(tx: Tx, ctx: SessionContext, ids: readonly string[]): Promise<Map<string, string | null>> {
  /** id → the row it was split from; null ⇒ split with no recorded lineage; absent ⇒ never split. */
  const parent = new Map<string, string | null>();
  const asked = new Set<string>();
  let frontier = [...new Set(ids)];
  for (let hop = 0; hop < MAX_SPLIT_HOPS && frontier.length > 0; hop++) {
    for (const id of frontier) asked.add(id);
    const rows = await tx
      .select({ id: domainEvent.aggregateId, from: sql<string | null>`${domainEvent.payload} ->> 'splitFromRequestId'` })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.aggregateType, 'leave-request'),
          eq(domainEvent.eventType, 'leave-request.split'),
          inArray(domainEvent.aggregateId, frontier),
        ),
      )
      .orderBy(asc(domainEvent.sequence));
    for (const r of rows) {
      // The first split event is the row's birth, as consumptionRootRequestIdTx reads it.
      if (!parent.has(r.id)) parent.set(r.id, r.from && UUID_RE.test(r.from) ? r.from : null);
    }
    frontier = [...new Set([...parent.values()].filter((p): p is string => p != null && !asked.has(p)))];
  }
  for (const id of frontier) parent.set(id, null); // hop bound reached: not presented as known
  const rootOf = (id: string): string | null => {
    let cur = id;
    for (let hop = 0; hop <= MAX_SPLIT_HOPS; hop++) {
      if (!parent.has(cur)) return cur;
      const p = parent.get(cur);
      if (p == null) return null;
      cur = p;
    }
    return null;
  };
  return new Map(ids.map((id) => [id, rootOf(id)]));
}

/**
 * r302 hand-fix (second verification, defect 1) — THE APPLICATION'S ROWS, root first. Every row split off `appIds`
 * through leave-request.split's splitFromRequestId, followed DOWN (the inverse of splitRootsTx), batched per hop.
 * Read under RLS (domain_event is subject-scoped): only rows the caller could already see can join a family.
 */
async function applicationFamiliesTx(tx: Tx, ctx: SessionContext, appIds: readonly string[]): Promise<Map<string, string[]>> {
  const familyOf = new Map<string, string>(appIds.map((id) => [id, id]));
  let frontier = [...new Set(appIds)];
  for (let hop = 0; hop < MAX_SPLIT_HOPS && frontier.length > 0; hop++) {
    const rows = await tx
      .select({ id: domainEvent.aggregateId, from: sql<string | null>`${domainEvent.payload} ->> 'splitFromRequestId'` })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.aggregateType, 'leave-request'),
          eq(domainEvent.eventType, 'leave-request.split'),
          inArray(sql`${domainEvent.payload} ->> 'splitFromRequestId'`, frontier),
        ),
      );
    const next: string[] = [];
    for (const r of rows) {
      if (r.from == null || familyOf.has(r.id) || !familyOf.has(r.from)) continue;
      familyOf.set(r.id, familyOf.get(r.from)!);
      next.push(r.id);
    }
    frontier = next;
  }
  const out = new Map<string, string[]>(appIds.map((id) => [id, [] as string[]]));
  for (const [id, app] of familyOf) out.get(app)!.push(id);
  return out;
}

/**
 * r302 hand-fix (second verification, defect 1) — THE PER-DATE OUTCOME AS IT STANDS NOW, not as approved. The
 * approval event records only approved/rejected; a day later given back by Cancel Approved Leave read "Approved"
 * on every row of the application. A day is `cancelled` when its per-date row says so (the r302 split moves the
 * row onto the segment holding the date and marks it), or — for a split made before that, whose rows stayed on
 * the root — when a CANCELLED row of the application spans the date and no APPROVED row does.
 */
async function currentPerDateOutcomes(
  tx: Tx,
  ctx: SessionContext,
  outcomes: Map<string, OwnPerDateOutcome>,
): Promise<Map<string, OwnPerDateOutcome>> {
  if (outcomes.size === 0) return outcomes;
  const families = await applicationFamiliesTx(tx, ctx, [...outcomes.keys()]);
  const members = [...new Set([...families.values()].flat())];
  const [reqs, dates] = await Promise.all([
    tx
      .select({ id: leaveRequest.id, status: leaveRequest.status, startDate: leaveRequest.startDate, endDate: leaveRequest.endDate })
      .from(leaveRequest)
      .where(inArray(leaveRequest.id, members)),
    tx
      .select({ leaveRequestId: leaveRequestDate.leaveRequestId, leaveDate: leaveRequestDate.leaveDate, status: leaveRequestDate.status })
      .from(leaveRequestDate)
      .where(inArray(leaveRequestDate.leaveRequestId, members)),
  ]);
  const out = new Map<string, OwnPerDateOutcome>();
  for (const [app, o] of outcomes) {
    const fam = new Set(families.get(app) ?? [app]);
    const famReqs = reqs.filter((r) => fam.has(r.id));
    const dateStatus = new Map(dates.filter((d) => fam.has(d.leaveRequestId)).map((d) => [d.leaveDate, d.status as string]));
    const spannedBy = (status: string, d: string) => famReqs.some((r) => r.status === status && r.startDate <= d && d <= r.endDate);
    const cancelled = o.approved.filter(
      (d) => dateStatus.get(d) === 'cancelled' || (spannedBy('cancelled', d) && !spannedBy('approved', d)),
    );
    out.set(
      app,
      cancelled.length > 0
        ? { approved: o.approved.filter((d) => !cancelled.includes(d)), rejected: o.rejected, cancelled }
        : o,
    );
  }
  return out;
}

/** A `perDateOutcome` payload (core/leave.ts finalizePerDateIfComplete), shape-checked; null unless a date was rejected. */
function parsePerDateOutcome(v: unknown): OwnPerDateOutcome | null {
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== 'object') return null;
  const { approved, rejected } = o as { approved?: unknown; rejected?: unknown };
  const approvedDates = (Array.isArray(approved) ? approved : []).filter((d): d is string => typeof d === 'string' && ISO_DATE_RE.test(d)).sort();
  const rejectedDates = parseDateReasons(rejected, 'reason');
  return rejectedDates.length > 0 ? { approved: [...new Set(approvedDates)], rejected: rejectedDates } : null;
}

/** `[{ date, <reasonKey> }]` from an event payload, shape-checked, ascending by date. */
function parseDateReasons(v: unknown, reasonKey: 'reason' | 'rejectReason'): { date: string; reason: string | null }[] {
  if (!Array.isArray(v)) return [];
  return v
    .flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const { date } = e as { date?: unknown };
      const reason = (e as Record<string, unknown>)[reasonKey];
      if (typeof date !== 'string' || !ISO_DATE_RE.test(date)) return [];
      return [{ date, reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Approval trail with display names, for requests the CALLER OWNS. Any other id is simply absent.
 *
 * r302 fix pass — a row split off by a partial cancellation has no approval of its own (its steps and its
 * approval event stay on the request that was approved), so it reads that ROOT request's trail and per-date
 * outcome; see OwnApprovalTrail.lineage. The root belongs to the same employment, so 0472 answers for it; a row
 * 0472 does not answer for is absent whatever its lineage, so the walk widens nothing.
 */
export function ownLeaveApprovalTrails(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, OwnApprovalTrail>> {
  const ids = uuidList(leaveRequestIds);
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, OwnApprovalTrail>();
    if (ids.length === 0) return out;
    const roots = await splitRootsTx(tx, ctx, ids);
    const splitRootIds = [...new Set(ids.flatMap((id) => { const r = roots.get(id); return r != null && r !== id ? [r] : []; }))];
    const asked = uuidList([...ids, ...splitRootIds]);
    const res = (await tx.execute(
      sql`SELECT * FROM app.own_leave_request_approvals(${`{${asked.join(',')}}`}::uuid[]) ORDER BY leave_request_id, step_index NULLS FIRST`,
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
    const answered = new Map<string, Omit<OwnApprovalTrail, 'lineage' | 'submittedAt' | 'perDateOutcome'>>();
    for (const r of res) {
      if (r.step_index == null) {
        answered.set(r.leave_request_id, {
          leaveRequestId: r.leave_request_id,
          status: r.status,
          decidedByName: r.decided_by_name,
          decidedAt: toDate(r.decided_at),
          singleLevelApproverName: r.approver_name,
          steps: answered.get(r.leave_request_id)?.steps ?? [],
        });
      }
    }
    for (const r of res) {
      if (r.step_index == null) continue;
      answered.get(r.leave_request_id)?.steps.push({
        stepIndex: Number(r.step_index),
        kind: r.approver_kind ?? '',
        approverName: r.approver_name,
        alternateNames: r.alternate_names ?? [],
        status: r.status,
        decidedByName: r.decided_by_name,
        decidedAt: toDate(r.decided_at),
      });
    }
    if (answered.size === 0) return out;

    // The application each answered row belongs to: itself, or its (answered) root.
    const applicationOf = new Map<string, string>();
    for (const id of ids) {
      if (!answered.has(id)) continue;
      const root = roots.get(id);
      if (root === id) applicationOf.set(id, id);
      else if (root != null && answered.has(root)) applicationOf.set(id, root);
    }
    const applicationIds = [...new Set(applicationOf.values())];
    const outcomes = new Map<string, OwnPerDateOutcome>();
    if (applicationIds.length > 0) {
      const events = await tx
        .select({ id: domainEvent.aggregateId, outcome: sql<unknown>`${domainEvent.payload} -> 'perDateOutcome'` })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.tenantId, ctx.tenantId),
            eq(domainEvent.aggregateType, 'leave-request'),
            eq(domainEvent.eventType, 'leave-request.approved'),
            inArray(domainEvent.aggregateId, applicationIds),
            sql`${domainEvent.payload} -> 'perDateOutcome' IS NOT NULL`,
          ),
        )
        .orderBy(asc(domainEvent.sequence));
      for (const e of events) {
        const parsed = parsePerDateOutcome(e.outcome);
        if (parsed) outcomes.set(e.id, parsed); // newest wins
      }
      for (const [app, o] of await currentPerDateOutcomes(tx, ctx, outcomes)) outcomes.set(app, o);
    }
    const submitted = new Map<string, Date>();
    if (splitRootIds.length > 0) {
      const rootRows = await tx
        .select({ id: leaveRequest.id, createdAt: leaveRequest.createdAt })
        .from(leaveRequest)
        .where(inArray(leaveRequest.id, splitRootIds));
      for (const r of rootRows) submitted.set(r.id, r.createdAt);
    }

    for (const id of ids) {
      const self = answered.get(id);
      if (!self) continue; // not the caller's own request
      const app = applicationOf.get(id);
      if (app === id) {
        out.set(id, { ...self, lineage: 'own', submittedAt: null, perDateOutcome: outcomes.get(id) ?? null });
      } else if (app != null) {
        const root = answered.get(app)!;
        out.set(id, {
          ...root,
          leaveRequestId: id,
          status: self.status,
          lineage: 'root',
          submittedAt: submitted.get(app) ?? null,
          perDateOutcome: outcomes.get(app) ?? null,
        });
      } else {
        out.set(id, { ...self, singleLevelApproverName: null, steps: [], lineage: 'unrecorded', submittedAt: null, perDateOutcome: null });
      }
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

/** A rejection as the employee reads it: the approver's words for a whole-request rejection, or — for a per-date
 *  one — each rejected date with its own reason (and no whole-request text). */
export type OwnRejection = { reason: string | null; dates: { date: string; reason: string | null }[] };

/**
 * The reject reason, off the `leave-request.rejected` event (the only place it is stored). Read under RLS —
 * domain_event is subject-scoped (0037). Newest event per request wins.
 *
 * r302 fix pass (verifier defect 7) — a per-date rejection's event carries `rejectReason` as an audit string
 * built from ISO dates ("2026-10-05: Short staffed; …"), which the View panel printed verbatim. The event also
 * carries `perDate` — each date with its own reason — and that is what is returned, so the screen formats the
 * dates in the viewer's locale; the joined audit string is never returned as a reason.
 */
export function ownLeaveRejections(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, OwnRejection>> {
  const ids = uuidList(leaveRequestIds);
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, OwnRejection>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({
        aggregateId: domainEvent.aggregateId,
        reason: sql<string | null>`${domainEvent.payload} ->> 'rejectReason'`,
        perDate: sql<unknown>`${domainEvent.payload} -> 'perDate'`,
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
      const perDate = typeof r.perDate === 'string' ? (() => { try { return JSON.parse(r.perDate as string) as unknown; } catch { return null; } })() : r.perDate;
      const dates = parseDateReasons(perDate, 'rejectReason');
      const reason = dates.length > 0 ? null : r.reason?.trim() || null;
      if (reason || dates.length > 0) out.set(r.aggregateId, { reason, dates });
    }
    return out;
  });
}

/** The whole-request reject reasons only (a per-date rejection has none — see ownLeaveRejections). */
export async function ownLeaveRejectionReasons(
  ctx: SessionContext,
  leaveRequestIds: readonly string[],
): Promise<Map<string, string>> {
  const all = await ownLeaveRejections(ctx, leaveRequestIds);
  return new Map([...all].flatMap(([id, r]) => (r.reason ? [[id, r.reason] as const] : [])));
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
