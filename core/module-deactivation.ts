/**
 * ADR-0077 slice 5 — what stands in the way of turning a module OFF.
 *
 * DEACTIVATION IS TWO PHASE, and the phases exist for a specific reason: switching a module off while
 * work is in flight strands that work somewhere nobody looks again. An open review cycle whose module
 * disappears cannot be closed; a draft payroll batch cannot be processed; banked TOIL a customer earned
 * cannot be re-tuned. So the operator is shown what is in flight and records a DISPOSITION — what should
 * happen to it — and only then does the runner act.
 *
 * WHY ENUMERATE RATHER THAN REFUSE OUTRIGHT. A customer who has stopped paying for a module is entitled
 * to stop paying for it; blocking deactivation forever because one review cycle is open would make the
 * product hold them hostage. The pre-check exists so the decision is INFORMED and RECORDED, not so it is
 * prevented.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not stop obligations already incurred. TOIL's
 * convert-to-pay floors and promised comp enactments keep executing regardless of entitlement state
 * (D4) — `core/toil.ts` already implements exactly that, and its comment at the top of
 * `setToilPolicy` is the reasoning: winding down needs the ledger and the sweeps; it does not need to
 * re-tune FUTURE accrual, which is what the entitlement governs. A blocker here is a thing to decide
 * about, never a thing this module quietly finishes on the customer's behalf.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { company, employment, payrollBatch, performanceReview, reviewCycle, toilAccrual } from '../db/schema';

/** One kind of in-flight work that deactivating this module would strand. */
export type DeactivationBlocker = {
  /** Stable identifier the operator's disposition is keyed by. */
  kind: 'open_review_cycle' | 'unenacted_recommendation' | 'active_toil_accrual' | 'draft_payroll_batch';
  count: number;
  /** What the operator is actually deciding about, in their terms. */
  detail: string;
};

export type DeactivationScope = {
  tx: Tx;
  tenantId: string;
  moduleCode: string;
  /** Narrow the check to one company when the grant being revoked is company-scoped. */
  companyId: string | null;
};

/**
 * Which blockers are worth checking for a given module. Checking everything for every module would
 * report an open review cycle as a reason to think twice about turning off TOIL, which is noise — and
 * noise in a confirmation screen is how operators learn to click through them.
 */
const BLOCKERS_BY_MODULE: Readonly<Record<string, DeactivationBlocker['kind'][]>> = {
  toil: ['active_toil_accrual'],
  performance: ['open_review_cycle', 'unenacted_recommendation'],
  payroll: ['draft_payroll_batch'],
  multi_cycle_payroll: ['draft_payroll_batch'],
  typed_pay_components: ['draft_payroll_batch'],
};

const companiesIn = async (s: DeactivationScope): Promise<string[]> => {
  if (s.companyId) return [s.companyId];
  const rows = await s.tx.select({ id: company.id }).from(company).where(eq(company.tenantId, s.tenantId));
  return rows.map((r) => r.id);
};

const countOf = (rows: { n: number | string }[]): number => Number(rows[0]?.n ?? 0);

/**
 * Everything deactivating this module would leave stranded. Empty means the operator may proceed with
 * no disposition; non-empty means the runner requires one.
 */
export async function deactivationBlockers(s: DeactivationScope): Promise<DeactivationBlocker[]> {
  const kinds = BLOCKERS_BY_MODULE[s.moduleCode] ?? [];
  if (kinds.length === 0) return [];
  const companyIds = await companiesIn(s);
  if (companyIds.length === 0) return [];

  const out: DeactivationBlocker[] = [];

  if (kinds.includes('open_review_cycle')) {
    const rows = await s.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reviewCycle)
      .where(
        and(
          eq(reviewCycle.tenantId, s.tenantId),
          inArray(reviewCycle.companyId, companyIds),
          // 'draft' is not in flight — nobody is waiting on it. Open and calibration are.
          inArray(reviewCycle.status, ['open', 'calibration']),
        ),
      );
    const n = countOf(rows);
    if (n > 0) {
      out.push({
        kind: 'open_review_cycle',
        count: n,
        detail: `${n} review cycle(s) are open or in calibration and could not be closed once this module is off`,
      });
    }
  }

  if (kinds.includes('unenacted_recommendation')) {
    const rows = await s.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .where(
        and(
          eq(reviewCycle.tenantId, s.tenantId),
          inArray(reviewCycle.companyId, companyIds),
          isNull(performanceReview.enactedAt),
          // A recommendation only counts if there is something to enact.
          or(isNotNull(performanceReview.recommendedMeritPct), isNotNull(performanceReview.recommendedBonus)),
        ),
      );
    const n = countOf(rows);
    if (n > 0) {
      out.push({
        kind: 'unenacted_recommendation',
        count: n,
        detail: `${n} pay recommendation(s) have been made and not yet enacted — a promise to an employee`,
      });
    }
  }

  if (kinds.includes('active_toil_accrual')) {
    const rows = await s.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(toilAccrual)
      .innerJoin(employment, eq(employment.id, toilAccrual.employmentId))
      .where(
        and(
          eq(toilAccrual.tenantId, s.tenantId),
          inArray(employment.companyId, companyIds),
          eq(toilAccrual.status, 'active'),
        ),
      );
    const n = countOf(rows);
    if (n > 0) {
      out.push({
        kind: 'active_toil_accrual',
        count: n,
        detail: `${n} banked TOIL credit(s) are still active — earned time the employee has not taken or been paid for`,
      });
    }
  }

  if (kinds.includes('draft_payroll_batch')) {
    const rows = await s.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollBatch)
      .where(
        and(
          eq(payrollBatch.tenantId, s.tenantId),
          inArray(payrollBatch.companyId, companyIds),
          eq(payrollBatch.status, 'draft'),
        ),
      );
    const n = countOf(rows);
    if (n > 0) {
      out.push({
        kind: 'draft_payroll_batch',
        count: n,
        detail: `${n} payroll batch(es) are still in draft and would become unprocessable`,
      });
    }
  }

  return out;
}

/** Every blocker the operator has to have answered, given the disposition they recorded. */
export function unansweredBlockers(
  blockers: DeactivationBlocker[],
  disposition: Record<string, string> | null,
): DeactivationBlocker[] {
  if (!disposition) return blockers;
  // A blank answer is not an answer: an empty string is what an unfilled form field sends.
  return blockers.filter((b) => !(disposition[b.kind] ?? '').trim());
}
