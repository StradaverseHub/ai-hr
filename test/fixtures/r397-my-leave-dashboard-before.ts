/**
 * r397 TEST-ONLY FIXTURE — core/my-leave.ts's `myLeaveDashboard` (and the private helpers it calls) EXACTLY as
 * they were at b6b2abb8, before r397 batched its per-leave-type reads. Lines 144–407 of that file are copied
 * below byte for byte (`git show b6b2abb8:core/my-leave.ts | sed -n 144,407p`); only the imports above them are
 * written for this location, and they import the SAME functions the original imported — the per-type
 * `leaveEntitlementBreakdown` and `leaveTypeApplySummary`, one transaction per card, as the page paid for them.
 *
 * Renamed on export only (`myLeaveDashboardBefore`, by the alias at the bottom) so a test can hold old and new
 * side by side. Never import this from app code.
 */
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { company, employment, leaveLedger, leaveType } from '../../db/schema';
import {
  earnedCycleStart,
  isEarnedAccrualType,
  leaveCycleEnd,
  leaveTypeApplySummary,
  resolveLeaveYearCycle,
} from '../../packs/leave/service';
import { leaveBalances, leaveEntitlementBreakdown } from '../../core/read';
import { balanceStoryTypeId } from '../../lib/shared-leave-balance';
import { PRIMARY_CODES, SECONDARY_GROUPS, resolveSecondaryGroup } from '../../lib/leave-groups';
import type { BalanceIncludesLater, MyLeaveCard } from '../../core/my-leave';

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

export { myLeaveDashboard as myLeaveDashboardBefore };
